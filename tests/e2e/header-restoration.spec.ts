import { expect, test } from "@playwright/test";
import path from "node:path";

const evidence = process.env.CADDY_HEADER_EVIDENCE_DIR;

test("non-null connection states preserve historical two-row banner and recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const readiness = {
    state: "ready",
    components: {
      configuration: "ready",
      workspace: "ready",
      appServer: "ready",
      webhookServer: "ready",
      ngrok: "ready",
      hermesTunnel: "owned",
      hermes: "ready",
      capture: "ready",
    },
    diagnostics: [] as Array<{
      component: string;
      code: string;
      severity: string;
      message: string;
      action: string;
    }>,
  };
  await page.route("**/api/runtime/readiness", (route) =>
    route.fulfill({ json: { readiness } }),
  );
  await page.route(/\/api\/session(?:\/content\/open)?$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.state.capture.mode = "live_ready";
    await route.fulfill({ json: body });
  });
  await page.route("**/api/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const header = page.locator(".topbar");
  const geometry = () =>
    page.locator(".session-status").evaluate((el) => {
      const box = (selector: string) => {
        const element = el.querySelector(selector);
        if (!element) throw new Error(`Missing header element: ${selector}`);
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return {
        preservation: box(".preservation-status"),
        elapsed: box(".elapsed"),
        status: box(".capture-status"),
      };
    });
  if (evidence)
    await header.screenshot({ path: path.join(evidence, "ready-banner.png") });
  await expect(header.locator(".session-status > p")).toHaveCount(3);
  const baseline = await geometry();
  // Historical 1280px banner: 24px outer inset, 1232 × 131px olive field.
  const bannerBox = await header.boundingBox();
  if (!bannerBox) throw new Error("Missing banner");
  expect({ ...bannerBox, height: Math.round(bannerBox.height) }).toEqual({
    x: 24,
    y: 24,
    width: 1232,
    height: 131,
  });
  expect(baseline.preservation.y).toBeLessThan(baseline.elapsed.y);
  expect(Math.abs(baseline.elapsed.y - baseline.status.y)).toBeLessThan(3);
  expect(baseline.elapsed.x).toBeLessThan(baseline.status.x);
  await expect(page.locator(".runtime-recovery")).toHaveCount(0);
  for (const [state, text] of [
    ["ready_without_marty", "Ready for capture; Assistant is unavailable"],
    ["needs_attention", "Meeting connections need attention"],
    ["starting", "Starting meeting connections…"],
    ["setup_required", "Configuration required"],
  ] as const) {
    readiness.state = state;
    await expect(page.locator(".runtime-recovery")).toContainText(text);
    await expect(header.locator(".session-status > p")).toHaveCount(3);
    expect(await geometry()).toEqual(baseline);
  }
  readiness.state = "ready_without_marty";
  readiness.components.hermesTunnel = "failed";
  readiness.components.hermes = "unavailable";
  readiness.diagnostics = [
    {
      component: "hermesTunnel",
      code: "ssh_exited_before_ready",
      severity: "warning",
      message: "Synthetic SSH forward exited before ready.",
      action: "Check synthetic host access.",
    },
  ];
  await expect(
    page.getByRole("button", { name: "Retry connection", exact: true }),
  ).toBeVisible();
  await page.locator(".runtime-diagnostics summary").click();
  await expect(page.locator(".runtime-diagnostics")).toContainText(
    "Check synthetic host access.",
  );
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(
    await page
      .getByRole("button", { name: "Retry connection", exact: true })
      .evaluate((el) => getComputedStyle(el).outlineOffset),
  ).toBe("0px");
  await expect(
    page.getByRole("button", { name: "Retry connection", exact: true }),
  ).toBeFocused();
  expect(
    await page
      .getByRole("button", { name: "Retry connection", exact: true })
      .evaluate((el) => getComputedStyle(el).outlineStyle),
  ).toBe("solid");
  if (evidence)
    await page.screenshot({
      path: path.join(evidence, "restored-failure-desktop.png"),
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(header.locator(".session-status > p")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  if (evidence)
    await page.screenshot({
      path: path.join(evidence, "restored-failure-narrow.png"),
    });
  readiness.state = "ready";
  readiness.diagnostics = [];
  await expect(page.locator(".runtime-recovery")).toHaveCount(0);
});
