import { describe, expect, it, vi } from "vitest";
import type {
  CaptureProvider,
  CreateCaptureBotInput,
  RetrieveCaptureBotResult,
} from "../../src/server/capture/capture-provider.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import type {
  MutationReceipt,
  PersistedSession,
  SessionRepository,
} from "../../src/server/persistence/file-session-repository.js";
import { SessionService } from "../../src/server/session-service.js";
import { createSessionState } from "../helpers/session-state.js";

const botId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000099";

describe("one-shot Recall restart reconciliation", () => {
  it("reads one stored bot once, ingests terminal proof, and never creates a replacement", async () => {
    const captureProvider = new ReconciliationCaptureProvider({
      botId,
      operationId,
      observations: [
        observation("ended", "call_ended", 4),
        observation("ended", "transcript_done", 5, "recording-1"),
        observation("ended", "recording_done", 5, "recording-1"),
        observation("ended", "bot_done", 6),
      ],
    });
    const persisted = activeRecallSession();
    const service = new SessionService({
      topics: persisted.state.topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      repository: new MemorySessionRepository(persisted),
      clock: { now: () => new Date("2026-08-25T12:00:10.000Z") },
    });

    await expect(service.reconcileRecallCapture()).resolves.toEqual({
      kind: "reconciled",
      observations: 4,
    });
    await expect(service.reconcileRecallCapture()).resolves.toEqual({
      kind: "already_attempted",
    });
    expect(captureProvider.retrieveBot).toHaveBeenCalledOnce();
    expect(captureProvider.createBot).not.toHaveBeenCalled();
    expect(service.getSnapshot().lifecycle.providerMilestones).toEqual({
      callEndedAt: "2026-08-25T12:00:04.000Z",
      transcriptDoneAt: "2026-08-25T12:00:05.000Z",
      recordingDoneAt: "2026-08-25T12:00:05.000Z",
      botDoneAt: "2026-08-25T12:00:06.000Z",
      providerErrorAt: null,
    });
  });

  it("never clears a recording notice remotely while reconciling retrieved active state", async () => {
    const captureProvider = new ReconciliationCaptureProvider({
      botId,
      operationId,
      observations: [
        {
          botId,
          operationId,
          recordingId: "recording-1",
          status: "recording",
          milestone: null,
          occurredAt: "2026-08-25T12:00:04.000Z",
        },
      ],
    });
    const persisted = activeRecallSession();
    if (persisted.state.capture.mode !== "recall") {
      throw new Error("Expected Recall state.");
    }
    persisted.state.capture.status = "joining";
    persisted.state.capture.authorization = {
      method: "operator_admission",
      state: "pending",
      admittedAt: null,
    };
    persisted.state.capture.notice = {
      text: "Convo Caddy is recording and transcribing this conversation.",
      displayDurationMs: 10_000,
      delivery: "video_with_chat_fallback",
      state: "pending",
      displayedAt: null,
      clearedAt: null,
      error: null,
    };
    const service = new SessionService({
      topics: persisted.state.topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      repository: new MemorySessionRepository(persisted),
      clock: { now: () => new Date("2026-08-25T12:00:20.000Z") },
      recallCaptureAvailable: false,
      noticeTimers: {
        setTimeout(callback) {
          callback();
          return 1;
        },
        clearTimeout() {},
      },
    });

    await expect(service.reconcileRecallCapture()).resolves.toEqual({
      kind: "reconciled",
      observations: 1,
    });
    await Promise.resolve();
    service.setRecallCaptureAvailable(true);
    await Promise.resolve();
    expect(captureProvider.stopRecordingNotice).not.toHaveBeenCalled();
    expect(captureProvider.createBot).not.toHaveBeenCalled();
  });

  it("blocks safely without a read when a persisted operation has no bot ID", async () => {
    const captureProvider = new ReconciliationCaptureProvider({
      botId,
      operationId,
      observations: [],
    });
    const state = activeRecallSession();
    if (state.state.capture.mode !== "recall") {
      throw new Error("Expected Recall state.");
    }
    state.state.capture.provider.botId = null;
    const service = new SessionService({
      topics: state.state.topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      repository: new MemorySessionRepository(state),
    });

    await expect(service.reconcileRecallCapture()).resolves.toEqual({
      kind: "needs_attention",
      diagnostic: "recall_bot_id_missing",
    });
    expect(captureProvider.retrieveBot).not.toHaveBeenCalled();
    expect(captureProvider.createBot).not.toHaveBeenCalled();
  });

  it("does not read Recall again when saved terminal proof is already complete", async () => {
    const captureProvider = new ReconciliationCaptureProvider({
      botId,
      operationId,
      observations: [],
    });
    const persisted = activeRecallSession();
    persisted.state.lifecycle.providerMilestones = {
      callEndedAt: "2026-08-25T12:00:04.000Z",
      transcriptDoneAt: "2026-08-25T12:00:05.000Z",
      recordingDoneAt: null,
      botDoneAt: "2026-08-25T12:00:06.000Z",
      providerErrorAt: null,
    };
    const service = new SessionService({
      topics: persisted.state.topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      repository: new MemorySessionRepository(persisted),
    });

    await expect(service.reconcileRecallCapture()).resolves.toEqual({
      kind: "not_needed",
    });
    expect(captureProvider.retrieveBot).not.toHaveBeenCalled();
    expect(captureProvider.createBot).not.toHaveBeenCalled();
  });
});

function observation(
  status: "ended",
  milestone: "call_ended" | "transcript_done" | "recording_done" | "bot_done",
  second: number,
  recordingId: string | null = null,
) {
  return {
    botId,
    operationId,
    recordingId,
    status,
    milestone,
    occurredAt: `2026-08-25T12:00:0${second}.000Z`,
  } as const;
}

function activeRecallSession(): PersistedSession {
  const state = createSessionState({
    sessionId: "recall-recovery-session",
    startedAt: "2026-08-25T12:00:00.000Z",
    capture: {
      mode: "recall",
      operationId,
      status: "recording",
      authorization: {
        method: "operator_admission",
        state: "confirmed",
        admittedAt: "2026-08-25T12:00:01.000Z",
      },
      notice: {
        text: "Convo Caddy is recording and transcribing this conversation.",
        displayDurationMs: 10_000,
        delivery: "video_with_chat_fallback",
        state: "cleared",
        displayedAt: "2026-08-25T12:00:01.000Z",
        clearedAt: "2026-08-25T12:00:11.000Z",
        error: null,
      },
      provider: {
        name: "recall_ai",
        region: "us-west-2",
        botId,
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
      lastEventAt: "2026-08-25T12:00:01.000Z",
      error: null,
    },
  });
  return { state, mutations: [] };
}

class ReconciliationCaptureProvider implements CaptureProvider {
  readonly region = "us-west-2" as const;
  readonly createBot = vi.fn(
    async (_input: CreateCaptureBotInput): Promise<{ botId: string }> => ({
      botId,
    }),
  );
  readonly retrieveBot = vi.fn(
    async (): Promise<RetrieveCaptureBotResult> => this.result,
  );

  constructor(private readonly result: RetrieveCaptureBotResult) {}

  readonly stopRecordingNotice = vi.fn(
    async (_botId: string): Promise<void> => undefined,
  );
}

class MemorySessionRepository implements SessionRepository {
  readonly dataRoot = "/private/recall-reconciliation-test";

  constructor(private persisted: PersistedSession) {}

  load(): PersistedSession {
    return structuredClone(this.persisted);
  }

  save(state: PersistedSession["state"], mutations: MutationReceipt[]): void {
    this.persisted = { state: structuredClone(state), mutations };
  }
}
