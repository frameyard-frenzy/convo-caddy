import { expect, test } from "@playwright/test";

for (const gesture of [
  "pointer",
  "same-value",
  "Home",
  "End",
  "post-change",
  "blur",
]) {
  test(`platform stays connected and UI refreshes after ${gesture}`, async ({
    page,
  }) => {
    let revision = 0;
    await page.route("**/api/runtime/readiness", async (route) => {
      await route.fulfill({
        json: {
          readiness: {
            state: "needs_attention",
            components: { capture: "ready", hermes: "ready" },
            diagnostics: [
              {
                component: "capture",
                severity: "warning",
                message: `Readiness applied ${++revision}`,
                action: "",
              },
            ],
          },
        },
      });
    });
    await page.addInitScript(() => {
      const delivery = { count: 0 };
      Object.assign(window, { sessionDelivery: delivery });
      const add = EventSource.prototype.addEventListener;
      Object.defineProperty(EventSource.prototype, "addEventListener", {
        value: function (
          this: EventSource,
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ) {
          if (type !== "session" || typeof listener !== "function") {
            return Reflect.apply(add, this, [type, listener, options]);
          }
          return add.call(
            this,
            type,
            function (this: EventSource, event: Event) {
              listener.call(this, event);
              delivery.count++;
            },
            options,
          );
        },
      });
    });
    await page.goto("/");
    await page.locator(".runtime-diagnostics summary").click();
    await page
      .getByRole("button", { name: "Show transcript", exact: true })
      .click();
    const select = page.getByLabel("Meeting platform");
    await select.evaluate((element) => {
      const audit = { removed: false, clicks: 0 };
      Object.assign(window, { platformAudit: audit });
      document.addEventListener(
        "click",
        (event) => {
          if (event.target === element && event.isTrusted) audit.clicks++;
        },
        true,
      );
      new MutationObserver((records) => {
        for (const record of records)
          for (const removed of record.removedNodes) {
            if (removed === element || removed.contains(element))
              audit.removed = true;
          }
      }).observe(document, { subtree: true, childList: true });
    });
    const handle = await select.elementHandle();
    if (!handle) throw new Error("No selector");
    await select.focus();
    if (gesture === "pointer") {
      const box = await select.boundingBox();
      if (!box) throw new Error("No geometry");
      await page.mouse.click(box.x + box.width - 18, box.y + box.height / 2);
    } else if (gesture === "same-value") {
      await page.keyboard.press("Space");
      await page.keyboard.press("Enter");
    } else if (gesture === "post-change") {
      await page.keyboard.press("g");
      await page.keyboard.press("Enter");
      await expect(select).toHaveValue("google_meet");
      await page.keyboard.press("Enter");
    } else if (gesture === "blur") {
      await page.keyboard.press("Space");
      await page.keyboard.press("Escape");
      await page.getByLabel(/meeting link/).focus();
    } else {
      await page.keyboard.press(gesture);
      await page.keyboard.press("Enter");
    }

    const startRevision = revision;
    // A visible marker proves the response was consumed AND rendered, not just requested.
    await expect(
      page.getByText(`Readiness applied ${startRevision + 2}`, { exact: true }),
    ).toBeVisible({ timeout: 5000 });
    const before = await page.locator(".transcript-turn").count();
    const delivered = await page.evaluate(
      () =>
        (window as unknown as { sessionDelivery: { count: number } })
          .sessionDelivery.count,
    );
    await page.evaluate(async () => {
      await fetch("/api/session/simulation/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    });
    // This action only returns HTTP state; the new visible turn requires SSE application.
    await expect(page.locator(".transcript-turn")).toHaveCount(before + 1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { sessionDelivery: { count: number } })
              .sessionDelivery.count,
        ),
      )
      .toBeGreaterThan(delivered);
    expect(await handle.evaluate((element) => element.isConnected)).toBe(true);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { platformAudit: { removed: boolean } })
            .platformAudit.removed,
      ),
    ).toBe(false);
    if (gesture === "pointer") {
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { platformAudit: { clicks: number } })
              .platformAudit.clicks,
        ),
      ).toBeGreaterThan(0);
    }
    await page.keyboard.press("Escape");
    await select.click();
    const reopenedRevision = revision;
    await expect(
      page.getByText(`Readiness applied ${reopenedRevision + 2}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("g");
    await page.keyboard.press("Enter");
    await expect(select).toHaveValue("google_meet");
    await expect(page.getByLabel("Google Meet meeting link")).toBeVisible();
    const meetRevision = revision;
    await expect(
      page.getByText(`Readiness applied ${meetRevision + 2}`, { exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await select.focus();
    await page.keyboard.press("m");
    await page.keyboard.press("Enter");
    await expect(select).toHaveValue("microsoft_teams_personal");
    await expect(
      page.getByLabel("Personal Microsoft Teams meeting link"),
    ).toBeVisible();
    const afterChoice = revision;
    await expect(
      page.getByText(`Readiness applied ${afterChoice + 2}`, { exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await page.evaluate(async () => {
      await fetch("/api/session/simulation/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    });
    await expect(page.locator(".transcript-turn")).toHaveCount(before + 2);
    expect(await handle.evaluate((element) => element.isConnected)).toBe(true);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { platformAudit: { removed: boolean } })
            .platformAudit.removed,
      ),
    ).toBe(false);
  });
}

test("Teams label has room beside the inset arrow at 1100px", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const clearance = await page
    .getByLabel("Meeting platform")
    .evaluate((select) => {
      const style = getComputedStyle(select);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("No text measurement context");
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return (
        select.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        context.measureText("Microsoft Teams (personal)").width
      );
    });
  await page.screenshot({
    path: testInfo.outputPath("teams-1100.png"),
    fullPage: true,
  });
  expect(clearance).toBeGreaterThanOrEqual(0);
});
