import request from "supertest";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import type { PreparedTopic, SessionState } from "../../src/domain/types.js";
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

const topics: PreparedTopic[] = [
  { id: "case", tier: "must", text: "Select one case.", checked: false },
];

describe("POST /api/capture/recall/start", () => {
  it("sends one bot to the lobby for a personal Teams meeting", async () => {
    const context = createTestContext();
    const meetingUrl = "https://teams.live.com/meet/123456789?p=fixture";

    const response = await request(context.app)
      .post("/api/capture/recall/start")
      .send({ meetingUrl, displayName: "  Supplier quality case  " });

    expect(response.status).toBe(201);
    expect(context.captureProvider.invocationCount).toBe(1);
    expect(context.captureProvider.lastInput).toMatchObject({
      meetingUrl,
    });
    expect(response.body.state.lifecycle.displayName).toBe(
      "Supplier quality case",
    );
    expect(response.body.state.capture).toEqual({
      mode: "recall",
      operationId: expect.any(String),
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
        botId: "bot-fixture-1",
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
      lastEventAt: "2026-08-18T16:00:00.000Z",
      error: null,
    });
    expect(JSON.stringify(response.body)).not.toContain(meetingUrl);
  });

  it("rejects business Teams and non-Teams meeting links", async () => {
    for (const meetingUrl of [
      "https://teams.microsoft.com/meet/123456789?p=fixture",
      "https://meet.google.com/abc-defg-hij",
    ]) {
      const context = createTestContext();
      const response = await request(context.app)
        .post("/api/capture/recall/start")
        .send({ meetingUrl });

      expect(response.status).toBe(400);
      expect(context.captureProvider.invocationCount).toBe(0);
    }
  });

  it("does not create a second bot for an active capture", async () => {
    const context = createTestContext();
    const body = {
      meetingUrl: "https://teams.live.com/meet/123456789?p=fixture",
    };

    await request(context.app)
      .post("/api/capture/recall/start")
      .send(body)
      .expect(201);
    const duplicate = await request(context.app)
      .post("/api/capture/recall/start")
      .send(body);

    expect(duplicate.status).toBe(409);
    expect(context.captureProvider.invocationCount).toBe(1);
  });

  it("does not create a bot while standalone callback connectivity is unavailable", async () => {
    const context = createTestContext();
    context.service.setRecallCaptureAvailable(false);

    const response = await request(context.app)
      .post("/api/capture/recall/start")
      .send({ meetingUrl: "https://teams.live.com/meet/123456789?p=fixture" });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("callback connectivity");
    expect(context.captureProvider.invocationCount).toBe(0);
    expect(context.service.getSnapshot().capture.mode).toBe("simulation");
  });

  it("disables simulator controls after live capture starts", async () => {
    const context = createTestContext();
    await request(context.app)
      .post("/api/capture/recall/start")
      .send({ meetingUrl: "https://teams.live.com/meet/123456789?p=fixture" })
      .expect(201);
    const before = context.service.getSnapshot();

    const response = await request(context.app)
      .post("/api/session/simulation/step")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(
      "Simulation controls are unavailable during live capture.",
    );
    expect(context.service.getSnapshot()).toEqual(before);
  });

  it("tags the remote bot with the persisted capture operation before creation", async () => {
    const context = createTestContext();

    await request(context.app)
      .post("/api/capture/recall/start")
      .send({ meetingUrl: "https://teams.live.com/meet/123456789?p=fixture" })
      .expect(201);

    const capture = context.repository.lastState?.capture;
    expect(capture?.mode).toBe("recall");
    expect(context.captureProvider.lastInput?.operationId).toBe(
      capture?.mode === "recall" ? capture.operationId : null,
    );
    expect(context.captureProvider.lastInput?.operationId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("binds an early correlated webhook and does not regress its lifecycle", async () => {
    const captureProvider = new DeferredCaptureProvider();
    const repository = new MemorySessionRepository();
    const service = new SessionService({
      topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      repository,
      clock: new FixedClock("2026-08-18T16:00:00.000Z"),
      createId: () => "session-fixture",
    });

    const starting = service.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789?p=fixture",
    });
    const creating = service.getSnapshot().capture;
    if (creating.mode !== "recall" || !creating.operationId) {
      throw new Error("Expected a persisted Recall capture operation.");
    }

    expect(
      service.ingestRecallLifecycle({
        botId: "bot-fixture-early",
        operationId: creating.operationId,
        recordingId: null,
        status: "waiting_room",
        milestone: null,
        occurredAt: "2026-08-18T16:00:01.000Z",
      }),
    ).toBe("accepted");
    captureProvider.resolve("bot-fixture-early");

    const result = await starting;
    expect(result.ok).toBe(true);
    expect(result.state.capture).toMatchObject({
      mode: "recall",
      status: "waiting_room",
      provider: { botId: "bot-fixture-early" },
    });
  });

  it("does not create a bot when the operation cannot be persisted first", async () => {
    const repository = new FailingSessionRepository(2);
    const context = createTestContext({ repository });
    const before = context.service.getSnapshot();

    const response = await request(context.app)
      .post("/api/capture/recall/start")
      .send({ meetingUrl: "https://teams.live.com/meet/123456789?p=fixture" });

    expect(response.status).toBe(502);
    expect(context.captureProvider.invocationCount).toBe(0);
    expect(response.body.state).toEqual(before);
    expect(response.body.error).toContain("No bot was created");
  });

  it("preserves the known bot ID when persistence fails after remote creation", async () => {
    const repository = new FailingSessionRepository(3);
    const context = createTestContext({ repository });

    const response = await request(context.app)
      .post("/api/capture/recall/start")
      .send({ meetingUrl: "https://teams.live.com/meet/123456789?p=fixture" });

    expect(response.status).toBe(502);
    expect(context.captureProvider.invocationCount).toBe(1);
    expect(response.body.state.capture).toMatchObject({
      mode: "recall",
      status: "failed",
      provider: { botId: "bot-fixture-1" },
    });
    expect(response.body.error).toContain("known bot ID");
  });

  it("does not mutate local state when Create Bot resolves after close", async () => {
    const captureProvider = new DeferredCaptureProvider();
    const repository = new MemorySessionRepository();
    const service = new SessionService({
      topics,
      transcript: [],
      provider: new FakeMartyProvider(),
      captureProvider,
      repository,
      clock: new FixedClock("2026-08-18T16:00:00.000Z"),
      createId: () => "session-fixture",
    });
    const pending = service.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789?p=fixture",
    });
    const beforeClose = service.getSnapshot();

    service.close();
    captureProvider.resolve("bot-created-after-close");

    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected Create Bot completion after close to fail.");
    }
    expect(result.error).toContain("shutting down");
    expect(service.getSnapshot()).toEqual(beforeClose);
  });
});

