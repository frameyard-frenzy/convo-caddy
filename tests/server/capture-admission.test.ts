import request from "supertest";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import type { SessionState } from "../../src/domain/types.js";
import {
  PARTICIPANT_RECORDING_NOTICE,
  type PreparedTopic,
} from "../../src/domain/types.js";
import { createApp } from "../../src/server/app.js";
import type {
  CaptureProvider,
  CreateCaptureBotInput,
} from "../../src/server/capture/capture-provider.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import type {
  MutationReceipt,
  PersistedSession,
  SessionRepository,
} from "../../src/server/persistence/file-session-repository.js";
import { SessionService } from "../../src/server/session-service.js";

const meetingUrl = "https://teams.live.com/meet/123456789?p=fixture";
const topics: PreparedTopic[] = [
  { id: "case", tier: "must", text: "Select one case.", checked: false },
];

describe("operator-admitted Recall capture", () => {
  it("sends the bot to the lobby without requiring a phrase or consent checkbox", async () => {
    const captureProvider = new RecordingCaptureProvider();
    const service = new SessionService({
      topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      clock: new FixedClock("2026-08-20T16:00:00.000Z"),
      createId: () => "session-fixture",
    });

    const response = await request(createApp({ service }))
      .post("/api/capture/recall/start")
      .send({ meetingUrl });

    expect(response.status).toBe(201);
    expect(captureProvider.lastInput).toMatchObject({ meetingUrl });
    expect(captureProvider.lastInput).not.toHaveProperty("consentNotice");
    expect(response.body.state.capture).toMatchObject({
      mode: "recall",
      status: "joining",
      authorization: {
        method: "operator_admission",
        state: "pending",
        admittedAt: null,
      },
      notice: {
        text: PARTICIPANT_RECORDING_NOTICE,
        displayDurationMs: 10_000,
        state: "pending",
      },
    });
  });

  it("rejects the removed phrase-gate payload instead of preserving a legacy path", async () => {
    const captureProvider = new RecordingCaptureProvider();
    const service = new SessionService({
      topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
    });

    const response = await request(createApp({ service }))
      .post("/api/capture/recall/start")
      .send({
        meetingUrl,
        consentConfirmed: true,
        consentNotice:
          "With your permission, a bot will record and transcript this conversation.",
      });

    expect(response.status).toBe(400);
    expect(captureProvider.lastInput).toBeNull();
  });

  it("confirms authorization on admission and clears the video notice after ten seconds", async () => {
    const captureProvider = new RecordingCaptureProvider();
    const clock = new FixedClock("2026-08-20T16:00:00.000Z");
    const noticeTimers = new ManualNoticeTimers();
    const service = new SessionService({
      topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      clock,
      noticeTimers,
      createId: () => "session-fixture",
    });
    const started = await service.startRecallCapture({ meetingUrl });
    expect(started.ok).toBe(true);

    expect(
      service.ingestRecallLifecycle({
        botId: "bot-fixture-1",
        recordingId: null,
        status: "in_call",
        milestone: null,
        occurredAt: "2026-08-20T16:00:05.000Z",
      }),
    ).toBe("accepted");
    expect(service.getSnapshot().capture).toMatchObject({
      authorization: {
        method: "operator_admission",
        state: "confirmed",
        admittedAt: "2026-08-20T16:00:05.000Z",
      },
      notice: {
        state: "displaying",
        displayedAt: "2026-08-20T16:00:05.000Z",
      },
    });
    expect(noticeTimers.delayMs).toBe(10_000);
    expect(captureProvider.stoppedNoticeBotIds).toEqual([]);

    clock.advance(15_000);
    noticeTimers.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(captureProvider.stoppedNoticeBotIds).toEqual(["bot-fixture-1"]);
    expect(service.getSnapshot().capture).toMatchObject({
      notice: {
        state: "cleared",
        displayedAt: "2026-08-20T16:00:05.000Z",
        clearedAt: "2026-08-20T16:00:15.000Z",
      },
    });
  });

  it("cancels a pending notice timer when the session service closes", async () => {
    const captureProvider = new RecordingCaptureProvider();
    const noticeTimers = new ManualNoticeTimers();
    const service = new SessionService({
      topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      noticeTimers,
    });
    await service.startRecallCapture({ meetingUrl });
    service.ingestRecallLifecycle({
      botId: "bot-fixture-1",
      recordingId: null,
      status: "in_call",
      milestone: null,
      occurredAt: "2026-08-20T16:00:05.000Z",
    });

    service.close();
    service.close();

    expect(noticeTimers.callback).toBeNull();
    expect(noticeTimers.delayMs).toBeNull();
    expect(captureProvider.stoppedNoticeBotIds).toEqual([]);
  });

  it("does not mutate state when a notice clear finishes after close", async () => {
    const captureProvider = new DeferredNoticeCaptureProvider();
    const noticeTimers = new ManualNoticeTimers();
    const service = new SessionService({
      topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      noticeTimers,
    });
    await service.startRecallCapture({ meetingUrl });
    service.ingestRecallLifecycle({
      botId: "bot-fixture-1",
      recordingId: null,
      status: "in_call",
      milestone: null,
      occurredAt: "2026-08-20T16:00:05.000Z",
    });
    noticeTimers.run();
    const beforeClose = service.getSnapshot();

    service.close();
    captureProvider.resolveNoticeClear();
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getSnapshot()).toEqual(beforeClose);
  });

  it("surfaces a notice-clear failure without pretending the card disappeared", async () => {
    const captureProvider = new RecordingCaptureProvider(true);
    const clock = new FixedClock("2026-08-20T16:00:00.000Z");
    const noticeTimers = new ManualNoticeTimers();
    const service = new SessionService({
      topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      clock,
      noticeTimers,
    });
    await service.startRecallCapture({ meetingUrl });
    service.ingestRecallLifecycle({
      botId: "bot-fixture-1",
      recordingId: null,
      status: "in_call",
      milestone: null,
      occurredAt: "2026-08-20T16:00:05.000Z",
    });

    clock.advance(15_000);
    noticeTimers.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getSnapshot().capture).toMatchObject({
      notice: {
        state: "failed",
        displayedAt: "2026-08-20T16:00:05.000Z",
        clearedAt: null,
        error:
          "The ten-second recording notice could not be cleared. Remove the bot and end the call.",
      },
    });
  });

  it("keeps a remotely cleared notice visible as cleared when the local save fails", async () => {
    const captureProvider = new RecordingCaptureProvider();
    const clock = new FixedClock("2026-08-20T16:00:00.000Z");
    const noticeTimers = new ManualNoticeTimers();
    const repository = new FailingNoticeSaveRepository(5);
    const service = new SessionService({
      topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      clock,
      noticeTimers,
      repository,
    });
    await service.startRecallCapture({ meetingUrl });
    service.ingestRecallLifecycle({
      botId: "bot-fixture-1",
      recordingId: null,
      status: "in_call",
      milestone: null,
      occurredAt: "2026-08-20T16:00:05.000Z",
    });

    clock.advance(15_000);
    noticeTimers.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(captureProvider.stoppedNoticeBotIds).toEqual(["bot-fixture-1"]);
    expect(service.getSnapshot().capture).toMatchObject({
      notice: { state: "cleared" },
      error:
        "The recording notice cleared remotely, but that result could not be saved. Restart recovery will reconcile it again.",
    });
  });
});

