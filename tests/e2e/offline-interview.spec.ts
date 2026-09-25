import { expect, type Page, test } from "@playwright/test";
import {
  freezeVisualClockBeforeNavigation,
  VISUAL_CLOCK_TIME,
} from "../helpers/visual-clock.js";
import type { SessionState } from "../../src/domain/types.js";

test("renders the Convo Caddy shell", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: "Convo Caddy" }),
  ).toBeVisible();
  await expect(page.getByText("Prepared Questions")).toBeVisible();
});

test("renders the Frameyard visual identity and prioritizes the Teams link", async ({
  page,
}) => {
  await page.goto("/");

  const byline = page.getByText("by Frameyard", { exact: true });
  await expect(byline).toBeVisible();
  const bylineStyle = await byline.evaluate((element) => {
    const title = element.parentElement?.querySelector("h1");
    if (!title) {
      return null;
    }
    return {
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      titleGap:
        element.getBoundingClientRect().top -
        title.getBoundingClientRect().bottom,
    };
  });
  expect(bylineStyle).not.toBeNull();
  expect(bylineStyle?.fontSize).toBeGreaterThan(12);
  expect(bylineStyle?.titleGap).toBeLessThanOrEqual(4);

  expect(
    await page.locator("html").evaluate((element) => {
      return getComputedStyle(element).fontFamily;
    }),
  ).toContain("Instrument Sans");

  const capture = page.getByRole("region", { name: "Live capture" });
  const layout = await capture.evaluate((element) => {
    const primaryRow = element.querySelector(".capture-primary-row");
    const meeting = element.querySelector<HTMLInputElement>(
      "#capture-meeting-url",
    );
    const name = element.querySelector<HTMLInputElement>(
      "#capture-display-name",
    );
    const submit = element.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (!primaryRow || !meeting || !name || !submit) {
      return null;
    }

    const meetingBox = meeting.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    const submitBox = submit.getBoundingClientRect();
    return {
      primaryChildren: Array.from(primaryRow.children).map(
        (child) => child.className,
      ),
      meetingTop: meetingBox.top,
      meetingWidth: meetingBox.width,
      nameTop: nameBox.top,
      nameWidth: nameBox.width,
      submitTop: submitBox.top,
      submitBottom: submitBox.bottom,
      meetingBottom: meetingBox.bottom,
    };
  });

  expect(layout).not.toBeNull();
  expect(layout?.primaryChildren).toEqual([
    "capture-meeting-field capture-platform-field",
    "capture-meeting-field capture-primary-field",
    "primary-button capture-submit",
  ]);
  expect(layout?.meetingTop).toBeLessThan(layout?.nameTop ?? 0);
  expect(layout?.meetingWidth).toBeGreaterThan(layout?.nameWidth ?? 0);
  expect(
    Math.abs((layout?.submitTop ?? 0) - (layout?.meetingTop ?? 0)),
  ).toBeLessThan(2);
  expect(
    Math.abs((layout?.submitBottom ?? 0) - (layout?.meetingBottom ?? 0)),
  ).toBeLessThan(2);
});

test("keeps the Live Capture container plain and its input focus ring flush", async ({
  page,
}) => {
  await page.goto("/");

  const capture = page.getByRole("region", { name: "Live capture" });
  const meetingInput = page.locator("#capture-meeting-url");
  await meetingInput.focus();

  const styles = await capture.evaluate((element) => {
    const input = element.querySelector<HTMLInputElement>(
      "#capture-meeting-url",
    );
    if (!input) {
      return null;
    }
    const captureStyle = getComputedStyle(element);
    const inputStyle = getComputedStyle(input);
    return {
      captureBorderTopColor: captureStyle.borderTopColor,
      captureBorderTopWidth: captureStyle.borderTopWidth,
      captureBorderRightColor: captureStyle.borderRightColor,
      captureBorderRightWidth: captureStyle.borderRightWidth,
      inputOutlineColor: inputStyle.outlineColor,
      inputOutlineOffset: inputStyle.outlineOffset,
    };
  });

  expect(styles).not.toBeNull();
  expect(styles?.captureBorderTopColor).toBe(styles?.captureBorderRightColor);
  expect(styles?.captureBorderTopWidth).toBe(styles?.captureBorderRightWidth);
  expect(styles?.inputOutlineColor).toBe("rgb(46, 113, 88)");
  expect(styles?.inputOutlineOffset).toBe("0px");
});

