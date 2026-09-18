import { expect } from "@playwright/test";
import { test } from "../helpers/setup-browser-fixture.js";

test.use({ readySetup: true, guardedQuit: true });
for (const outcome of ["exhausted", "held", "lost", "status-held"] as const) {
  test(`uncertain Back ${outcome}: Cancel and Save preserve lock, explicit Discard quits`, async ({
    page,
    setup,
  }) => {
    const bytes = setup.settingsBytes(),
      commits = setup.commits;
    const reload = setup.hold("reload", true);
    let releaseReply = () => {};
    const reply = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    let restoreStatus = false,
      heldStatus = false,
      deliveredReply = false;
    await page.evaluate(() => {
      const nativeFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (String(args[0]).endsWith("/api/setup/reload")) {
          const json = response.json.bind(response);
          response.json = async () => {
            const body = await json();
            (window as unknown as { backBodies: number }).backBodies =
              ((window as unknown as { backBodies: number }).backBodies ?? 0) +
              1;
            return body;
          };
        }
        return response;
      };
    });
    await page.route("**/api/setup/reload", async (route) => {
      if (route.request().method() === "GET") {
        if (outcome === "status-held") {
          reload.release();
          const response = await route.fetch();
          if ((await response.json()).state === "blocked") {
            heldStatus = true;
            await reply;
          }
          await route.fulfill({ response });
          deliveredReply = true;
          return;
        }
        if (!restoreStatus) return route.abort();
        return route.continue();
      }
      const response = await route.fetch();
      if (outcome === "held") {
        await reply;
        await route.fulfill({ response }).catch(() => {});
        deliveredReply = true;
      } else if (outcome === "lost") await route.abort();
      else await route.fulfill({ response });
    });
    await page.locator("#ngrok-domain").fill("unsaved.ngrok.app");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#reload").click();
    await setup.waitFor("reload");
    if (outcome === "exhausted")
      await expect(page.locator("#setup-message")).toContainText(
        "Return could not be confirmed",
        { timeout: 15000 },
      );
    if (outcome === "status-held")
      await expect.poll(() => heldStatus).toBe(true);
    restoreStatus = true;
    const before = await page.locator("#setup-message").textContent();
    expect(await setup.requestQuit("cancel")).toBe("blocked");
    await expect(page.locator("#ngrok-domain")).toHaveValue(
      "unsaved.ngrok.app",
    );
    await expect(page.locator("#ngrok-domain")).toBeDisabled();
    expect(await setup.requestQuit("save")).toBe("blocked");
    expect(setup.commits).toBe(commits);
    expect(setup.calls.filter((call) => call.kind === "save")).toHaveLength(0);
    expect(setup.events).not.toContain("setup-close");
    const closing = setup.holdNativeClose();
    const quit = setup.requestQuit("discard");
    try {
      await expect
        .poll(() => setup.events.includes("native-close-requested"))
        .toBe(true);
      const closingMessage = await page.locator("#setup-message").textContent();
      const bodies = await page.evaluate(
        () => (window as unknown as { backBodies: number }).backBodies ?? 0,
      );
      releaseReply();
      reload.release();
      // A late refusal must not revoke approved close or unlock/rewrite this document.
      await expect
        .poll(() => setup.calls.filter((call) => call.kind === "reload").length)
        .toBe(1);
      if (outcome === "held" || outcome === "status-held") {
        await expect.poll(() => deliveredReply).toBe(true);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as { backBodies: number }).backBodies ?? 0,
            ),
          )
          .toBeGreaterThan(bodies);
      }
      await expect(page.locator("#setup-message")).toHaveText(
        closingMessage ?? before ?? "",
      );
      await expect(page.locator("#ngrok-domain")).toBeDisabled();
      expect(setup.events).not.toContain("setup-close");
      closing.release();
      expect(await quit).toBe("quit");
      expect(setup.events.indexOf("native-closed")).toBeLessThan(
        setup.events.indexOf("setup-close"),
      );
      expect(setup.events).toContain("app-quit");
      expect(setup.settingsBytes()).toBe(bytes);
      expect(setup.commits).toBe(commits);
    } finally {
      closing.release();
      releaseReply();
      reload.release();
    }
  });
}
