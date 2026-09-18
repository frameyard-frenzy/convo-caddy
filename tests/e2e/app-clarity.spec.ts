import { test, expect } from "@playwright/test";
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
const evidence =
  process.env.CONVO_CADDY_CLARITY_ARTIFACTS ?? "test-results/clarity";
for (const width of [1280, 900, 390])
  test(`app clarity at ${width}`, async ({ page }) => {
    const root = mkdtempSync(path.join(tmpdir(), "clarity-browser-"));
    const workspace = path.join(root, "Synthetic Workspace");
    mkdirSync(workspace);
    initializeUserWorkspace(workspace);
    const write = (name: string) =>
      writeFileSync(
        path.join(workspace, "prep/current", name),
        JSON.stringify({
          schemaVersion: 1,
          title: "Synthetic decision interview",
          plannedDurationMinutes: 25,
          topics: [
            { tier: "must", text: "Which evidence changed the decision?" },
            { tier: "more", text: "Who helped reconstruct the sequence?" },
          ],
        }),
      );
    write("practice.json");
    const service = new SessionService({
      topics: [],
      transcript: [
        {
          id: "turn-1",
          speakerId: "participant",
          speakerLabel: "Synthetic participant",
          text: "The second inspection changed our decision.",
          startedAtMs: 0,
          endedAtMs: 1,
          receivedAt: "2026-09-12T00:00:00.000Z",
          final: true,
        },
      ],
      provider: new FakeMartyProvider(),
      repository: new FileSessionRepository(path.join(root, "private")),
      userWorkspaceRoot: workspace,
    });
    const app = createApp({
      service,
      exposeTestControls: true,
      readiness: () => ({
        state: "ready",
        components: {
          configuration: "ready",
          workspace: "ready",
          appServer: "ready",
          webhookServer: "ready",
          ngrok: "ready",
          hermesTunnel: "local",
          hermes: "ready",
          capture: "ready",
        },
        diagnostics: [],
      }),
    });
    app.use(express.static(path.resolve("dist/client")));
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No address");
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${address.port}`);
      await expect(
        page.getByRole("heading", { name: "Workspace and prep" }),
      ).toBeVisible();
      const gaps = await page
        .locator(".app-shell > *")
        .evaluateAll((nodes) =>
          nodes
            .slice(1)
            .map(
              (node, i) =>
                node.getBoundingClientRect().top -
                (nodes[i]?.getBoundingClientRect().bottom ?? 0),
            ),
        );
      for (const gap of gaps) expect(gap).toBeCloseTo(16, 0);
      expect(
        await page
          .locator("header")
          .getByRole("button", { name: "Show transcript" })
          .count(),
      ).toBe(0);
      const toggle = page.getByRole("button", {
        name: "Show transcript",
        exact: true,
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await page.getByRole("button", { name: "Step transcript" }).click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("#transcript-content")).toBeHidden();
      await toggle.click();
      await expect(
        page.getByRole("button", { name: "Hide transcript" }),
      ).toBeFocused();
      await expect(page.locator("#transcript-content")).toContainText(
        "second inspection",
      );
      await page.getByRole("button", { name: "Hide transcript" }).click();
      await expect(
        page.getByRole("button", { name: "Refresh", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByLabel("New prep filename")).toHaveCount(0);
      const before = service.getSnapshot();
      write("fresh.json");
      await page
        .getByRole("button", { name: "Choose prep…", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Choose prep" });
      await expect(dialog).toContainText("fresh.json");
      await page.screenshot({
        path: `${evidence}/after-chooser-${width}.png`,
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(service.getSnapshot()).toEqual(before);
      await expect(
        page.getByRole("button", { name: "Choose prep…", exact: true }),
      ).toBeFocused();
      await page
        .getByRole("button", { name: "Choose prep…", exact: true })
        .click();
      await dialog.getByRole("button", { name: /fresh.json/ }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".workspace-prep")).toContainText("25 minutes");
      await expect(page.locator(".workspace-prep")).toContainText(
        "Synthetic decision interview",
      );
      await expect(
        page.getByLabel("Which evidence changed the decision?", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Who helped reconstruct the sequence?", {
          exact: true,
        }),
      ).toBeVisible();
      const selectedState = service.getSnapshot();
      writeFileSync(path.join(workspace, "prep/current/bad.json"), "{");
      await page
        .getByRole("button", { name: "Choose prep…", exact: true })
        .click();
      await expect(dialog).toContainText("bad.json");
      rmSync(path.join(workspace, "prep/current/fresh.json"));
      await dialog.getByRole("button", { name: /fresh.json/ }).click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      expect(service.getSnapshot()).toEqual(selectedState);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Choose prep…", exact: true }),
      ).toBeFocused();
      write("fresh.json");
      await page.screenshot({
        path: `${evidence}/after-app-${width}.png`,
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await page.goto("about:blank");
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
