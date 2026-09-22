import { expect } from "@playwright/test";
import { test } from "../helpers/setup-browser-fixture.js";

const evidence =
  process.env.CONVO_CADDY_CLARITY_ARTIFACTS ?? "test-results/clarity";
for (const width of [1280, 900, 390])
  test(`settings clarity at ${width}`, async ({ page, setup }) => {
    void setup;
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole("heading", { name: "Connection settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("header").getByRole("button", { name: "Back to app" }),
    ).toHaveCount(0);
    for (const id of ["discard", "reconcile"])
      await expect(page.locator(`#${id}`)).toHaveCount(0);
    await expect(page.locator("#reload")).toBeDisabled();
    await expect(page.locator("#reset")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#reset")).toHaveCSS("color", "rgb(169, 34, 30)");
    await page.locator("#recall-api-key").focus();
    await expect(page.locator("#recall-api-key")).toHaveCSS(
      "outline-offset",
      "0px",
    );
    await page.screenshot({
      path: `${evidence}/after-settings-${width}.png`,
      fullPage: true,
    });
    if (width === 1280 || width === 390) {
      await page.locator("#reset").scrollIntoViewIfNeeded();
      await page.locator("#reset").focus();
      await expect(page.locator("#reset")).toBeFocused();
      await expect(page.locator("#save-connections")).toBeVisible();
      await expect(page.locator("#reset")).toBeVisible();
      await page.screenshot({
        path: `${evidence}/save-reset-context-${width}.png`,
      });
      await page.screenshot({
        path: `${evidence}/save-reset-full-${width}.png`,
        fullPage: true,
      });
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

for (const width of [1100, 390])
  test(`Save, diagnostic copy and Reset share a compact focused viewport at ${width}`, async ({
    page,
    setup,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    void setup;
    await page.route("**/api/setup/connections", (route) =>
      route.fulfill({
        status: 503,
        json: { code: "settings_storage_unavailable" },
      }),
    );
    await page.locator("#ngrok-domain").fill("fixture.ngrok.app");
    await page.locator("#recall-api-key").fill("synthetic-recall");
    await page
      .locator("#recall-webhook-verification-secret")
      .fill("whsec_c3ludGhldGlj");
    await page.locator("#ngrok-authtoken").fill("synthetic-ngrok");
    await page.locator("#save-connections").click();
    await expect(page.locator("#setup-report-panel")).toBeVisible();
    await page.locator("#save-connections").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#copy-setup-report")).toBeFocused();
    await page.locator("#reset").scrollIntoViewIfNeeded();
    for (const id of ["save-connections", "copy-setup-report", "reset"])
      await expect(page.locator(`#${id}`)).toBeVisible();
    await page.locator("#save-connections").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#copy-setup-report")).toBeFocused();
    await page.screenshot({
      path: `${evidence}/save-copy-reset-context-${width}.png`,
    });
    await page.screenshot({
      path: `${evidence}/save-copy-reset-full-${width}.png`,
      fullPage: true,
    });
    await page.locator("#reset").focus();
    await expect(page.locator("#reset")).toBeFocused();
    await page.screenshot({
      path: `${evidence}/save-copy-reset-reset-focus-${width}.png`,
    });
  });

test.describe("Back through actual saved setup routes", () => {
  test.use({ readySetup: true });
  test("cancel preserves draft; accepted Back replaces runtime without saving", async ({
    page,
    setup,
  }) => {
    const bytes = setup.settingsBytes();
    const commits = setup.commits;
    await page.locator("#ngrok-domain").fill("draft.ngrok.app");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(page.locator("#ngrok-domain")).toHaveValue("draft.ngrok.app");
    expect(await unloadVetoed(page)).toBe(true);
    expect(setup.runtimeStarts).toBe(1);
    expect(setup.settingsBytes()).toBe(bytes);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(
      page.getByRole("heading", { name: "Fixture runtime replaced" }),
    ).toBeVisible();
    expect(setup.events).not.toContain("navigation-vetoed");
    expect(setup.commits).toBe(commits);
    expect(setup.settingsBytes()).toBe(bytes);
  });
  for (const reply of ["held", "lost", "refused"] as const) {
    test(`Back ${reply} reply carries only confirmed document discard authority`, async ({
      page,
      setup,
    }) => {
      const hold = setup.hold("reload", reply === "lost");
      let releaseReply = () => {};
      const pendingReply = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      let posted = false;
      await page.route("**/api/setup/reload", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posted = true;
        if (reply === "refused")
          return route.fulfill({
            status: 409,
            json: { error: "Synthetic refusal" },
          });
        const response = await route.fetch();
        if (reply === "lost") return route.abort();
        await pendingReply;
        await route.fulfill({ response }).catch(() => {});
      });
      await page.locator("#ngrok-domain").fill("draft.ngrok.app");
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#reload").click();
      await expect.poll(() => posted).toBe(true);
      try {
        if (reply === "refused") {
          await expect(page.locator("#setup-message")).toContainText(
            "Synthetic refusal",
          );
          await expect(page.locator("#copy-setup-report")).toBeEnabled();
          await expect(page.locator("#setup-report")).toHaveValue(
            /Operation: Return to app/,
          );
          await page.locator("#copy-setup-report").focus();
          await page.keyboard.press("Enter");
          await expect(page.locator("#copy-setup-report-status")).toHaveText(
            "Copied",
          );
          await expect(page.locator("#setup-report")).not.toHaveValue(
            /Synthetic refusal|draft\.ngrok\.app/,
          );
        } else {
          await setup.waitFor("reload");
          await expect(page.locator("#ngrok-domain")).toBeDisabled();
          expect(await unloadVetoed(page)).toBe(false);
          expect(setup.events).not.toContain("setup-close");
          hold.release();
          if (reply === "held") {
            await expect(
              page.getByRole("heading", { name: "Fixture runtime replaced" }),
            ).toBeVisible();
            expect(setup.events).not.toContain("navigation-vetoed");
            return;
          }
          await expect(page.locator("#setup-message")).toContainText(
            "Could not return",
          );
        }
        await expect(page.locator("#ngrok-domain")).toBeEnabled();
        await expect(page.locator("#ngrok-domain")).toHaveValue(
          "draft.ngrok.app",
        );
        expect(await unloadVetoed(page)).toBe(true);
        expect(setup.events).not.toContain("setup-close");
        // A newly loaded document at exactly the same URL must protect its own draft.
        await page.locator("#ngrok-domain").fill("fixture.ngrok.app");
        await page.reload();
        await expect(page.locator("#ngrok-domain")).toBeEnabled();
        await page.locator("#ngrok-domain").fill("new-document.ngrok.app");
        expect(await unloadVetoed(page)).toBe(true);
      } finally {
        releaseReply();
        hold.release();
      }
    });
  }
  test("pending Back authority does not survive a same-URL new document", async ({
    page,
    setup,
  }) => {
    const hold = setup.hold("reload", true);
    await page.locator("#ngrok-domain").fill("discarded.ngrok.app");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#reload").click();
    await setup.waitFor("reload");
    expect(await unloadVetoed(page)).toBe(false);
    await page.reload();
    await expect(page.locator("#ngrok-domain")).toBeEnabled();
    await page.locator("#ngrok-domain").fill("new-document.ngrok.app");
    expect(await unloadVetoed(page)).toBe(true);
    hold.release();
    expect(setup.events).not.toContain("setup-close");
  });
  test("reverted edits return without a discard prompt", async ({
    page,
    setup,
  }) => {
    await page.locator("#ngrok-domain").fill("draft.ngrok.app");
    await page.locator("#ngrok-domain").fill("fixture.ngrok.app");
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs++;
      void dialog.dismiss();
    });
    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(
      page.getByRole("heading", { name: "Fixture runtime replaced" }),
    ).toBeVisible();
    expect(dialogs).toBe(0);
    expect(setup.calls.filter((call) => call.kind === "save")).toHaveLength(0);
  });
  test("runtime refusal unlocks the intact draft and allows a guarded retry", async ({
    page,
    setup,
  }) => {
    await page.locator("#recall-api-key").fill("unsaved-synthetic");
    const hold = setup.hold("reload", true);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#reload").click();
    await setup.waitFor("reload");
    await expect(page.locator("#recall-api-key")).toBeDisabled();
    hold.release();
    await expect(page.locator("#setup-message")).toContainText(
      "Could not return",
    );
    await expect(page.locator("#recall-api-key")).toHaveValue(
      "unsaved-synthetic",
    );
    await expect(page.locator("#reload")).toBeEnabled();
    expect(await unloadVetoed(page)).toBe(true);
    expect(setup.events).not.toContain("setup-close");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#reload").click();
    await expect(
      page.getByRole("heading", { name: "Fixture runtime replaced" }),
    ).toBeVisible();
  });

  for (const settlement of ["resolve", "reject"] as const)
    test(`Back retry retires a refused report before stale clipboard ${settlement}`, async ({
      page,
      setup,
    }) => {
      let posts = 0;
      await page.route("**/api/setup/reload", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts++;
        if (posts === 1)
          return route.fulfill({
            status: 409,
            json: { error: "Synthetic refusal" },
          });
        return route.continue();
      });
      await page.locator("#ngrok-domain").fill("draft.ngrok.app");
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#reload").click();
      await expect(page.locator("#setup-report-panel")).toBeVisible();
      await page.locator("#copy-setup-report").click();
      await expect(page.locator("#copy-setup-report-status")).toHaveText(
        "Copied",
      );

      page.once("dialog", (dialog) => dialog.dismiss());
      await page.locator("#reload").click();
      await expect(page.locator("#setup-report-panel")).toBeVisible();
      await expect(page.locator("#copy-setup-report-status")).toHaveText(
        "Copied",
      );

      await page.evaluate((settlement) => {
        let settle!: () => void;
        const promise = new Promise<void>((resolve, reject) => {
          settle = settlement === "resolve" ? resolve : reject;
        });
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => promise },
        });
        Object.assign(window, { settleBackClipboard: settle });
      }, settlement);
      await page.locator("#copy-setup-report").click();
      const retry = setup.hold("reload");
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#reload").click();
      await setup.waitFor("reload");
      await expect(page.locator("#setup-report-panel")).toBeHidden();
      await expect(page.locator("#copy-setup-report-status")).toHaveText("");
      await page.evaluate(() =>
        (
          window as typeof window & { settleBackClipboard: () => void }
        ).settleBackClipboard(),
      );
      await expect(page.locator("#setup-report-panel")).toBeHidden();
      await expect(page.locator("#copy-setup-report-status")).toHaveText("");
      await expect(page.locator("#setup-report")).not.toBeFocused();
      await expect(page.locator("#setup-report")).not.toHaveClass(
        /manual-copy/,
      );
      retry.release();
    });

  for (const failure of ["network", "json"])
    test(`lost Back status ${failure} reconciles later runtime refusal`, async ({
      page,
      setup,
    }) => {
      const bytes = setup.settingsBytes();
      await page.locator("#ngrok-domain").fill("draft.ngrok.app");
      const hold = setup.hold("reload", true);
      let lost = false;
      await page.route("**/api/setup/reload", async (route) => {
        if (route.request().method() !== "GET" || lost) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        expect((await response.json()).state).toBe("pending");
        lost = true;
        if (failure === "network") await route.abort();
        else
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "{",
          });
      });
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#reload").click();
      await expect.poll(() => lost).toBe(true);
      await expect(page.locator("#ngrok-domain")).toBeDisabled();
      hold.release();
      await expect(page.locator("#setup-message")).toContainText(
        "Could not return",
      );
      await expect(page.locator("#ngrok-domain")).toBeEnabled();
      await expect(page.locator("#ngrok-domain")).toHaveValue(
        "draft.ngrok.app",
      );
      expect(setup.settingsBytes()).toBe(bytes);
      expect(setup.calls.filter((call) => call.kind === "reload")).toHaveLength(
        1,
      );
    });
  for (const status of ["pending", "unavailable", "hung"])
    test(`unresolved Back ${status} gives bounded actionable uncertainty without unlocking`, async ({
      page,
      setup,
    }) => {
      const bytes = setup.settingsBytes();
      const hold = setup.hold("reload", true);
      const requests: Array<() => void> = [];
      if (status !== "pending")
        await page.route("**/api/setup/reload", async (route) => {
          if (route.request().method() !== "GET") {
            await route.continue();
            return;
          }
          if (status === "hung")
            await new Promise<void>((resolve) => requests.push(resolve));
          await route.abort().catch(() => {});
        });
      await page.locator("#ngrok-domain").fill("draft.ngrok.app");
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#reload").click();
      await setup.waitFor("reload");
      await expect(page.locator("#setup-message")).toContainText(
        "Return could not be confirmed",
        { timeout: 15000 },
      );
      await expect(page.locator("#setup-message")).toContainText(
        "Quit and reopen",
      );
      for (const id of ["ngrok-domain", "reload", "reset"])
        await expect(page.locator(`#${id}`)).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Save", exact: true }),
      ).toBeDisabled();
      await expect(page.locator("#copy-setup-report")).toBeEnabled();
      await page.locator("#copy-setup-report").focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#copy-setup-report-status")).toHaveText(
        "Copied",
      );
      await expect(page.locator("#setup-report")).toHaveValue(
        /Operation: Confirm return to app/,
      );
      await expect(page.locator("#ngrok-domain")).toHaveValue(
        "draft.ngrok.app",
      );
      expect(setup.settingsBytes()).toBe(bytes);
      expect(setup.calls.filter((call) => call.kind === "reload")).toHaveLength(
        1,
      );
      await page.screenshot({
        path: `${evidence}/correction-back-${status}-uncertain.png`,
        fullPage: true,
      });
      for (const release of requests) release();
      hold.release();
    });
  test("Back is disabled during an inline check; direct navigation route also refuses", async ({
    page,
    setup,
  }) => {
    const hold = setup.hold("discovery");
    await page.locator("#discover-hermes-profiles").click();
    await setup.waitFor("discovery");
    await expect(page.locator("#reload")).toBeDisabled();
    const result = await page.request.post(
      `${setup.setupUrl}/api/setup/reload`,
      { headers: { origin: setup.setupUrl }, data: {} },
    );
    expect(result.status()).toBe(409);
    expect(setup.runtimeStarts).toBe(1);
    hold.release();
    await expect(page.locator("#reload")).toBeEnabled();
  });
});

async function unloadVetoed(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  );
}
