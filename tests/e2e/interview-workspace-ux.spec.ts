import { expect, test } from "@playwright/test";
import type { WorkspaceOverview } from "../../src/client/api.js";
import type { SessionState } from "../../src/domain/types.js";

const finishedWorkspace: WorkspaceOverview = {
  root: "/synthetic/Convo Caddy Workspace",
  warning: null,
  selectedPrep: null,
  prep: { valid: [], errors: [] },
  finished: {
    valid: [
      { name: "2026-09-18-alpha", markdown: "# Alpha conversation" },
      { name: "2026-09-18-beta", markdown: "# Beta conversation" },
    ],
    errors: [],
  },
};

test("citation context visibly filters the transcript and clear keeps the live full transcript open", async ({
  page,
}, testInfo) => {
  let readinessRequests = 0;
  await page.route("**/api/runtime/readiness", (route) => {
    readinessRequests += 1;
    return route.fulfill({ json: { readiness: null } });
  });
  const response = await page.request.get("/api/session");
  const envelope = (await response.json()) as { state: SessionState };
  const referenceA = {
    anchorTurnId: "turn-a",
    windowTurnIds: ["turn-a"],
    capturedAt: "2026-09-18T12:00:12.000Z",
    relativeMs: 12_000,
  };
  const referenceB = {
    ...referenceA,
    anchorTurnId: "turn-b",
    windowTurnIds: ["turn-b"],
  };
  const referenceBoth = {
    ...referenceA,
    anchorTurnId: "turn-b",
    windowTurnIds: ["turn-a", "turn-b"],
  };
  let state: SessionState = {
    ...envelope.state,
    elapsedMs: 12_000,
    transcript: [
      {
        id: "turn-a",
        speakerId: "participant",
        speakerLabel: "Synthetic participant",
        text: "The inspection changed our decision.",
        startedAtMs: 5_000,
        endedAtMs: 9_000,
        receivedAt: "2026-09-18T12:00:09.000Z",
        final: true,
      },
      {
        id: "turn-b",
        speakerId: "interviewer",
        speakerLabel: "Interviewer",
        text: "What evidence made the difference?",
        startedAtMs: 10_000,
        endedAtMs: 12_000,
        receivedAt: "2026-09-18T12:00:12.000Z",
        final: true,
      },
    ],
    notes: [
      {
        id: "note-a",
        text: "Synthetic evidence marker",
        createdAt: "2026-09-18T12:00:12.000Z",
        relativeMs: 12_000,
        transcriptRef: referenceA,
      },
    ],
    questions: [
      {
        id: "question-a",
        text: "Why did that change?",
        checked: false,
        createdAt: "2026-09-18T12:00:12.000Z",
        relativeMs: 12_000,
        transcriptRef: referenceB,
      },
    ],
    revisit: [
      {
        id: "revisit-a",
        text: "Return to the changed decision.",
        checked: false,
        createdAt: "2026-09-18T12:00:12.000Z",
        relativeMs: 12_000,
        transcriptRef: referenceBoth,
      },
    ],
    chat: [
      {
        id: "chat-a",
        question: "What changed?",
        response: "The inspection changed the decision.",
        error: null,
        citationTurnIds: ["turn-b"],
        createdAt: "2026-09-18T12:00:12.000Z",
        relativeMs: 12_000,
      },
    ],
    simulation: { status: "paused", cursor: 2, speed: 20 },
  };
  await page.route("**/api/events", (route) => route.abort());
  await page.route("**/api/session/content/open", (route) =>
    route.fulfill({ json: { state } }),
  );
  await page.route("**/api/session/simulation/step", (route) => {
    const ordinal = state.transcript.length + 1;
    state = {
      ...state,
      elapsedMs: state.elapsedMs + 1_000,
      transcript: [
        ...state.transcript,
        {
          id: `turn-${ordinal}`,
          speakerId: "participant",
          speakerLabel: "Synthetic participant",
          text: `New synthetic testimony ${ordinal}.`,
          startedAtMs: state.elapsedMs,
          endedAtMs: state.elapsedMs + 1_000,
          receivedAt: "2026-09-18T12:00:13.000Z",
          final: true,
        },
      ],
    };
    return route.fulfill({ json: { state } });
  });
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { ...envelope, state } }),
  );
  await page.goto("/");

  const transcript = page.getByRole("region", { name: "Transcript" });
  const visibleTurnIds = () =>
    transcript
      .locator(".transcript-turn")
      .evaluateAll((turns) =>
        turns.map((turn) => turn.id.replace(/^transcript-/, "")),
      );
  const filterStatus = transcript.getByText("Filtered", {
    exact: true,
  });
  const clear = transcript.getByRole("button", {
    name: "Clear filter",
    exact: true,
  });
  const disclosure = transcript.locator("#transcript-disclosure");
  let fullIds = ["turn-a", "turn-b"];
  await transcript
    .getByRole("button", { name: "Show transcript", exact: true })
    .click();
  await expect.poll(visibleTurnIds).toEqual(fullIds);

  const evidenceRoutes = [
    {
      name: "Note context",
      control: page.locator(".notes .context-button").first(),
      expectedIds: ["turn-a"],
    },
    {
      name: "Question context",
      control: page.locator(".questions .context-button").first(),
      expectedIds: ["turn-b"],
    },
    {
      name: "Revisit context",
      control: page.locator(".revisit .context-button").first(),
      expectedIds: ["turn-a", "turn-b"],
    },
    {
      name: "Assistant citation",
      control: page.locator(".marty .context-button").first(),
      expectedIds: ["turn-b"],
    },
  ];

  for (const [index, route] of evidenceRoutes.entries()) {
    await expect(filterStatus, `${route.name} starts unfiltered`).toHaveCount(
      0,
    );
    await expect.poll(visibleTurnIds).toEqual(fullIds);
    await route.control.click();
    await expect(filterStatus).toBeVisible();
    await expect.poll(visibleTurnIds).toEqual(route.expectedIds);

    if (index === 0) {
      await page.getByRole("button", { name: "Step transcript" }).click();
      fullIds = [...fullIds, "turn-3"];
      await expect.poll(visibleTurnIds).toEqual(route.expectedIds);
      await expect(filterStatus).toBeVisible();
    }

    if (index < evidenceRoutes.length - 1) {
      await clear.click();
      await expect(filterStatus).toHaveCount(0);
      await expect(page.locator("#transcript-content")).toBeVisible();
      await expect(disclosure).toBeFocused();
      await expect.poll(visibleTurnIds).toEqual(fullIds);
      continue;
    }

    await expect(clear).toBeVisible();
    for (const [viewportIndex, width] of [1100, 390].entries()) {
      if (viewportIndex > 0) {
        await expect(filterStatus).toHaveCount(0);
        await expect.poll(visibleTurnIds).toEqual(fullIds);
        await route.control.click();
        await expect(filterStatus).toBeVisible();
        await expect.poll(visibleTurnIds).toEqual(route.expectedIds);
      }
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: testInfo.outputPath(`filtered-transcript-${width}.png`),
        fullPage: true,
      });

      await disclosure.focus();
      await page.keyboard.press("Tab");
      await expect(clear).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath(`focused-transcript-${width}.png`),
        fullPage: true,
      });
      expect(
        await page
          .locator(".transcript-turn")
          .first()
          .evaluate((el) => getComputedStyle(el).borderTopWidth),
      ).toBe("0px");
      const focusedClear = await clear.elementHandle();
      expect(focusedClear).not.toBeNull();
      const requestsBeforeRefresh = readinessRequests;
      await expect
        .poll(() => readinessRequests)
        .toBeGreaterThan(requestsBeforeRefresh);
      await expect
        .poll(() => focusedClear?.evaluate((element) => !element.isConnected))
        .toBe(true);
      await expect(clear).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(filterStatus).toHaveCount(0);
      await expect(page.locator("#transcript-content")).toBeVisible();
      await expect(disclosure).toBeFocused();
      await expect.poll(visibleTurnIds).toEqual(fullIds);
      await page.screenshot({
        path: testInfo.outputPath(`full-transcript-${width}.png`),
        fullPage: true,
      });
    }
  }

  await page.getByRole("button", { name: "Step transcript" }).click();
  fullIds = [...fullIds, "turn-4"];
  await expect.poll(visibleTurnIds).toEqual(fullIds);
  await expect(page.locator("#transcript-content")).toBeVisible();
});