function createTestContext(
  options: { repository?: MemorySessionRepository } = {},
) {
  const captureProvider = new RecordingCaptureProvider();
  const repository = options.repository ?? new MemorySessionRepository();
  const service = new SessionService({
    topics,
    transcript: [],
    provider: new FakeMartyProvider(),
    captureProvider,
    repository,
    clock: new FixedClock("2026-08-18T16:00:00.000Z"),
    createId: () => "session-fixture",
  });
  return {
    app: createApp({ service }),
    captureProvider,
    repository,
    service,
  };
}

class RecordingCaptureProvider implements CaptureProvider {
  readonly region = "us-west-2" as const;
  invocationCount = 0;
  lastInput: CreateCaptureBotInput | null = null;

  async createBot(input: CreateCaptureBotInput): Promise<{ botId: string }> {
    this.invocationCount += 1;
    this.lastInput = input;
    return { botId: "bot-fixture-1" };
  }

  async stopRecordingNotice(_botId: string): Promise<void> {}
}

class DeferredCaptureProvider implements CaptureProvider {
  readonly region = "us-west-2" as const;
  #resolve: ((value: { botId: string }) => void) | null = null;

  createBot(_input: CreateCaptureBotInput): Promise<{ botId: string }> {
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  async stopRecordingNotice(_botId: string): Promise<void> {}

  resolve(botId: string): void {
    if (!this.#resolve) {
      throw new Error("Create Bot is not pending.");
    }
    this.#resolve({ botId });
  }
}

class MemorySessionRepository implements SessionRepository {
  readonly dataRoot = "/private/test-data";
  lastState: SessionState | null = null;

  load(): PersistedSession | null {
    return null;
  }

  save(state: SessionState, _mutations: MutationReceipt[]): void {
    this.lastState = structuredClone(state);
  }
}

class FailingSessionRepository extends MemorySessionRepository {
  #saveCount = 0;

  constructor(private readonly failOnSave: number) {
    super();
  }

  override save(state: SessionState, mutations: MutationReceipt[]): void {
    this.#saveCount += 1;
    if (this.#saveCount === this.failOnSave) {
      throw new Error("synthetic persistence failure");
    }
    super.save(state, mutations);
  }
}