test("keeps opened application diagnostics expanded across status refreshes", async ({
  page,
}) => {
  let readinessRequests = 0;
  await page.route("**/api/runtime/readiness", async (route) => {
    readinessRequests += 1;
    await route.fulfill({
      json: {
        readiness: {
          state: "ready_without_marty",
          components: {
            configuration: "ready",
            workspace: "ready",
            appServer: "ready",
            webhookServer: "ready",
            ngrok: "ready",
            hermesTunnel: "unavailable",
            hermes: "unavailable",
            capture: "ready",
          },
          diagnostics: [
            {
              component: "hermes",
              code: "hermes_unavailable",
              severity: "warning",
              message: "Assistant is unavailable.",
              action: `Readiness refresh ${readinessRequests}.`,
            },
          ],
        },
      },
    });
  });
  await page.goto("/");

  const diagnostics = page.locator("details.runtime-diagnostics");
  await diagnostics.locator("summary").click();
  await expect(diagnostics).toHaveJSProperty("open", true);
  await expect(
    page.getByText("Readiness refresh 2.", { exact: false }),
  ).toBeVisible();
  await expect(diagnostics).toHaveJSProperty("open", true);
});

test("keeps Live Capture input focus and selection across status refreshes", async ({
  page,
}) => {
  let readinessRequests = 0;
  await page.route("**/api/runtime/readiness", async (route) => {
    readinessRequests += 1;
    await route.fulfill({
      json: {
        readiness: {
          state: readinessRequests === 1 ? "ready" : "ready_without_marty",
          components: {
            configuration: "ready",
            workspace: "ready",
            appServer: "ready",
            webhookServer: "ready",
            ngrok: "ready",
            hermesTunnel: "unavailable",
            hermes: "unavailable",
            capture: "ready",
          },
          diagnostics: [],
        },
      },
    });
  });
  await page.goto("/");

  const input = page.getByLabel("Personal Microsoft Teams meeting link");
  await input.fill("https://teams.live.com/meet/interview-room");
  await input.evaluate((element) => {
    const textInput = element as HTMLInputElement;
    textInput.focus();
    textInput.setSelectionRange(8, 19, "forward");
  });
  await expect(page.getByTestId("runtime-readiness")).toHaveText(
    "Ready for capture; Assistant is unavailable",
  );

  await expect(input).toBeFocused();
  await expect(input).toHaveValue("https://teams.live.com/meet/interview-room");
  expect(
    await input.evaluate((element) => {
      const textInput = element as HTMLInputElement;
      return {
        selectionStart: textInput.selectionStart,
        selectionEnd: textInput.selectionEnd,
        selectionDirection: textInput.selectionDirection,
      };
    }),
  ).toEqual({
    selectionStart: 8,
    selectionEnd: 19,
    selectionDirection: "forward",
  });
});

test("keeps the transcript hidden until a deliberate reveal", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Must", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "More Avenues", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Revisit", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Questions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Notes", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#transcript-content")).toBeHidden();

  await page.getByRole("button", { name: "Step transcript" }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(page.locator("#transcript-content")).toBeHidden();

  await page.getByRole("button", { name: "Show transcript" }).click();
  await expect(page.locator("#transcript-content")).toBeVisible();
  await expect(
    page.getByText("Could you pick one recent customer complaint", {
      exact: false,
    }),
  ).toBeVisible();
});

