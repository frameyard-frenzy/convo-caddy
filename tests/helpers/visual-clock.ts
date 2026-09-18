import { expect, type Page } from "@playwright/test";

export const VISUAL_CLOCK_TIME = Date.UTC(2026, 0, 1);

export async function freezeVisualClockBeforeNavigation(page: Page) {
  expect(page.url()).toBe("about:blank");
  // Playwright pauseAt installs its clock if needed. Pause on the blank page,
  // before app timers exist; never compare Node time to a running browser clock.
  await page.clock.pauseAt(VISUAL_CLOCK_TIME);
  expect(await page.evaluate(() => Date.now())).toBe(VISUAL_CLOCK_TIME);
}
