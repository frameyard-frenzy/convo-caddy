import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import type { PreparedTopic, SessionState } from "../../src/domain/types.js";
import type {
  CaptureProvider,
  CreateCaptureBotInput,
} from "../../src/server/capture/capture-provider.js";
import { createRecallWebhookServer } from "../../src/server/capture/recall/recall-webhook-server.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import type {
  MutationReceipt,
  PersistedSession,
  SessionRepository,
} from "../../src/server/persistence/file-session-repository.js";
import { SessionService } from "../../src/server/session-service.js";

const secretBytes = Buffer.from("phase-4-webhook-test-secret");
const verificationSecret = `whsec_${secretBytes.toString("base64")}`;
const webhookTimestamp = "1787112001";
const fixtureBotId = "00000000-0000-4000-8000-000000000001";
const fixtureRecordingId = "00000000-0000-4000-8000-000000000005";
const topics: PreparedTopic[] = [
  { id: "case", tier: "must", text: "Select one case.", checked: false },
];

describe("Recall webhook-only server", () => {
  it("verifies and ingests one observed finalized turn exactly once", async () => {
    const context = await createTestContext();
    const rawBody = readFixture("001-transcript-data.json");
    let published = 0;
    context.service.subscribe(() => {
      published += 1;
    });

    await sendSigned(context.server, rawBody, "msg_fixture_001").expect(204);

    const state = context.service.getSnapshot();
    expect(state.capture).toMatchObject({
      mode: "recall",
      status: "recording",
      provider: {
        botId: fixtureBotId,
        recordingId: fixtureRecordingId,
      },
      lastEventAt: "2026-08-19T04:00:01.000Z",
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({
      id: "recall:msg_fixture_001",
      providerEventId: "msg_fixture_001",
      speakerId: "1001",
      speakerLabel: "Speaker 1",
      startedAtMs: 6_800,
      endedAtMs: 9_360,
      final: true,
    });
    expect(state.elapsedMs).toBe(9_360);
    expect(context.martyProvider.invocationCount).toBe(0);
    expect(context.repository.lastState).toEqual(state);
    expect(published).toBe(1);

    await sendSigned(context.server, rawBody, "msg_fixture_001").expect(204);

    expect(context.service.getSnapshot()).toEqual(state);
    expect(published).toBe(1);

    const note = await context.service.submitInput({
      input: "/note live moment",
      mutationId: "note-live-1",
    });
    expect(note.state.notes[0]).toMatchObject({
      relativeMs: 9_360,
      transcriptRef: {
        anchorTurnId: "recall:msg_fixture_001",
        windowTurnIds: ["recall:msg_fixture_001"],
        relativeMs: 9_360,
      },
    });
    expect(context.martyProvider.invocationCount).toBe(0);
  });

  it("deduplicates a retried transcript from its signed delivery timestamp", async () => {
    const context = await createTestContext();
    const rawBody = readFixture("001-transcript-data.json");

    await sendSigned(
      context.server,
      rawBody,
      "msg_retry_stable",
      "1787112001",
    ).expect(204);
    context.setWebhookNow("2026-08-19T04:04:59.000Z");
    await sendSigned(
      context.server,
      rawBody,
      "msg_retry_stable",
      "1787112001",
    ).expect(204);

    expect(context.service.getSnapshot().transcript).toHaveLength(1);
    expect(context.service.getSnapshot().transcript[0]?.receivedAt).toBe(
      "2026-08-19T04:00:01.000Z",
    );
  });

  it("rejects unsigned or conflicting delivery without mutating state", async () => {
    const context = await createTestContext();
    const rawBody = readFixture("001-transcript-data.json");
    const before = context.service.getSnapshot();

    await request(context.server)
      .post("/api/capture/recall/webhook")
      .set("content-type", "application/json")
      .send(rawBody)
      .expect(400);
    expect(context.service.getSnapshot()).toEqual(before);

    await sendSigned(context.server, rawBody, "msg_fixture_001").expect(204);
    const accepted = context.service.getSnapshot();
    const changed = JSON.parse(rawBody) as Record<string, unknown>;
    const data = changed.data as {
      data: { words: Array<{ text: string }> };
    };
    const firstWord = data.data.words[0];
    if (!firstWord) {
      throw new Error("Fixture must contain a word.");
    }
    firstWord.text = "conflicting finalized text";
    const conflictingBody = JSON.stringify(changed);

    await sendSigned(context.server, conflictingBody, "msg_fixture_001").expect(
      409,
    );
    expect(context.service.getSnapshot()).toEqual(accepted);

    const conflictingLifecycle = JSON.parse(
      readFixture("010-recording-done.json"),
    ) as Record<string, unknown>;
    const lifecycleData = conflictingLifecycle.data as {
      recording: { id: string };
    };
    lifecycleData.recording.id = "00000000-0000-4000-8000-999999999999";
    await sendSigned(
      context.server,
      JSON.stringify(conflictingLifecycle),
      "msg_conflicting_recording",
    ).expect(409);
    expect(context.service.getSnapshot()).toEqual(accepted);
  });

  it("persists the complete observed lifecycle without duplicate changes or model calls", async () => {
    const context = await createTestContext({
      now: "2025-12-31T23:59:59.000Z",
    });
    const publishedStatuses: string[] = [];
    context.service.subscribe((state) => {
      if (state.capture.mode === "recall") {
        publishedStatuses.push(state.capture.status);
      }
    });
    const lifecycleFixtures = [
      "004-bot-joining-call.json",
      "005-bot-in-waiting-room.json",
      "006-bot-in-call-not-recording.json",
      "007-bot-in-call-recording.json",
      "008-bot-call-ended.json",
      "009-transcript-done.json",
      "010-recording-done.json",
      "011-bot-done.json",
    ];

    for (const [index, fixture] of lifecycleFixtures.entries()) {
      await sendSigned(
        context.server,
        readFixture(fixture),
        `msg_lifecycle_${index}`,
      ).expect(204);
    }

    const state = context.service.getSnapshot();
    expect(state.capture).toMatchObject({
      mode: "recall",
      status: "ended",
      provider: {
        botId: fixtureBotId,
        recordingId: fixtureRecordingId,
      },
      lastEventAt: "2026-01-01T00:00:06.000Z",
      error: null,
    });
    expect(state.lifecycle.providerMilestones).toEqual({
      callEndedAt: "2026-01-01T00:00:04.000Z",
      transcriptDoneAt: "2026-01-01T00:00:05.000Z",
      recordingDoneAt: "2026-01-01T00:00:05.000Z",
      botDoneAt: "2026-01-01T00:00:06.000Z",
      providerErrorAt: null,
    });
    expect(publishedStatuses).toEqual([
      "joining",
      "waiting_room",
      "in_call",
      "recording",
      "ended",
      "ended",
      "ended",
      "ended",
    ]);
    expect(context.repository.lastState).toEqual(state);
    expect(context.martyProvider.invocationCount).toBe(0);

    for (const [index, fixture] of lifecycleFixtures.entries()) {
      await sendSigned(
        context.server,
        readFixture(fixture),
        `msg_lifecycle_${index}`,
      ).expect(204);
    }

    expect(context.service.getSnapshot()).toEqual(state);
    expect(publishedStatuses).toHaveLength(8);
    expect(context.martyProvider.invocationCount).toBe(0);
  });

  it.each([
    ["bot.recording_permission_denied", "recording_permission_denied"],
    ["bot.fatal", "fatal"],
  ])(
    "persists and surfaces the terminal Recall event %s",
    async (event, code) => {
      const context = await createTestContext({
        now: "2025-12-31T23:59:59.000Z",
      });
      const payload = JSON.parse(
        readFixture("004-bot-joining-call.json"),
      ) as Record<string, unknown>;
      payload.event = event;
      const data = payload.data as {
        data: { code: string; sub_code: string | null };
      };
      data.data.code = code;
      data.data.sub_code = "documented_failure_fixture";

      await sendSigned(
        context.server,
        JSON.stringify(payload),
        `msg_${code}`,
      ).expect(204);

      expect(context.service.getSnapshot().capture).toMatchObject({
        mode: "recall",
        status: "failed",
        error: expect.stringContaining("Recall"),
      });
      expect(context.repository.lastState).toEqual(
        context.service.getSnapshot(),
      );
    },
  );

  it("does not regress an ended capture when a finalized transcript arrives late", async () => {
    const context = await createTestContext({
      now: "2025-12-31T23:59:59.000Z",
    });

    await sendSigned(
      context.server,
      readFixture("011-bot-done.json"),
      "msg_done_before_transcript",
    ).expect(204);
    await sendSigned(
      context.server,
      readFixture("001-transcript-data.json"),
      "msg_late_transcript",
    ).expect(204);

    expect(context.service.getSnapshot()).toMatchObject({
      capture: {
        mode: "recall",
        status: "ended",
        authorization: { state: "confirmed" },
        notice: { state: "cleared" },
        lastEventAt: "2026-08-19T04:00:01.000Z",
      },
      transcript: [{ id: "recall:msg_late_transcript" }],
    });
    expect(context.martyProvider.invocationCount).toBe(0);
  });

  it("ignores a signed foreign bot and acknowledges unknown lifecycle shapes", async () => {
    const context = await createTestContext();
    const foreign = JSON.parse(
      readFixture("001-transcript-data.json"),
    ) as Record<string, unknown>;
    const data = foreign.data as { bot: { id: string } };
    data.bot.id = "00000000-0000-4000-8000-999999999999";
    const foreignBody = JSON.stringify(foreign);
    const before = context.service.getSnapshot();

    await sendSigned(context.server, foreignBody, "msg_foreign").expect(204);
    expect(context.service.getSnapshot()).toEqual(before);

    const foreignLifecycle = JSON.parse(
      readFixture("004-bot-joining-call.json"),
    ) as Record<string, unknown>;
    const foreignLifecycleData = foreignLifecycle.data as {
      bot: { id: string };
    };
    foreignLifecycleData.bot.id = "00000000-0000-4000-8000-999999999999";
    await sendSigned(
      context.server,
      JSON.stringify(foreignLifecycle),
      "msg_foreign_lifecycle",
    ).expect(204);
    expect(context.service.getSnapshot()).toEqual(before);

    const unknownBody = JSON.stringify({
      event: "bot.status_change",
      data: { redacted: true },
    });
    await sendSigned(context.server, unknownBody, "msg_unknown").expect(204);
    expect(context.service.getSnapshot()).toEqual(before);

    const malformedLifecycle = JSON.parse(
      readFixture("004-bot-joining-call.json"),
    ) as Record<string, unknown>;
    const lifecycleData = malformedLifecycle.data as {
      data: { code: string };
    };
    lifecycleData.data.code = "done";
    await sendSigned(
      context.server,
      JSON.stringify(malformedLifecycle),
      "msg_malformed_lifecycle",
    ).expect(400);
    expect(context.service.getSnapshot()).toEqual(before);
  });

  it("keeps delayed finalized deliveries chronological without reducing elapsed time", async () => {
    const context = await createTestContext();

    await sendSigned(
      context.server,
      readFixture("002-transcript-data.json"),
      "msg_fixture_002",
    ).expect(204);
    await sendSigned(
      context.server,
      readFixture("001-transcript-data.json"),
      "msg_fixture_001",
    ).expect(204);

    const state = context.service.getSnapshot();
    expect(state.transcript.map((turn) => turn.id)).toEqual([
      "recall:msg_fixture_001",
      "recall:msg_fixture_002",
    ]);
    expect(state.elapsedMs).toBe(39_600);
  });

  it("exposes no application routes and caps the signed body surface", async () => {
    const context = await createTestContext({ maxBodyBytes: 16 });

    await request(context.server).get("/api/session").expect(404);
    await sendSigned(
      context.server,
      '{"event":"transcript.data"}',
      "msg_large",
    ).expect(413);
    expect(context.service.getSnapshot().transcript).toHaveLength(0);
  });

  it("returns 500 and remains retryable when transcript persistence fails", async () => {
    const repository = new FailingSessionRepository(4);
    const context = await createTestContext({ repository });
    const rawBody = readFixture("001-transcript-data.json");

    await sendSigned(context.server, rawBody, "msg_persist_retry").expect(500);
    expect(context.service.getSnapshot().transcript).toHaveLength(0);

    await sendSigned(context.server, rawBody, "msg_persist_retry").expect(204);
    expect(context.service.getSnapshot().transcript).toHaveLength(1);
    expect(repository.lastState?.transcript).toHaveLength(1);
  });

  it("rejects stale signed deliveries before parsing or mutation", async () => {
    const context = await createTestContext();
    const rawBody = readFixture("001-transcript-data.json");

    await sendSigned(context.server, rawBody, "msg_stale", "1787099000").expect(
      400,
    );

    expect(context.service.getSnapshot().transcript).toHaveLength(0);
  });
});

async function createTestContext(
  options: {
    maxBodyBytes?: number;
    now?: string;
    webhookNow?: string;
    repository?: MemorySessionRepository;
  } = {},
) {
  const now = options.now ?? "2026-08-19T04:00:01.000Z";
  const martyProvider = new FakeMartyProvider();
  const repository = options.repository ?? new MemorySessionRepository();
  const captureProvider = new FixtureCaptureProvider();
  const service = new SessionService({
    topics,
    transcript: [],
    provider: martyProvider,
    captureProvider,
    repository,
    clock: new FixedClock(now),
    createId: () => "session-fixture",
  });
  const started = await service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789?p=fixture",
  });
  if (!started.ok) {
    throw new Error(started.error);
  }
  let webhookNow = options.webhookNow ?? "2026-08-19T04:00:01.000Z";
  const server = createRecallWebhookServer({
    service,
    verificationSecret,
    now: () => new Date(webhookNow),
    ...(options.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: options.maxBodyBytes }),
  });
  return {
    martyProvider,
    repository,
    server,
    service,
    setWebhookNow(value: string) {
      webhookNow = value;
    },
  };
}

function sendSigned(
  server: Server,
  rawBody: string,
  webhookId: string,
  timestamp = webhookTimestamp,
) {
  const signature = createHmac("sha256", secretBytes)
    .update(`${webhookId}.${timestamp}.${rawBody}`)
    .digest("base64");
  return request(server)
    .post("/api/capture/recall/webhook")
    .set("content-type", "application/json")
    .set("webhook-id", webhookId)
    .set("webhook-timestamp", timestamp)
    .set("webhook-signature", `v1,${signature}`)
    .send(rawBody);
}

function readFixture(filename: string): string {
  return readFileSync(
    new URL(`../fixtures/recall/${filename}`, import.meta.url),
    "utf8",
  );
}

class FixtureCaptureProvider implements CaptureProvider {
  readonly region = "us-west-2" as const;

  async createBot(_input: CreateCaptureBotInput): Promise<{ botId: string }> {
    return { botId: fixtureBotId };
  }

  async stopRecordingNotice(_botId: string): Promise<void> {}
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