test("keeps Marty input focus and selection across transcript updates", async ({
  page,
}) => {
  await page.goto("/");
  const resetResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/session/simulation/reset",
  );
  await page.getByRole("button", { name: "Reset session" }).click();
  expect((await resetResponse).ok()).toBe(true);

  const input = page.getByLabel("Command or question");
  await input.fill("What changed in the investigation?");
  const stepSucceeded = await input.evaluate(async (element) => {
    const textInput = element as HTMLInputElement;
    textInput.focus();
    textInput.setSelectionRange(5, 12, "forward");
    const response = await fetch("/api/session/simulation/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.ok;
  });
  expect(stepSucceeded).toBe(true);
  await expect(page.getByTestId("elapsed")).toHaveText("00:00:12 elapsed");

  await expect(input).toBeFocused();
  await expect(input).toHaveValue("What changed in the investigation?");
  expect(
    await input.evaluate((element) => {
      const textInput = element as HTMLInputElement;
      return {
        selectionStart: textInput.selectionStart,
        selectionEnd: textInput.selectionEnd,
        selectionDirection: textInput.selectionDirection,
      };
    }),
  ).toEqual({
    selectionStart: 5,
    selectionEnd: 12,
    selectionDirection: "forward",
  });
});

test("uses Teams lobby admission as the live-capture authorization gate", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Reset session" }).click();
  const initial = await getState(page);
  const notice = "Convo Caddy is recording and transcribing this conversation.";
  let submittedBody: unknown;
  await page.route("**/api/capture/recall/start", async (route) => {
    submittedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        kind: "accepted",
        state: {
          ...initial,
          capture: {
            mode: "recall",
            status: "joining",
            authorization: {
              method: "operator_admission",
              state: "pending",
              admittedAt: null,
            },
            notice: {
              text: notice,
              displayDurationMs: 10_000,
              delivery: "video_with_chat_fallback",
              state: "pending",
              displayedAt: null,
              clearedAt: null,
              error: null,
            },
            provider: {
              name: "recall_ai",
              region: "us-west-2",
              botId: "bot-fixture",
              recordingId: null,
            },
            meetingPlatform: "microsoft_teams_personal",
            recording: {
              location: "recall_ai",
              retention: {
                requestedMedia: "none",
                providerConfirmed: false,
                accountMetadata: "unknown",
              },
            },
            lastEventAt: "2026-08-19T04:00:00.000Z",
            error: null,
          },
        },
      }),
    });
  });

  await expect(page.getByText(notice, { exact: false })).toBeVisible();
  const startCapture = page.getByRole("button", { name: "Start live capture" });
  await page
    .getByLabel("Personal Microsoft Teams meeting link")
    .fill("https://teams.live.com/meet/123456789?p=fixture");
  await expect(startCapture).toBeEnabled();
  await startCapture.click();

  expect(submittedBody).toEqual({
    meetingPlatform: "microsoft_teams_personal",
    meetingUrl: "https://teams.live.com/meet/123456789?p=fixture",
  });
  await expect(page.getByTestId("capture-status")).toHaveText("Joining");
  await expect(page.getByTestId("authorization-status")).toHaveText(
    "Awaiting lobby admission",
  );
  await expect(page.getByTestId("notice-status")).toHaveText("Notice pending");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#transcript-content")).toBeHidden();
});

test("reuses a mutation ID when retrying after an uncertain network result", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Reset session" }).click();

  let intercepted = false;
  await page.route("**/api/input", async (route) => {
    if (intercepted) {
      await route.continue();
      return;
    }

    intercepted = true;
    await route.fetch();
    await route.abort("failed");
  });

  const input = page.getByLabel("Command or question");
  await input.fill("/question Retry without duplication?");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("/question Retry without duplication?");

  await page.unroute("**/api/input");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(input).toHaveValue("");

  const state = await getState(page);
  expect(state.questions.map((item) => item.text)).toEqual([
    "Ask a specific follow-up about: Retry without duplication?",
  ]);
});

