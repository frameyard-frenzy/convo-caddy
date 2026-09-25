import { expect, test } from "@playwright/test";

test("keeps a user-opened platform selector alive across readiness and SSE redraws", async ({
  page,
}) => {
  let readinessRequests = 0;
  await page.route("**/api/runtime/readiness", async (route) => {
    readinessRequests += 1;
    await route.fulfill({ json: { readiness: null } });
  });
  await page.goto("/");

  const platform = page.getByLabel("Meeting platform");
  await platform.focus();
  await platform.dispatchEvent("pointerdown", { pointerType: "mouse" });
  const canceledHandle = await platform.elementHandle();
  if (!canceledHandle) throw new Error("Missing platform selector");
  const pollsBeforeCancel = readinessRequests;
  await expect
    .poll(() => readinessRequests)
    .toBeGreaterThan(pollsBeforeCancel + 1);
  expect(await canceledHandle.evaluate((element) => element.isConnected)).toBe(
    true,
  );

  await page.keyboard.press("Escape");
  await expect
    .poll(() => canceledHandle.evaluate((element) => element.isConnected))
    .toBe(false);

  const reopened = page.getByLabel("Meeting platform");
  await reopened.focus();
  await reopened.dispatchEvent("pointerdown", { pointerType: "mouse" });
  const openHandle = await reopened.elementHandle();
  if (!openHandle) throw new Error("Missing reopened platform selector");
  const pollsBeforeSelection = readinessRequests;
  await expect
    .poll(() => readinessRequests)
    .toBeGreaterThan(pollsBeforeSelection + 1);
  for (let index = 0; index < 2; index += 1) {
    expect(
      await page.evaluate(async () => {
        const response = await fetch("/api/session/simulation/step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        return response.ok;
      }),
    ).toBe(true);
  }
  expect(await openHandle.evaluate((element) => element.isConnected)).toBe(
    true,
  );

  await page.keyboard.press("Escape");
  await expect
    .poll(() => openHandle.evaluate((element) => element.isConnected))
    .toBe(false);

  const keyboardSelector = page.getByLabel("Meeting platform");
  await keyboardSelector.focus();
  const keyboardHandle = await keyboardSelector.elementHandle();
  if (!keyboardHandle) throw new Error("Missing keyboard platform selector");
  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Alt");
  const pollsBeforeKeyboardSelection = readinessRequests;
  await expect
    .poll(() => readinessRequests)
    .toBeGreaterThan(pollsBeforeKeyboardSelection + 1);
  expect(await keyboardHandle.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await page.keyboard.press("g");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Meeting platform")).toHaveValue("google_meet");
  await expect(page.getByLabel("Google Meet meeting link")).toBeVisible();
  await expect(
    page.getByText(/waits for admission in Google Meet/),
  ).toBeVisible();

  const pollsAfterMeet = readinessRequests;
  await expect.poll(() => readinessRequests).toBeGreaterThan(pollsAfterMeet);
  expect(
    await page.evaluate(async () => {
      const response = await fetch("/api/session/simulation/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return response.ok;
    }),
  ).toBe(true);
  await expect(page.getByLabel("Meeting platform")).toHaveValue("google_meet");
  await expect(page.getByLabel("Google Meet meeting link")).toBeVisible();

  const meetSelector = page.getByLabel("Meeting platform");
  await meetSelector.focus();
  await page.keyboard.press("m");
  await page.keyboard.press("Enter");
  await expect(meetSelector).toHaveValue("microsoft_teams_personal");
  await expect(
    page.getByLabel("Personal Microsoft Teams meeting link"),
  ).toBeVisible();
});

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
  await page.getByLabel("Meeting platform").focus();
  await page.keyboard.press("m");
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