test("History shows only the latest completed name for empty, single and many unsorted records", async ({
  page,
}) => {
  await page.route("**/api/events", (route) => route.abort());
  await page.route("**/api/workspace", (route) =>
    route.fulfill({ json: { workspace: finishedWorkspace } }),
  );
  let sessions: object[] = [];
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: { sessions } }),
  );
  await page.goto("/");
  await expect(page.locator(".session-history-item")).toHaveCount(0);
  sessions = [
    {
      sessionId: "latest",
      displayName: "Latest café",
      startedAt: "2026-09-01T12:00:00Z",
      completedAt: "2026-09-20T12:00:00Z",
      lifecycle: "completed",
    },
  ];
  await page.reload();
  await expect(page.locator(".session-history-item")).toHaveText([
    "Latest café",
  ]);
  sessions = [
    ...Array.from({ length: 40 }, (_, i) => ({
      sessionId: String(i),
      displayName: `Older ${i}`,
      startedAt: "2026-09-19T12:00:00Z",
      completedAt: "2026-09-19T13:00:00Z",
      lifecycle: "completed",
    })),
    ...sessions,
  ];
  sessions.splice(20, 0, sessions.pop()!);
  await page.reload();
  await expect(page.locator(".session-history-item")).toHaveText([
    "Latest café",
  ]);
  await expect(page.locator(".finished-records details")).toHaveCount(0);
});

