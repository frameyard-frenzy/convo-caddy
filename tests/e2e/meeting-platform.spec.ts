import { expect, test } from "@playwright/test";

test("selects Meet, keeps the URL while switching, and submits the platform", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const platform = page.getByLabel("Meeting platform");
  const teamsInput = page.getByLabel("Personal Microsoft Teams meeting link");

  await expect(platform).toHaveValue("microsoft_teams_personal");
  await page.screenshot({
    path: testInfo.outputPath("teams-selected.png"),
    fullPage: true,
  });
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
