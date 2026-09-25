import { expect, test } from "@playwright/test";

test("selects Meet, keeps the URL while switching, and submits the platform", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const platform = page.getByLabel("Meeting platform");
  const teamsInput = page.getByLabel("Personal Microsoft Teams meeting link");

  await expect(platform).toHaveValue("microsoft_teams_personal");
  const typography = await platform.evaluate((element) => {
    const style = getComputedStyle(element);
    const meetingInput = document.querySelector<HTMLInputElement>(
      "#capture-meeting-url",
    );
    const inputStyle = meetingInput ? getComputedStyle(meetingInput) : null;
    return {
      family: style.fontFamily,
      size: style.fontSize,
      inputFamily: inputStyle?.fontFamily,
      inputSize: inputStyle?.fontSize,
      appearance: style.appearance,
      paddingRight: style.paddingRight,
      backgroundPosition: style.backgroundPosition,
    };
  });
  expect(typography.family).toContain("Instrument Sans");
  expect(typography).toMatchObject({
    family: typography.inputFamily,
    size: typography.inputSize,
    appearance: "none",
    paddingRight: "44px",
  });
  expect(typography.backgroundPosition).toContain("16px");
  await page.screenshot({
    path: testInfo.outputPath("teams-selected.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.screenshot({
    path: testInfo.outputPath("teams-selected-narrow.png"),
    fullPage: true,
  });
  const selectorBox = await platform.boundingBox();
  if (!selectorBox) throw new Error("Missing selector geometry");
  await platform.click({
    position: { x: selectorBox.width - 16, y: selectorBox.height / 2 },
  });
  await expect(platform).toBeFocused();
  await page.keyboard.press("g");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Meeting platform")).toHaveValue("google_meet");
  await page.keyboard.press("Escape");
  await page
    .getByLabel("Meeting platform")
    .selectOption("microsoft_teams_personal");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Meeting platform")).toHaveValue(
    "microsoft_teams_personal",
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await teamsInput.fill("https://meet.google.com/abc-defg-hij");
  await platform.selectOption("google_meet");

  const meetInput = page.getByLabel("Google Meet meeting link");
  await expect(meetInput).toHaveValue("https://meet.google.com/abc-defg-hij");
  await expect(meetInput).toHaveAttribute(
    "placeholder",
    "https://meet.google.com/abc-defg-hij",
  );
  await expect(
    page.getByText(/waits for admission in Google Meet/),
  ).toBeVisible();

  let submitted: unknown;
  await page.route("**/api/capture/recall/start", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        kind: "invalid",
        error: "Synthetic stop after request inspection.",
        state: await page.evaluate(async () =>
          fetch("/api/session")
            .then((response) => response.json())
            .then((body) => body.state),
        ),
      }),
    });
  });
  await page.getByRole("button", { name: "Start live capture" }).click();
  expect(submitted).toMatchObject({
    meetingPlatform: "google_meet",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
  });
  await expect(
    page.getByText("Synthetic stop after request inspection."),
  ).toBeVisible();

  await page.locator("body").evaluate((element) => element.focus());
  for (let index = 0; index < 30; index += 1) {
    if (
      await platform.evaluate((element) => element === document.activeElement)
    )
      break;
    await page.keyboard.press("Tab");
  }
  await expect(platform).toBeFocused();
  const focus = await platform.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
    };
  });
  expect(focus).toEqual({ outlineOffset: "0px", outlineStyle: "solid" });
  await page.screenshot({
    path: testInfo.outputPath("google-meet-selected.png"),
    fullPage: true,
  });

  // The retained form must use the latest platform and moved input nodes,
  // including after an earlier start attempt and subsequent background renders.
  await platform.selectOption("microsoft_teams_personal");
  await teamsInput.fill("https://teams.live.com/meet/1234567890");
  submitted = undefined;
  await page.getByRole("button", { name: "Start live capture" }).click();
  expect(submitted).toMatchObject({
    meetingPlatform: "microsoft_teams_personal",
    meetingUrl: "https://teams.live.com/meet/1234567890",
  });
  await expect(platform).toBeEnabled();
});

test("shows a mismatch error and locks the selector while start is pending", async ({
  page,
}) => {
  await page.goto("/");
  const platform = page.getByLabel("Meeting platform");
  await page
    .getByLabel("Personal Microsoft Teams meeting link")
    .fill("https://meet.google.com/abc-defg-hij");

  await page.getByRole("button", { name: "Start live capture" }).click();
  await expect(
    page.getByText(/matching the selected platform is required/),
  ).toBeVisible();

  await page.route("**/api/capture/recall/start", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.abort();
  });
  await platform.selectOption("google_meet");
  await page.getByRole("button", { name: "Start live capture" }).click();
  await expect(platform).toBeDisabled();
  await expect(platform).toBeEnabled();
  await platform.selectOption("microsoft_teams_personal");
});
