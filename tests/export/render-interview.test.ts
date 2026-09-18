import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionState } from "../../src/domain/types.js";
import { createInitialSessionLifecycle } from "../../src/domain/session-lifecycle.js";
import { renderInterview } from "../../src/server/export/render-interview.js";

describe("renderInterview", () => {
  it("inserts deterministic marks at their referenced transcript moments", () => {
    const expected = readFileSync(
      new URL("../fixtures/expected-interview.md", import.meta.url),
      "utf8",
    );

    expect(renderInterview(createState())).toBe(expected);
  });

  it("rejects a reference to a transcript turn that does not exist", () => {
    const state = createState();
    const note = state.notes[0];
    if (!note) {
      throw new Error("Expected the render fixture to contain a note.");
    }
    note.transcriptRef.anchorTurnId = "missing-turn";

    expect(() => renderInterview(state)).toThrow(
      'Note "note-1" references missing transcript turn "missing-turn"',
    );
  });
});

function createState(): SessionState {
  return {
    sessionId: "session-1",
    startedAt: "2026-08-18T16:00:00.000Z",
    elapsedMs: 7_000,
    topics: [],
    notes: [
      {
        id: "note-1",
        text: "Exact note.",
        createdAt: "2026-08-18T16:00:04.000Z",
        relativeMs: 4_000,
        transcriptRef: reference("turn-1", ["turn-1"], 4_000),
      },
    ],
    revisit: [
      {
        id: "revisit-1",
        text: "Confirm SAP owner.",
        checked: false,
        createdAt: "2026-08-18T16:00:04.000Z",
        relativeMs: 4_000,
        transcriptRef: reference("turn-1", ["turn-1"], 4_000),
      },
    ],
    questions: [
      {
        id: "question-before",
        text: "Opening question?",
        checked: false,
        createdAt: "2026-08-18T16:00:00.000Z",
        relativeMs: 0,
        transcriptRef: reference(null, [], 0),
      },
      {
        id: "question-1",
        text: "Who approved it?",
        checked: true,
        createdAt: "2026-08-18T16:00:07.000Z",
        relativeMs: 7_000,
        transcriptRef: reference("turn-2", ["turn-1", "turn-2"], 7_000),
      },
    ],
    transcript: [
      {
        id: "turn-1",
        providerEventId: "fixture-1",
        speakerId: "participant",
        speakerLabel: "Participant",
        text: "The serial number did not join.\nSecond line.",
        startedAtMs: 1_000,
        endedAtMs: 4_000,
        receivedAt: "2026-08-18T16:00:04.000Z",
        final: true,
      },
      {
        id: "turn-2",
        providerEventId: "fixture-2",
        speakerId: "interviewer",
        speakerLabel: "Interviewer",
        text: "Who owned the reconciliation?",
        startedAtMs: 5_000,
        endedAtMs: 7_000,
        receivedAt: "2026-08-18T16:00:07.000Z",
        final: true,
      },
    ],
    chat: [],
    capture: {
      mode: "simulation",
      authorization: {
        method: "not_required_synthetic",
        state: "not_required",
        admittedAt: null,
      },
      recording: { location: null, retention: null },
    },
    lifecycle: createInitialSessionLifecycle("simulation"),
    simulation: { status: "complete", cursor: 2, speed: 20 },
  };
}

function reference(
  anchorTurnId: string | null,
  windowTurnIds: string[],
  relativeMs: number,
) {
  return {
    anchorTurnId,
    windowTurnIds,
    capturedAt: new Date(
      Date.parse("2026-08-18T16:00:00.000Z") + relativeMs,
    ).toISOString(),
    relativeMs,
  };
}