test("completes the Phase 1 offline interview journey", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Reset session" }).click();
  await expect(page.getByTestId("elapsed")).toHaveText("00:00:00 elapsed");

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByTestId("elapsed")).toHaveText("00:00:12 elapsed");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  for (const elapsed of [
    "00:00:31 elapsed",
    "00:00:38 elapsed",
    "00:01:02 elapsed",
  ]) {
    await page.getByRole("button", { name: "Step transcript" }).click();
    await expect(page.getByTestId("elapsed")).toHaveText(elapsed);
  }

  await expect(page.locator("#transcript-content")).toBeHidden();

  const mustItem = page.getByLabel(
    "Tell me about the last time this happened.",
    {
      exact: true,
    },
  );
  await mustItem.check();
  await expect(mustItem).toBeChecked();
  await mustItem.uncheck();
  await expect(mustItem).not.toBeChecked();

  await submit(page, "/note  Preserve  my punctuation!  ");
  await submit(page, "/question why is that");
  await submit(page, "/revisit spreadsheets");

  const deterministicState = await getState(page);
  expect(deterministicState.notes[0]?.text).toBe("Preserve  my punctuation!");
  expect(deterministicState.questions[0]?.text).toBe(
    "Why did you switch from the ERP to a spreadsheet?",
  );
  expect(deterministicState.revisit[0]?.text).toBe(
    "Return to why the spreadsheet replaced the ERP workflow.",
  );
  expect(deterministicState.notes[0]?.transcriptRef.anchorTurnId).toBe(
    "turn-004",
  );

  await submit(page, "/revisit");
  await expect(
    page.getByText(
      "Return to the serial-number mismatch and how it changed the exposed lots.",
    ),
  ).toBeVisible();

  const beforeQuestion = await getState(page);
  await submit(page, "What did they say about SAP?");
  await expect(
    page.getByText(
      "The participant said formal lot records were in SAP, while the serial-number exception lived in a quality spreadsheet.",
    ),
  ).toBeVisible();
  const afterQuestion = await getState(page);
  expect(afterQuestion.topics).toEqual(beforeQuestion.topics);
  expect(afterQuestion.revisit).toEqual(beforeQuestion.revisit);
  expect(afterQuestion.questions).toEqual(beforeQuestion.questions);
  expect(afterQuestion.notes).toEqual(beforeQuestion.notes);

  const hintedRevisit = page.getByLabel(
    "Return to why the spreadsheet replaced the ERP workflow.",
    { exact: true },
  );
  await hintedRevisit.check();
  await expect(hintedRevisit).toBeChecked();
  await hintedRevisit.uncheck();
  await expect(hintedRevisit).not.toBeChecked();

  const emergentQuestion = page.getByLabel(
    "Why did you switch from the ERP to a spreadsheet?",
    { exact: true },
  );
  await emergentQuestion.check();
  await expect(emergentQuestion).toBeChecked();
  await emergentQuestion.uncheck();
  await expect(emergentQuestion).not.toBeChecked();

  await expect(page.locator("#transcript-content")).toBeHidden();
  await page.getByRole("button", { name: "Citation turn-004" }).click();
  await expect(page.locator("#transcript-content")).toBeVisible();
  await expect(
    page.getByText(
      "The complaint was in QMS and SAP had the formal lot history",
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hide transcript" }).click();

  const beforeInvalid = await getState(page);
  await submit(page, "/unknown should stay local", false);
  await expect(page.getByRole("alert")).toHaveText("Unknown command: /unknown");
  expect(await getState(page)).toEqual(beforeInvalid);

  const beforeFailure = await getState(page);
  const failureSetup = await page.request.post("/api/test/provider/fail-next", {
    data: { message: "Synthetic provider failure." },
  });
  expect(failureSetup.status()).toBe(204);
  await submit(page, "/revisit", false);
  await expect(page.getByRole("alert")).toHaveText(
    "Synthetic provider failure.",
  );
  await expect(page.getByLabel("Command or question")).toHaveValue("/revisit");
  expect(await getState(page)).toEqual(beforeFailure);

  const finalEnvelope = await getEnvelope(page);
  expect(finalEnvelope.diagnostics.providerCallCount).toBe(6);
});

async function submit(
  page: Page,
  input: string,
  expectedOk = true,
): Promise<void> {
  await page.getByLabel("Command or question").fill(input);
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/input")),
    page.getByRole("button", { name: "Submit" }).click(),
  ]);
  const result = (await response.json()) as { ok: boolean; error?: string };
  if (result.ok !== expectedOk) {
    throw new Error(`Unexpected input result: ${JSON.stringify(result)}`);
  }
}

async function getEnvelope(page: Page): Promise<{
  state: SessionState;
  diagnostics: { providerCallCount: number };
}> {
  const response = await page.request.get("/api/session");
  expect(response.ok()).toBe(true);
  return response.json();
}

async function getState(page: Page): Promise<SessionState> {
  return (await getEnvelope(page)).state;
}

