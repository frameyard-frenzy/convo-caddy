import { expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { test, gate } from "../helpers/setup-browser-fixture.js";
import { createApp } from "../../src/server/app.js";
import { SessionService } from "../../src/server/session-service.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import { createSessionState } from "../helpers/session-state.js";
import {
  initializeUserWorkspace,
  publishFinishedConversation,
} from "../../src/server/workspace/user-workspace.js";
const evidence =
  process.env.CONVO_CADDY_CLARITY_ARTIFACTS ?? "test-results/clarity";
async function focusEvidence(page: Page, selector: string, name: string) {
  const control = page.locator(selector).first();
  // The live surface replaces controls during readiness polling. Scroll the
  // current node synchronously, then resolve the locator again for focus;
  // waiting for a captured node to stabilize races that legitimate redraw.
  await control.evaluate((node) =>
    node.scrollIntoView({ behavior: "instant", block: "center" }),
  );
  await control.focus();
  await page.keyboard.press("Shift");
  await expect(control).toBeFocused();
  const shape = await control.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      offset: style.outlineOffset,
      width: style.outlineWidth,
      style: style.outlineStyle,
      shadow: style.boxShadow,
      focused: node.matches(":focus-visible"),
    };
  });
  expect(shape.focused).toBe(true);
  expect(shape.offset).toBe("0px");
  expect(shape.width).toBe("3px");
  expect(shape.style).toBe("solid");
  // Inspect the actual control plus its outside pixels, not a wrapper crop.
  const box = await control.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw Error("Focused control has no geometry");
  await page.screenshot({
    path: `${evidence}/${name}.png`,
    clip: {
      x: Math.max(0, box.x - 5),
      y: Math.max(0, box.y - 5),
      width: Math.min(box.width + 10, viewport.width - Math.max(0, box.x - 5)),
      height: box.height + 10,
    },
  });
}
test.use({ readySetup: true });
for (const width of [1280, 900, 390]) {
  test(`matched cards and attached focus across routes at ${width}`, async ({
    page,
    setup,
    browser,
  }) => {
    void setup;
    const root = mkdtempSync(path.join(tmpdir(), "caddy-acceptance-browser-"));
    initializeUserWorkspace(root);
    writeFileSync(
      path.join(root, "prep/current/interview.md"),
      "# Synthetic decision interview\nDuration: 25 minutes\n\n## Must\n- Which evidence changed the decision?\n\n## More Avenues\n- Who helped reconstruct the sequence?\n",
    );
    publishFinishedConversation({
      root,
      state: createSessionState({
        sessionId: "11111111-2222-4333-8444-555555555555",
        startedAt: "2026-09-12T00:00:00.000Z",
      }),
      prepSourceFile: "past.md",
      prepSourceBytes:
        "# Earlier synthetic interview\n## Must\n- What happened?\n",
      completedAt: "2026-09-12T01:00:00.000Z",
    });
    const service = new SessionService({
      topics: [],
      transcript: [],
      provider: new FakeMartyProvider(),
      repository: new FileSessionRepository(path.join(root, "private")),
      userWorkspaceRoot: root,
    });
    const app = createApp({ service });
    app.use(express.static(path.resolve("dist/client")));
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("No fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    await context.route("**/*", (route) =>
      route.request().url().startsWith(`${origin}/`)
        ? route.continue()
        : route.abort(),
    );
    const main = await context.newPage();
    // These are static style/focus captures, not polling-continuity tests.
    // Hold later readiness responses so the photographed focus state cannot
    // be replaced between the assertion and screenshot. Actual natural and
    // forced polling remain covered in prep-correction-clarity.spec.ts.
    const captureComplete = gate();
    let initialReadiness = true;
    await main.route("**/api/runtime/readiness", async (route) => {
      if (initialReadiness) initialReadiness = false;
      else await captureComplete.promise;
      await route.continue();
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await main.goto(origin);
      await expect(
        main.getByRole("heading", { name: "Workspace and prep" }),
      ).toBeVisible();
      const mainCard = await main.evaluate(() => {
        const node = document.querySelector(".panel");
        if (!node) throw Error("Missing connected main card");
        const style = getComputedStyle(node);
        return {
          radius: style.borderRadius,
          border: style.border,
          padding: style.padding,
          background: style.backgroundColor,
          font: style.fontFamily,
        };
      });
      const cards = page.locator("#connections > section");
      const settingsCards = await cards.evaluateAll((nodes) =>
        nodes.map((node) => {
          const s = getComputedStyle(node);
          const r = node.getBoundingClientRect();
          return {
            radius: s.borderRadius,
            border: s.border,
            padding: s.padding,
            background: s.backgroundColor,
            font: s.fontFamily,
            top: r.top,
            bottom: r.bottom,
          };
        }),
      );
      expect(settingsCards).toHaveLength(3);
      const headingStyle = (node: Element) => {
        const style = getComputedStyle(node);
        return {
          size: style.fontSize,
          weight: style.fontWeight,
          lineHeight: style.lineHeight,
          spacing: style.letterSpacing,
          transform: style.textTransform,
        };
      };
      const mainHeading = await main
        .locator(".panel h2")
        .first()
        .evaluate(headingStyle);
      for (const heading of await page
        .locator("#connections > section h2")
        .all())
        expect(await heading.evaluate(headingStyle)).toEqual(mainHeading);

      for (const [index, card] of settingsCards.entries()) {
        expect
          .soft({
            radius: card.radius,
            border: card.border,
            padding: card.padding,
            background: card.background,
            font: card.font,
          })
          .toEqual(mainCard);
        if (index)
          expect
            .soft(card.top - (settingsCards[index - 1]?.bottom ?? Number.NaN))
            .toBeCloseTo(16, 0);
      }
      for (const route of [page, main])
        expect(
          await route.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      mkdirSync(evidence, { recursive: true });
      const mainImage = await main.screenshot({
        path: `${evidence}/matched-main-${width}.png`,
        fullPage: true,
      });
      const settingsImage = await page.screenshot({
        path: `${evidence}/matched-settings-${width}.png`,
        fullPage: true,
      });
      const comparison = await context.newPage();
      await comparison.setViewportSize({ width: width * 2, height: 900 });
      await comparison.setContent(
        `<style>body{margin:0;background:#f3f5f1;font:16px Arial}header{padding:12px}main{display:grid;grid-template-columns:1fr 1fr}figure{margin:0}img{display:block;width:100%}figcaption{padding:12px}</style><header>Synthetic main / saved settings — each viewport ${width}px, equal scale. Native Open panel is not shown.</header><main><figure><figcaption>Main</figcaption><img src="data:image/png;base64,${mainImage.toString("base64")}"></figure><figure><figcaption>Connection settings</figcaption><img src="data:image/png;base64,${settingsImage.toString("base64")}"></figure></main>`,
      );
      await comparison
        .locator("img")
        .evaluateAll((images) =>
          Promise.all(
            images.map((image) => (image as HTMLImageElement).decode()),
          ),
        );
      await comparison.screenshot({
        path: `${evidence}/side-by-side-${width}.png`,
        fullPage: true,
      });
      await comparison.close();
      await focusEvidence(main, ".topbar button", `focus-main-header-${width}`);
      await focusEvidence(main, "#choose-prep", `focus-main-choose-${width}`);
      await main.locator("#choose-prep").click();
      await focusEvidence(
        main,
        ".prep-chooser button",
        `focus-browser-fixture-item-${width}`,
      );
      await main.locator(".prep-chooser button").first().click();
      await expect(main.locator(".selected-prep")).toContainText(
        "Synthetic decision interview",
      );
      await expect(
        main.getByText("Which evidence changed the decision?", { exact: true }),
      ).toBeVisible();
      await expect(
        main.getByText("Who helped reconstruct the sequence?", { exact: true }),
      ).toBeVisible();
      await main.screenshot({
        path: `${evidence}/markdown-populated-${width}.png`,
        fullPage: true,
      });
      await focusEvidence(
        main,
        'input[type="checkbox"]',
        `focus-main-checkbox-${width}`,
      );
      await main.keyboard.press("Space");
      await expect(
        main.locator('input[type="checkbox"]').first(),
      ).toBeChecked();
      await expect(
        main.locator('input[type="checkbox"]').first(),
      ).toBeFocused();
      await expect(main.locator(".check-item.checked").first()).toHaveCSS(
        "opacity",
        "1",
      );
      await focusEvidence(
        main,
        'input[type="checkbox"]',
        `focus-main-checked-${width}`,
      );
      await focusEvidence(
        main,
        'input:not([type="checkbox"])',
        `focus-main-field-${width}`,
      );
      await expect(main.locator(".check-item.checked").first()).toHaveCSS(
        "opacity",
        "0.45",
      );
      await focusEvidence(
        main,
        "#transcript-disclosure",
        `focus-main-disclosure-${width}`,
      );
      for (const [selector, name] of [
        ["#recall-api-key", "field"],
        ["#hermes-mode", "select"],
        ["#test-connections", "button"],
        ["#reset", "reset"],
        ["#reload", "back"],
        ["#save-connections", "save"],
        ["summary", "disclosure"],
      ] as const)
        await focusEvidence(page, selector, `focus-settings-${name}-${width}`);
      await page.locator("#remote-guide > summary").click();
      // Both public topology jumps stay in the setup document and retain drafts.
      await page.locator("#hermes-endpoint-path").fill("/p/synthetic");
      await expect(page.locator("#remote-guide a")).toHaveCount(2);
      for (const id of ["this-mac", "another-mac"]) {
        await focusEvidence(
          page,
          `#remote-guide a[href="#${id}"]`,
          `focus-guide-${id}-link-${width}`,
        );
        await page.keyboard.press("Enter");
        await expect(page.locator(`#${id}`)).toBeFocused();
        await expect(page.locator("#hermes-endpoint-path")).toHaveValue(
          "/p/synthetic",
        );
        await focusEvidence(
          page,
          `#${id}`,
          `focus-guide-${id}-heading-${width}`,
        );
      }
      await focusEvidence(
        page,
        "#remote-guide textarea",
        `focus-guide-command-${width}`,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      captureComplete.release();
      await main.unrouteAll({ behavior: "ignoreErrors" });
      await main.goto("about:blank");
      service.close();
      server.closeAllConnections();
      await context.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
