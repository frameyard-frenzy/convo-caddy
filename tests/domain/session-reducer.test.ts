import { describe, expect, it } from "vitest";
import { reduceSession } from "../../src/domain/session-reducer.js";
import { createInitialSessionLifecycle } from "../../src/domain/session-lifecycle.js";
import type {
  CaptureState,
  CheckableItem,
  NoteItem,
  SessionState,
  TranscriptRef,
} from "../../src/domain/types.js";

const transcriptRef: TranscriptRef = {
  anchorTurnId: null,
  windowTurnIds: [],
  capturedAt: "2026-08-18T16:00:05.000Z",
  relativeMs: 5_000,
};

function createState(): SessionState {
  return {
    sessionId: "session-1",
    startedAt: "2026-08-18T16:00:00.000Z",
    elapsedMs: 5_000,
    topics: [
      { id: "case", tier: "must", text: "Select one case.", checked: false },
    ],
    revisit: [],
    questions: [],
    notes: [],
    transcript: [],
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
    simulation: { status: "idle", cursor: 0, speed: 20 },
  };
}

function checkable(id: string, text: string): CheckableItem {
  return {
    id,
    text,
    checked: false,
    createdAt: transcriptRef.capturedAt,
    relativeMs: transcriptRef.relativeMs,
    transcriptRef,
  };
}

describe("reduceSession", () => {
  it("checks and restores a Prepared topic without changing the input state", () => {
    const initial = createState();
    const checked = reduceSession(initial, {
      type: "topic.setChecked",
      topicId: "case",
      checked: true,
    });
    const restored = reduceSession(checked, {
      type: "topic.setChecked",
      topicId: "case",
      checked: false,
    });

    expect(initial.topics[0]?.checked).toBe(false);
    expect(checked.topics[0]?.checked).toBe(true);
    expect(restored.topics[0]?.checked).toBe(false);
  });

  it("adds, checks, and restores a Revisit item", () => {
    const added = reduceSession(createState(), {
      type: "revisit.add",
      item: checkable("revisit-1", "Return to the lot mismatch."),
    });
    const checked = reduceSession(added, {
      type: "revisit.setChecked",
      itemId: "revisit-1",
      checked: true,
    });
    const restored = reduceSession(checked, {
      type: "revisit.setChecked",
      itemId: "revisit-1",
      checked: false,
    });

    expect(added.revisit).toHaveLength(1);
    expect(checked.revisit[0]?.checked).toBe(true);
    expect(restored.revisit[0]?.checked).toBe(false);
  });

  it("adds, checks, and restores a Question item", () => {
    const added = reduceSession(createState(), {
      type: "question.add",
      item: checkable("question-1", "Who approved containment?"),
    });
    const checked = reduceSession(added, {
      type: "question.setChecked",
      itemId: "question-1",
      checked: true,
    });
    const restored = reduceSession(checked, {
      type: "question.setChecked",
      itemId: "question-1",
      checked: false,
    });

    expect(added.questions).toHaveLength(1);
    expect(checked.questions[0]?.checked).toBe(true);
    expect(restored.questions[0]?.checked).toBe(false);
  });

  it("keeps Notes separate and non-checkable", () => {
    const note: NoteItem = {
      id: "note-1",
      text: "Customer clock drove the decision.",
      createdAt: transcriptRef.capturedAt,
      relativeMs: transcriptRef.relativeMs,
      transcriptRef,
    };
    const result = reduceSession(createState(), { type: "note.add", note });

    expect(result.notes).toEqual([note]);
    expect(result.notes[0]).not.toHaveProperty("checked");
    expect(result.questions).toEqual([]);
    expect(result.revisit).toEqual([]);
  });

  it("records an operator-admission boundary without changing interview content", () => {
    const capture: CaptureState = {
      mode: "recall",
      status: "joining",
      authorization: {
        method: "operator_admission",
        state: "pending",
        admittedAt: null,
      },
      notice: {
        text: "Convo Caddy is recording and transcribing this conversation.",
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
        botId: "bot-1",
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
      lastEventAt: "2026-08-18T16:00:05.000Z",
      error: null,
    };

    const initial = createState();
    const result = reduceSession(initial, { type: "capture.set", capture });

    expect(result.capture).toEqual(capture);
    expect(result.transcript).toEqual(initial.transcript);
    expect(result.topics).toEqual(initial.topics);
  });
});
