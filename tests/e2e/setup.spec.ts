import { expect, test } from "@playwright/test";

const setupUrl = `http://127.0.0.1:${process.env.CONVO_CADDY_SETUP_FIXTURE_PORT ?? 4318}`;

test.beforeEach(async ({ context, page, request }) => {
  await context.addCookies([
    {
      name: "convo_caddy_launch",
      value: "setup_fixture_token_12345678901234567890123",
      url: setupUrl,
    },
  ]);
  await request.delete(`${setupUrl}/api/setup/credentials`, {
    headers: {
      origin: setupUrl,
      cookie: "convo_caddy_launch=setup_fixture_token_12345678901234567890123",
    },
    data: { confirm: true },
  });
  await page.goto(setupUrl);
  await expect(page.locator("#setup-status")).toHaveText("Setup needed");
});

test("retains one masked draft through test, discovery, assistant and failures", async ({
  page,
}) => {
  await page.locator("#recall-api-key").fill("synthetic-recall");
  await page
    .getByLabel("Workspace verification secret")
    .fill("whsec_c3ludGhldGlj");
  await page.getByLabel("Stable domain").fill("fixture.ngrok.app");
  await page.getByLabel("Authtoken").fill("synthetic-ngrok");
  await page.getByLabel("Where Hermes runs").selectOption("local");
  await page.locator("#hermes-api-key").fill("synthetic-hermes");

  await page.getByRole("button", { name: "Test Recall & ngrok" }).click();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Synthetic checks passed",
  );
  await page.screenshot({
    path: "test-results/setup-success.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Load models" }).click();
  await expect(page.locator("#hermes-outcome")).toContainText("models loaded");
  await page.getByLabel("Model").selectOption("everyday");
  await page.getByRole("button", { name: "Test assistant" }).click();
  await expect(page.locator("#assistant-outcome")).toContainText(
    "Assistant test passed",
  );
  await expect(page.locator("#recall-api-key")).toHaveValue("synthetic-recall");
  await expect(page.locator("#hermes-api-key")).toHaveValue("synthetic-hermes");

  await page.locator("#recall-api-key").fill("fail-test");
  await page.getByRole("button", { name: "Test Recall & ngrok" }).click();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Setup operation failed",
  );
  await expect(page.locator("#recall-api-key")).toHaveValue("fail-test");
  await expect(page.locator("#hermes-api-key")).toHaveValue("synthetic-hermes");
  await page.screenshot({
    path: "test-results/setup-failure.png",
    fullPage: true,
  });
});

test("invalidates stale outcomes, locks save, and retains an unconfirmed draft", async ({
  page,
}) => {
  const recallKey = page.locator("#recall-api-key");
  await recallKey.fill("synthetic-recall");
  await page
    .getByLabel("Workspace verification secret")
    .fill("whsec_c3ludGhldGlj");
  await page.getByLabel("Stable domain").fill("fixture.ngrok.app");
  await page.getByLabel("Authtoken").fill("synthetic-ngrok");
  await page.getByRole("button", { name: "Test Recall & ngrok" }).click();
  await page.getByLabel("Stable domain").fill("changed.ngrok.app");
  await expect(page.locator("#recall-outcome")).toContainText("Changed");
  await page.screenshot({
    path: "test-results/setup-stale.png",
    fullPage: true,
  });

  await recallKey.fill("fail-save");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(recallKey).toBeDisabled();
  await page.screenshot({
    path: "test-results/setup-loading-disabled.png",
    fullPage: true,
  });
  await expect(page.locator("#setup-message")).toContainText(
    "Setup operation failed",
  );
  await expect(recallKey).toHaveValue("fail-save");
  await expect(recallKey).toBeEnabled();
});

test("retains the draft when a successful save response is lost", async ({
  page,
}) => {
  await page.locator("#recall-api-key").fill("committed-but-unconfirmed");
  await page
    .getByLabel("Workspace verification secret")
    .fill("whsec_c3ludGhldGlj");
  await page.getByLabel("Stable domain").fill("fixture.ngrok.app");
  await page.getByLabel("Authtoken").fill("synthetic-ngrok");
  await page.route("**/api/setup/connections", async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#setup-message")).toContainText(
    "save may have completed",
  );
  await expect(page.locator("#recall-api-key")).toHaveValue(
    "committed-but-unconfirmed",
  );
  await expect(page.locator("#recall-api-key")).toBeEnabled();
});

test("loads the source-served font and preserves narrow and keyboard geometry", async ({
  page,
}) => {
  await page.screenshot({
    path: "test-results/setup-initial.png",
    fullPage: true,
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.fonts.check('16px "Instrument Sans Variable"'),
      ),
    )
    .toBe(true);
  expect(
    await page
      .locator("html")
      .evaluate((node) => getComputedStyle(node).fontFamily),
  ).toContain("Instrument Sans");
  const font = await page.request.get(
    `${setupUrl}/fonts/instrument-sans.woff2`,
  );
  expect(font.ok()).toBe(true);
  expect(font.headers()["content-type"]).toContain("font/woff2");
  expect(
    await page.locator("html").evaluate(() =>
      [...document.styleSheets].some((sheet) => {
        try {
          return [...sheet.cssRules].some(
            (rule) =>
              rule instanceof CSSFontFaceRule &&
              rule.style
                .getPropertyValue("src")
                .includes("/fonts/instrument-sans.woff2"),
          );
        } catch {
          return false;
        }
      }),
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 420, height: 900 });
  const select = page.locator("#hermes-mode");
  await select.focus();
  await expect(select).toBeFocused();
  const geometry = await select.evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    paddingRight: getComputedStyle(node).paddingRight,
    outline: getComputedStyle(node).outlineColor,
  }));
  await page.screenshot({
    path: "test-results/setup-narrow-focus.png",
    fullPage: true,
  });
  expect(geometry.width).toBeGreaterThan(300);
  expect(Number.parseFloat(geometry.paddingRight)).toBeGreaterThanOrEqual(40);
  expect(geometry.outline).toBe("rgb(46, 113, 88)");
});
