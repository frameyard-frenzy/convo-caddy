import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MacosKeychainSecretStore,
  runSecurityCommand,
  type SecurityCommandRequest,
  type SecurityProcessFactory,
} from "../../src/server/desktop/macos-keychain-secret-store.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: () => {
    throw new Error("Real Keychain execution forbidden");
  },
}));
const native =
  await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
const root = mkdtempSync(path.join(tmpdir(), "caddy-libc-runner-"));
const helper = path.join(root, "prompt-fixture");
const generation = "00000000-0000-4000-8000-000000000001";
const request: SecurityCommandRequest = {
  executable: "/usr/bin/security",
  args: ["add-generic-password", "-w"],
  stdin: "synthetic-only\nsynthetic-only\n",
  timeoutMs: 5000,
  maxOutputBytes: 32768,
};

// Only this test-owned executable (or deliberately missing sibling) may launch.
function factory(
  mode?: "wait" | "missing",
  observe?: (child: ChildProcessWithoutNullStreams) => void,
): SecurityProcessFactory {
  return (executable, args, options) => {
    expect(executable).toBe("/usr/bin/security");
    expect(args.join(" ")).not.toContain("synthetic-only");
    expect(options).toEqual({
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = native.spawn(
      mode === "missing" ? path.join(root, "absent") : helper,
      mode === "wait" ? ["wait"] : [],
      options,
    );
    observe?.(child);
    return child;
  };
}

beforeAll(() => {
  const compiled = native.spawnSync(
    "cc",
    ["tests/fixtures/keychain/prompt.c", "-o", helper],
    { encoding: "utf8" },
  );
  expect(compiled.stderr).toBe("");
  expect(compiled.status).toBe(0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("production runner with isolated libc process", () => {
  it("handles OS spawn failure and maps it safely through the store", async () => {
    const result = await runSecurityCommand(request, factory("missing"));
    expect(result).toMatchObject({ exitCode: null, timedOut: false });
    const store = new MacosKeychainSecretStore({
      runner: (input) => runSecurityCommand(input, factory("missing")),
    });
    await expect(
      store.write("hermes-api-key", generation, "synthetic-only"),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("maps a synchronous spawn exception without exposing its message", async () => {
    const store = new MacosKeychainSecretStore({
      runner: (input) =>
        runSecurityCommand(input, () => {
          throw new Error("synthetic-private-spawn-detail");
        }),
    });
    await expect(
      store.write("hermes-api-key", generation, "synthetic-only"),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "The macOS Keychain command could not run.",
    });
  });
  it("kills a timed-out helper and settles once despite its later close", async () => {
    let closed!: Promise<unknown[]>;
    let child!: ChildProcessWithoutNullStreams;
    let settlements = 0;
    const result = await runSecurityCommand(
      { ...request, timeoutMs: 100 },
      factory("wait", (value) => {
        child = value;
        closed = once(value, "close");
      }),
    ).then((value) => {
      settlements++;
      return value;
    });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(child.killed).toBe(true);
    await expect(closed).resolves.toEqual([null, "SIGTERM"]);
    expect(settlements).toBe(1);
    expect(result.timedOut).toBe(true);
  });
  it("feeds both getpass prompts through stdin in a session without a controlling terminal", async () => {
    const run = factory();
    const oneLine = await runSecurityCommand(
      { ...request, stdin: "synthetic-only\n" },
      run,
    );
    expect(oneLine.exitCode).toBe(24);
    const result = await runSecurityCommand(request, run);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      "matched; session leader; no controlling terminal\n",
    );
    expect(result.stderr.toString()).not.toContain("synthetic-only");
    const store = new MacosKeychainSecretStore({
      runner: (input) => runSecurityCommand(input, run),
    });
    await expect(
      store.write("hermes-api-key", generation, "synthetic-only"),
    ).resolves.toBeUndefined();
  });
  it.each([
    "",
    "first\nsecond",
    "first\rsecond",
    "first\r\nsecond",
    "first\0second",
  ])("rejects unsafe framing before spawning (%j)", async (secret) => {
    const run = vi.fn(factory());
    const store = new MacosKeychainSecretStore({
      runner: (input) => runSecurityCommand(input, run),
    });
    await expect(
      store.write("hermes-api-key", generation, secret),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(run).not.toHaveBeenCalled();
  });
});