for (const width of [1100, 390]) {
  test(`main textbox focus remains flush at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await freezeVisualClockBeforeNavigation(page);
    await page.goto("/");
    await expect(page.locator("#capture-meeting-url")).toBeVisible();
    await expect(page.locator("#capture-meeting-url")).toBeEnabled();
    await page
      .locator(".topbar")
      .screenshot({ path: testInfo.outputPath(`main-header-${width}.png`) });
    for (const id of [
      "capture-meeting-url",
      "capture-display-name",
      "marty-input",
    ]) {
      const field = page.locator(`#${id}`);
      await field.focus();
      await expect(field).toBeFocused();
      const style = await field.evaluate((el) => ({
        offset: getComputedStyle(el).outlineOffset,
        color: getComputedStyle(el).outlineColor,
      }));
      expect(style).toEqual({ offset: "0px", color: "rgb(46, 113, 88)" });
      await page.screenshot({
        path: testInfo.outputPath(`main-focus-${id}-${width}.png`),
      });
    }
  });
}

for (const width of [1100, 390]) {
  test(`prep chooser has visible green keyboard focus at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/workspace", (route) =>
      route.fulfill({
        json: {
          workspace: {
            root: "/synthetic/Convo Caddy Workspace",
            warning: null,
            selectedPrep: null,
            prep: {
              errors: [],
              valid: [
                {
                  basename: "synthetic.json",
                  sourceBytes: "",
                  prep: {
                    schemaVersion: 1,
                    title: "Synthetic practice",
                    plannedDurationMinutes: 30,
                    topics: [{ tier: "must", text: "Synthetic question" }],
                  },
                },
              ],
            },
            finished: { valid: [], errors: [] },
          },
        },
      }),
    );
    await freezeVisualClockBeforeNavigation(page);
    await page.goto("/");
    const field = page.getByRole("button", {
      name: "Choose prep…",
      exact: true,
    });
    await expect(field).toBeVisible();
    await expect(field).toBeEnabled();
    await field.focus();
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((el) => getComputedStyle(el).outlineColor),
    ).toBe("rgb(46, 113, 88)");
    expect(
      await field.evaluate((el) => getComputedStyle(el).outlineOffset),
    ).toBe("0px");
    await page.screenshot({
      path: testInfo.outputPath(`prep-focus-${width}.png`),
    });
  });
}

test("visual clock stays frozen across controlled app readiness", async ({
  page,
}) => {
  await freezeVisualClockBeforeNavigation(page);
  let workspaceReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    workspaceReached = resolve;
  });
  let releaseWorkspace!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseWorkspace = resolve;
  });
  await page.route("**/api/workspace", async (route) => {
    workspaceReached();
    await released;
    await route.continue();
  });
  const clockState = () =>
    page.evaluate(() => ({
      now: Date.now(),
      fired: (window as unknown as { visualClockProbe: { fired: number } })
        .visualClockProbe.fired,
    }));
  try {
    await page.goto("/");
    await reached;
    await expect(page.locator("#capture-meeting-url")).toHaveCount(0);
    // Install after navigation's clock scripts, while app startup is gated.
    // Match the app's 1s refresh deadline; zero-delay work is already due.
    await page.evaluate(() => {
      const probe = { fired: 0 };
      Object.assign(window, { visualClockProbe: probe });
      setInterval(() => {
        probe.fired++;
      }, 1_000);
    });
    expect(await clockState()).toEqual({
      now: VISUAL_CLOCK_TIME,
      fired: 0,
    });
    releaseWorkspace();
    await expect(page.locator("#capture-meeting-url")).toBeVisible();
    await expect(page.locator("#capture-meeting-url")).toBeEnabled();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    expect(await clockState()).toEqual({
      now: VISUAL_CLOCK_TIME,
      fired: 0,
    });
    // Advance virtual time to either side of the actual refresh deadline.
    await page.clock.runFor(999);
    expect(await clockState()).toEqual({
      now: VISUAL_CLOCK_TIME + 999,
      fired: 0,
    });
    await page.clock.runFor(1);
    expect(await clockState()).toEqual({
      now: VISUAL_CLOCK_TIME + 1_000,
      fired: 1,
    });
  } finally {
    releaseWorkspace();
  }
});