class RecordingCaptureProvider implements CaptureProvider {
  readonly region = "us-west-2" as const;
  lastInput: CreateCaptureBotInput | null = null;
  stoppedNoticeBotIds: string[] = [];

  constructor(private readonly failNoticeStop = false) {}

  async createBot(input: CreateCaptureBotInput): Promise<{ botId: string }> {
    this.lastInput = input;
    return { botId: "bot-fixture-1" };
  }

  async stopRecordingNotice(botId: string): Promise<void> {
    this.stoppedNoticeBotIds.push(botId);
    if (this.failNoticeStop) {
      throw new Error("synthetic notice failure");
    }
  }
}

class DeferredNoticeCaptureProvider implements CaptureProvider {
  readonly region = "us-west-2" as const;
  #resolveNoticeClear: (() => void) | null = null;

  async createBot(_input: CreateCaptureBotInput): Promise<{ botId: string }> {
    return { botId: "bot-fixture-1" };
  }

  stopRecordingNotice(_botId: string): Promise<void> {
    return new Promise((resolve) => {
      this.#resolveNoticeClear = resolve;
    });
  }

  resolveNoticeClear(): void {
    if (!this.#resolveNoticeClear) {
      throw new Error("No notice clear is pending.");
    }
    this.#resolveNoticeClear();
    this.#resolveNoticeClear = null;
  }
}

class ManualNoticeTimers {
  callback: (() => void) | null = null;
  delayMs: number | null = null;

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.callback = callback;
    this.delayMs = delayMs;
    return Symbol("notice-timer");
  }

  clearTimeout(_handle: unknown): void {
    this.callback = null;
    this.delayMs = null;
  }

  run(): void {
    const callback = this.callback;
    this.callback = null;
    if (!callback) {
      throw new Error("No recording-notice timer is scheduled.");
    }
    callback();
  }
}

class FailingNoticeSaveRepository implements SessionRepository {
  readonly dataRoot = "/private/test-data";
  #saveCount = 0;

  constructor(private readonly failOnSave: number) {}

  load(): PersistedSession | null {
    return null;
  }

  save(_state: SessionState, _mutations: MutationReceipt[]): void {
    this.#saveCount += 1;
    if (this.#saveCount === this.failOnSave) {
      throw new Error("synthetic notice persistence failure");
    }
  }
}
