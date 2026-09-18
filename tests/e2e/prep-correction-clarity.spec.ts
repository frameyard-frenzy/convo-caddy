import { test as base, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createApp } from "../../src/server/app.js";
import { SessionService } from "../../src/server/session-service.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import { initializeUserWorkspace } from "../../src/server/workspace/user-workspace.js";

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const test = base.extend<{
  nativePrep: boolean;
  prep: { service: SessionService; polls: () => number };
}>({
  nativePrep: [false, { option: true }],
  prep: async ({ page, nativePrep }, use) => {
    const root = mkdtempSync(path.join(tmpdir(), "clarity-correction-"));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    initializeUserWorkspace(workspace);
    for (let i = 0; i < 60; i++) {
      const name = `practice-${String(i).padStart(2, "0")}.json`;
      writeFileSync(
        path.join(workspace, "prep/current", name),
        JSON.stringify({
          schemaVersion: 1,
          title: name,
          plannedDurationMinutes: 25,
          topics: [{ tier: "must", text: "What changed?" }],
        }),
      );
    }
    const service = new SessionService({
      topics: [],
      transcript: [],
      provider: new FakeMartyProvider(),
      repository: new FileSessionRepository(path.join(root, "private")),
      userWorkspaceRoot: workspace,
      initialCaptureMode: "live_ready",
      captureProvider: {
        region: "us-west-2",
        createBot: async () => ({ botId: "synthetic-bot" }),
        stopRecordingNotice: async () => {},
      },
    });
    let polls = 0;
    const app = createApp({
      service,
      ...(nativePrep
        ? {
            choosePrep: async (directory: string) =>
              path.join(directory, "current", "practice-00.json"),
          }
        : {}),
      readiness: () => {
        polls++;
        return null;
      },
    });
    app.use(
      express.static(
        path.resolve(process.env.CADDY_POLISH_CLIENT_DIR ?? "dist/client"),
      ),
    );
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No address");
    try {
      await page.goto(`http://127.0.0.1:${address.port}`);
      await expect(page.locator("#choose-prep")).toBeEnabled();
      await use({ service, polls: () => polls });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.goto("about:blank");
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
});

for (const nativePrep of [true, false])
  test.describe(nativePrep ? "native" : "browser", () => {
    test.use({ nativePrep });
    test("delayed prep HTTP preserves newer SSE topic and capture state", async ({
      page,
      prep,
    }) => {
      const held = gate();
      const selected = gate();
      const endpoint = nativePrep ? "choose" : "select";
      await page.route(`**/api/workspace/prep/${endpoint}`, async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        selected.resolve();
        await held.promise;
        await route.fulfill({ response });
      });
      try {
        await page.locator("#choose-prep").click();
        if (!nativePrep)
          await page
            .getByRole("dialog")
            .getByRole("button", { name: /practice-00.json/ })
            .click();
        await selected.promise;
        const topic = page.getByLabel("What changed?", { exact: true });
        await expect(topic).toBeAttached(); // Selection SSE arrives while HTTP is held.
        const capture = await prep.service.startRecallCapture({
          meetingUrl: "https://teams.live.com/meet/123456789",
        });
        expect(capture.ok).toBe(true);
        await expect(
          page.getByText("Awaiting lobby admission", { exact: true }),
        ).toBeVisible();
        const id = prep.service.getSnapshot().topics[0]?.id;
        if (!id) throw Error("Selection did not populate topics");
        if (nativePrep) await topic.check();
        else expect(prep.service.setTopicChecked(id, true)).toBe(true);
        await expect(topic).toBeChecked();
        held.resolve();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        // Readiness renders again after the HTTP response: stale state cannot hide behind a DOM check.
        const polls = prep.polls();
        await expect.poll(prep.polls).toBeGreaterThan(polls + 1);
        await expect(topic).toBeChecked();
        await expect(page.locator("#choose-prep")).toBeDisabled();
        await expect(
          page.getByText("Awaiting lobby admission", { exact: true }),
        ).toBeVisible();
        expect(prep.service.getSnapshot().topics[0]?.checked).toBe(true);
      } finally {
        held.resolve();
      }
    });
  });

// Resolve the connected chooser and sample all continuity state in one browser
// task. Locator.evaluate first obtains a handle; a poll may detach it before
// its callback runs, making scrollTop report zero for an invisible old node.
function chooserSnapshot() {
  const dialog = document.querySelector("dialog.prep-chooser");
  const choice = document.getElementById("choose-practice-50.json");
  if (!dialog || !choice || !dialog.contains(choice))
    throw Error("No connected chooser and expected choice");
  const box = choice.getBoundingClientRect();
  const parent = dialog.getBoundingClientRect();
  return {
    top: dialog.scrollTop,
    max: dialog.scrollHeight - dialog.clientHeight,
    focused: document.activeElement === choice,
    visible: box.top >= parent.top && box.bottom <= parent.bottom,
  };
}

for (const width of [1280, 390])
  test(`overflowing chooser retains scroll and focused choice through polls at ${width}`, async ({
    page,
    prep,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.locator("#choose-prep").click();
    const dialog = page.getByRole("dialog");
    const late = dialog.getByRole("button", { name: /practice-50.json/ });
    await late.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(late).toBeFocused();
    const before = await page.evaluate(chooserSnapshot);
    expect(before.max).toBeGreaterThan(500);
    expect(before.top).toBeGreaterThan(500);
    const polls = prep.polls();
    await expect.poll(prep.polls).toBeGreaterThan(polls + 2);
    const after = await page.evaluate(chooserSnapshot);
    expect(after.focused).toBe(true);
    expect(after.top).toBeCloseTo(before.top, 0);
    expect(after.visible).toBe(true);
    await page.screenshot({
      path: `${process.env.CONVO_CADDY_CLARITY_ARTIFACTS ?? "test-results/clarity"}/correction-overflow-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".workspace-prep")).toContainText(
      "practice-50.json",
    );
  });

// Force the same boundary as the preserved trace: the readiness response lands
// after a dialog handle is acquired but before its geometry is sampled.
test("chooser measurement across a forced poll replacement", async ({
  page,
  prep,
}) => {
  void prep;
  await page.locator("#choose-prep").click();
  const late = page.getByRole("button", { name: /practice-50.json/ });
  await late.focus();
  const held = gate();
  const arrived = gate();
  await page.route("**/api/runtime/readiness", async (route) => {
    const response = await route.fetch();
    arrived.resolve();
    await held.promise;
    await route.fulfill({ response });
  });
  try {
    await arrived.promise;
    const previous = await page.getByRole("dialog").elementHandle();
    if (!previous) throw Error("Missing chooser");
    const before = await previous.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(500);
    held.resolve();
    await page.waitForFunction((el) => !el.isConnected, previous);
    // The discarded node reproduces the false zero in the original trace.
    expect(await previous.evaluate((el) => el.scrollTop)).toBe(0);
    // The visible chooser must preserve scroll AND focus in the same sample.
    const current = await page.evaluate(chooserSnapshot);
    expect(current.top).toBeCloseTo(before, 0);
    expect(current.focused).toBe(true);
    expect(current.visible).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".workspace-prep")).toContainText(
      "practice-50.json",
    );
  } finally {
    held.resolve();
  }
});

test.describe("original prep display identity", () => {
  test.use({ nativePrep: true });
  test("uses the selected original label across reload without exposing the copy UUID", async ({
    page,
    prep,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#choose-prep").click();
    await expect(
      page.getByText("practice-00.json — selected", { exact: true }),
    ).toBeVisible();
    const copy = prep.service.getWorkspaceOverview()?.selectedPrep;
    expect(copy).toMatch(/^practice-00-[a-f0-9-]+\.json$/);
    await page.reload();
    await expect(
      page.getByText("practice-00.json — selected", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`${copy} — selected`, { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("#save-content")).toHaveText("Save");
    await page.route("**/api/workspace/prep/choose", (route) =>
      route.fulfill({
        json: {
          kind: "browser",
          workspace: prep.service.getWorkspaceOverview(),
        },
      }),
    );
    await page.locator("#choose-prep").click();
    await expect(page.locator(`[id="choose-${copy}"]`)).toHaveText(
      "practice-00.json — practice-00.json",
    );
    await page.keyboard.press("Escape");
    await page.unroute("**/api/workspace/prep/choose");
    if (process.env.CADDY_POLISH_SCREENSHOTS) {
      const dir = process.env.CADDY_POLISH_SCREENSHOTS;
      await page.screenshot({
        path: path.join(dir, "current-normal.png"),
        fullPage: true,
      });
      await page.locator("#choose-prep").focus();
      await page.screenshot({
        path: path.join(dir, "current-focused.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 640, height: 1000 });
      await page.screenshot({
        path: path.join(dir, "current-narrow.png"),
        fullPage: true,
      });
    }
  });
});

test.describe("header comparison evidence", () => {
  test.use({ nativePrep: true });
  test("keeps the header stable while showing actionable connection diagnostics", async ({
    page,
    prep,
  }) => {
    void prep;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#choose-prep").click();
    await expect(page.locator(".selected-prep")).toBeVisible();
    const header = await page.locator(".topbar").boundingBox();
    const prefix = process.env.CADDY_POLISH_CLIENT_DIR
      ? "baseline-3b806a1"
      : "current";
    const dir = process.env.CADDY_POLISH_SCREENSHOTS;
    if (dir)
      await page.screenshot({
        path: path.join(dir, `${prefix}-ready.png`),
        fullPage: true,
      });
    await page.route("**/api/runtime/readiness", (route) =>
      route.fulfill({
        json: {
          readiness: {
            state: "ready_without_marty",
            components: {
              configuration: "ready",
              workspace: "ready",
              appServer: "ready",
              webhookServer: "ready",
              ngrok: "ready",
              hermesTunnel: "failed",
              hermes: "unavailable",
              capture: "ready",
            },
            diagnostics: [
              {
                component: "hermesTunnel",
                code: "ssh_start_failed",
                severity: "warning",
                message: "Synthetic unavailable SSH forward.",
                action: "Check the synthetic connection diagnostic.",
              },
            ],
          },
        },
      }),
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Retry connection", exact: true }),
    ).toBeVisible();
    expect(await page.locator(".topbar").boundingBox()).toEqual(header);
    if (dir)
      await page.screenshot({
        path: path.join(dir, `${prefix}-warning.png`),
        fullPage: true,
      });
  });
});