for (const width of [1100, 390]) {
  test(`workspace actions, edit status and saved-interview lifecycle form one top group at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.route("**/api/workspace", (route) =>
      route.fulfill({ json: { workspace: finishedWorkspace } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    const top = page.getByRole("region", { name: "Workspace and prep" });
    await expect(top.locator(".workspace-actions")).toContainText(
      "Choose prep",
    );
    await expect(top.locator(".workspace-actions")).toContainText("Save");
    await expect(top.locator(".workspace-lifecycle")).toContainText(
      "Saved interviews",
    );
    await expect(page.locator(".app-shell > .session-lifecycle")).toHaveCount(
      0,
    );
    await expect(top.locator("details.finished-records")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`workspace-${width}.png`),
      fullPage: true,
    });
  });
}

test("save actions have an eight-pixel status gap and no-workspace state retains the top lifecycle", async ({
  page,
}) => {
  await page.route("**/api/events", (route) => route.abort());
  let workspacePayload: WorkspaceOverview = {
    ...finishedWorkspace,
    selectedPrep: "synthetic.md",
    selectedPrepDisplayName: "synthetic.md",
    prep: {
      errors: [],
      valid: [
        {
          basename: "synthetic.md",
          sourceBytes: "# Synthetic interview",
          prep: {
            schemaVersion: 1,
            title: "Synthetic interview",
            plannedDurationMinutes: 30,
            topics: [],
          },
        },
      ],
    },
  };
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: { workspace: workspacePayload },
    }),
  );
  let recallState: Record<string, unknown> | null = null;
  await page.route("**/api/session/content/open", async (route) => {
    await expect.poll(() => recallState).not.toBeNull();
    await route.fulfill({ json: { state: recallState } });
  });
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const envelope = (await response.json()) as {
      state: Record<string, unknown> & {
        lifecycle: Record<string, unknown>;
      };
    };
    envelope.state.capture = {
      mode: "recall",
      status: "recording",
      authorization: {
        method: "operator_admission",
        state: "confirmed",
        admittedAt: "2026-09-18T12:00:00.000Z",
      },
      notice: {
        text: "Convo Caddy is recording and transcribing this conversation.",
        displayDurationMs: 10_000,
        delivery: "video_with_chat_fallback",
        state: "displaying",
        displayedAt: "2026-09-18T12:00:00.000Z",
        clearedAt: null,
        error: null,
      },
      provider: {
        name: "recall_ai",
        region: "us-west-2",
        botId: "synthetic-bot",
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
      lastEventAt: "2026-09-18T12:00:00.000Z",
      error: null,
    };
    envelope.state.lifecycle = {
      ...envelope.state.lifecycle,
      finalization: { state: "pending" },
    };
    recallState = envelope.state;
    await route.fulfill({ json: envelope });
  });
  const editStatusGap = () =>
    page.locator(".workspace-prep").evaluate((section) => {
      const actions = section.querySelector(".workspace-actions");
      const status = section.querySelector(".workspace-edit-status");
      if (!actions || !status) return null;
      return (
        status.getBoundingClientRect().top -
        actions.getBoundingClientRect().bottom
      );
    });
  const selectedWorkspace = workspacePayload;
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    workspacePayload = selectedWorkspace;
    await page.goto("/");
    const selectedGap = await editStatusGap();
    expect(selectedGap).toBeGreaterThanOrEqual(7);
    expect(selectedGap).toBeLessThanOrEqual(9);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    workspacePayload = {
      ...selectedWorkspace,
      selectedPrep: null,
      selectedPrepDisplayName: null,
      prep: { valid: [], errors: [] },
    };
    await page.reload();
    const unselectedGap = await editStatusGap();
    expect(unselectedGap).toBeGreaterThanOrEqual(7);
    expect(unselectedGap).toBeLessThanOrEqual(9);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }

  await page.route("**/api/workspace", (route) =>
    route.fulfill({ json: { workspace: null } }),
  );
  await page.reload();
  const fallback = page.getByRole("region", { name: "Workspace" });
  await expect(fallback.locator(".workspace-lifecycle")).toContainText(
    "Saved interviews",
  );
});
