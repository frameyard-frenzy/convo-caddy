import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { SessionState } from "../../src/domain/types.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("recovers the exact browser session after a real server restart", async ({
  page,
}) => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "convo-caddy-process-restart-"),
  );
  const dataRoot = path.join(temporaryDirectory, "sessions");
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: StartedServer | undefined;

  try {
    server = startServer(port, dataRoot);
    await waitForServer(baseUrl, server);
    await page.goto(baseUrl);
    await expect(
      page.getByRole("heading", { level: 3, name: "Saved interviews" }),
    ).toBeVisible();
    await expect(page.getByTestId("finalization-status")).toContainText(
      "synthetic developer session is saved locally",
    );

    await page.getByRole("button", { name: "Step transcript" }).click();
    const preparedQuestion = page.getByLabel(
      "Tell me about the last time this happened.",
      { exact: true },
    );
    await preparedQuestion.check();
    await page
      .getByLabel("Command or question")
      .fill("/note Restart-safe note.");
    await page.getByRole("button", { name: "Submit" }).click();

    const originalMutation = await page.request.post(`${baseUrl}/api/input`, {
      data: {
        input: "What happened in the interview?",
        mutationId: "restart-safe-marty-call",
      },
    });
    expect(originalMutation.ok()).toBe(true);
    const beforeRestart = await getState(baseUrl);

    await stopServer(server);
    server = startServer(port, dataRoot);
    await waitForServer(baseUrl, server);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { level: 1, name: "Convo Caddy" }),
    ).toBeVisible();
    await expect(preparedQuestion).toBeChecked();
    await expect(
      page.getByText("Restart-safe note.", { exact: true }),
    ).toBeVisible();
    expect(await getState(baseUrl)).toEqual(beforeRestart);

    const duplicateMutation = await page.request.post(`${baseUrl}/api/input`, {
      data: {
        input: "What happened in the interview?",
        mutationId: "restart-safe-marty-call",
      },
    });
    expect(duplicateMutation.ok()).toBe(true);
    expect((await duplicateMutation.json()).state).toEqual(beforeRestart);
    const envelope = await getEnvelope(baseUrl);
    expect(envelope.state.chat).toHaveLength(1);
    expect(envelope.diagnostics.providerCallCount).toBe(0);
  } finally {
    if (server) {
      await stopServer(server);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

type StartedServer = {
  child: ChildProcess;
  logs: string[];
};

function startServer(port: number, dataRoot: string): StartedServer {
  const child = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/server/main.ts"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONVO_CADDY_DATA_DIR: dataRoot,
        CONVO_CADDY_HOST: "127.0.0.1",
        CONVO_CADDY_PORT: `${port}`,
        CONVO_CADDY_TEST_MODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logs: string[] = [];
  child.stdout?.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

async function waitForServer(
  baseUrl: string,
  server: StartedServer,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `Convo Caddy exited before startup:\n${server.logs.join("")}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The TCP listener is not ready yet.
    }
    await delay(100);
  }
  throw new Error(`Convo Caddy did not start:\n${server.logs.join("")}`);
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.child.exitCode !== null) {
    return;
  }
  server.child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) =>
    server.child.once("exit", () => resolve()),
  );
  const timedOut = delay(5_000).then(() => false);
  if ((await Promise.race([exited.then(() => true), timedOut])) === false) {
    server.child.kill("SIGKILL");
    await exited;
  }
}

async function getState(baseUrl: string): Promise<SessionState> {
  return (await getEnvelope(baseUrl)).state;
}

async function getEnvelope(baseUrl: string): Promise<{
  state: SessionState;
  diagnostics: { providerCallCount: number };
}> {
  const response = await fetch(`${baseUrl}/api/session`);
  expect(response.ok).toBe(true);
  return response.json();
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Expected an available TCP port."));
        return;
      }
      server.close((error) =>
        error === undefined ? resolve(address.port) : reject(error),
      );
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
