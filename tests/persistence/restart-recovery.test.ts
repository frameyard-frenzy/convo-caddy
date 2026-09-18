import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import type { PreparedTopic, TranscriptTurn } from "../../src/domain/types.js";
import type {
  CaptureProvider,
  CreateCaptureBotInput,
} from "../../src/server/capture/capture-provider.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import type {
  MartyContext,
  MartyProvider,
  MartyResponse,
} from "../../src/server/marty/marty-provider.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { SessionService } from "../../src/server/session-service.js";
import type { SimulatorTimers } from "../../src/server/transcript/simulator.js";

const temporaryDirectories: string[] = [];

function createRepository(): FileSessionRepository {
  const directory = mkdtempSync(path.join(tmpdir(), "convo-caddy-restart-"));
  temporaryDirectories.push(directory);
  return new FileSessionRepository(path.join(directory, "sessions"));
}

const topics: PreparedTopic[] = [
  { id: "case", tier: "must", text: "Select one case.", checked: false },
  { id: "evidence", tier: "more", text: "Find the evidence.", checked: false },
];

const transcript: TranscriptTurn[] = [
  {
    id: "turn-1",
    providerEventId: "fixture-1",
    speakerId: "participant",
    speakerLabel: "Participant",
    text: "The serial number did not join to the SAP lot record.",
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
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("session restart recovery", () => {
  it("restores the exact session and all interaction lists after a restart", async () => {
    const repository = createRepository();
    const first = createService(repository, new FakeMartyProvider(), "first");

    first.controlSimulation("step");
    first.setTopicChecked("case", true);
    await first.submitInput({ input: "/note Exact note.", mutationId: "note" });
    await first.submitInput({
      input: "/question Who approved it?",
      mutationId: "question",
    });
    await first.submitInput({
      input: "/revisit The SAP join.",
      mutationId: "revisit",
    });
    await first.submitInput({
      input: "What did the participant say?",
      mutationId: "chat",
    });
    first.setQuestionChecked(first.getSnapshot().questions[0]?.id ?? "", true);
    first.setRevisitChecked(first.getSnapshot().revisit[0]?.id ?? "", true);
    const beforeRestart = first.getSnapshot();

    const restarted = createService(
      new FileSessionRepository(repository.dataRoot),
      new FakeMartyProvider(),
      "restarted",
    );

    expect(restarted.getSnapshot()).toEqual(beforeRestart);
    expect(restarted.getSnapshot()).toMatchObject({
      notes: [{ text: "Exact note." }],
      questions: [
        {
          text: "Ask a specific follow-up about: Who approved it?",
          checked: true,
        },
      ],
      revisit: [
        {
          text: "Return to the serial-number mismatch and how it changed the exposed lots.",
          checked: true,
        },
      ],
      transcript: [{ id: "turn-1" }],
      chat: [{ question: "What did the participant say?" }],
      simulation: { status: "paused", cursor: 1 },
    });
    expect(restarted.getSnapshot().topics[0]?.checked).toBe(true);
  });

  it("deduplicates persisted mutation and transcript provider IDs", async () => {
    const repository = createRepository();
    const firstProvider = new FakeMartyProvider();
    const first = createService(repository, firstProvider, "first");
    first.controlSimulation("step");
    const original = await first.submitInput({
      input: "What happened?",
      mutationId: "ask-once",
    });
    expect(firstProvider.invocationCount).toBe(1);

    const restartedProvider = new FakeMartyProvider();
    const restarted = createService(
      new FileSessionRepository(repository.dataRoot),
      restartedProvider,
      "restarted",
    );
    const duplicate = await restarted.submitInput({
      input: "What happened?",
      mutationId: "ask-once",
    });

    expect(duplicate).toEqual(original);
    expect(restartedProvider.invocationCount).toBe(0);
    expect(restarted.getSnapshot().chat).toHaveLength(1);

    restarted.controlSimulation("step");
    expect(restarted.getSnapshot().transcript.map((turn) => turn.id)).toEqual([
      "turn-1",
      "turn-2",
    ]);
    expect(
      restarted.getSnapshot().transcript.map((turn) => turn.providerEventId),
    ).toEqual(["fixture-1", "fixture-2"]);
  });

  it("rejects a conflicting persisted mutation after restart without another call", async () => {
    const repository = createRepository();
    const firstProvider = new FakeMartyProvider();
    const first = createService(repository, firstProvider, "first");
    first.controlSimulation("step");
    await first.submitInput({
      input: "What happened?",
      mutationId: "ask-once-conflict",
    });

    const restartedProvider = new FakeMartyProvider();
    const restarted = createService(
      new FileSessionRepository(repository.dataRoot),
      restartedProvider,
      "restarted",
    );
    const conflict = await restarted.submitInput({
      input: "/revisit",
      mutationId: "ask-once-conflict",
    });

    expect(conflict).toMatchObject({
      ok: false,
      kind: "invalid_input",
      error: "Mutation ID was already used for different input.",
    });
    expect(restartedProvider.invocationCount).toBe(0);
    expect(restarted.getSnapshot().chat).toHaveLength(1);
    expect(restarted.getSnapshot().revisit).toEqual([]);
  });

  it("replays a completed legacy literal-command receipt without new inference", async () => {
    const repository = createRepository();
    const first = createService(repository, new FakeMartyProvider(), "first");
    const legacyState = first.getSnapshot();
    repository.save(legacyState, [
      {
        mutationId: "legacy-literal-question",
        input: "/question Legacy saved wording?",
        ok: true,
        kind: "accepted",
      },
    ]);
    const provider = new FakeMartyProvider();
    const restarted = createService(
      new FileSessionRepository(repository.dataRoot),
      provider,
      "restarted",
    );

    const replay = await restarted.submitInput({
      input: "/question Legacy saved wording?",
      mutationId: "legacy-literal-question",
    });

    expect(replay.ok).toBe(true);
    expect(provider.invocationCount).toBe(0);
    expect(restarted.getSnapshot()).toEqual(legacyState);
  });

  it("fails closed when persisted turns do not match the active fixture", () => {
    const repository = createRepository();
    const first = createService(repository, new FakeMartyProvider(), "first");
    first.controlSimulation("step");

    const changedFixture = transcript.map((turn, index) =>
      index === 0 ? { ...turn, text: "Changed fixture content." } : turn,
    );
    expect(() =>
      createService(
        new FileSessionRepository(repository.dataRoot),
        new FakeMartyProvider(),
        "restarted",
        changedFixture,
      ),
    ).toThrow("Persisted transcript does not match the active fixture");
  });

  it("restores command receipt time captured between transcript turns", async () => {
    const repository = createRepository();
    let nowMs = 0;
    const timers: SimulatorTimers = {
      setTimeout: (callback) => callback,
      clearTimeout: () => undefined,
      now: () => nowMs,
    };
    const first = createService(
      repository,
      new FakeMartyProvider(),
      "first",
      transcript,
      timers,
    );

    first.controlSimulation("start");
    nowMs = 100;
    first.controlSimulation("pause");
    expect(first.getSnapshot().elapsedMs).toBe(2_000);

    const restarted = createService(
      new FileSessionRepository(repository.dataRoot),
      new FakeMartyProvider(),
      "restarted",
      transcript,
      { ...timers, now: () => 0 },
    );
    await restarted.submitInput({
      input: "/note Between turns.",
      mutationId: "between-turn-note",
    });

    expect(restarted.getSnapshot().notes[0]?.transcriptRef).toMatchObject({
      anchorTurnId: null,
      windowTurnIds: [],
      relativeMs: 2_000,
    });
  });

  it("restores an ended Recall session after live transcript advances elapsed time", async () => {
    const repository = createRepository();
    const first = createRecallService(repository, "first-live");
    const started = await first.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789?p=fixture",
    });
    expect(started.ok).toBe(true);

    expect(
      first.ingestRecallLifecycle({
        botId: "bot-restart-fixture",
        recordingId: null,
        status: "in_call",
        milestone: null,
        occurredAt: "2026-08-18T16:00:05.000Z",
      }),
    ).toBe("accepted");
    expect(
      first.ingestRecallTranscript({
        botId: "bot-restart-fixture",
        recordingId: "recording-restart-fixture",
        turn: {
          ...transcript[0],
          id: "live-turn-1",
          providerEventId: "live-event-1",
        },
      }),
    ).toBe("accepted");
    expect(
      first.ingestRecallLifecycle({
        botId: "bot-restart-fixture",
        recordingId: "recording-restart-fixture",
        status: "ended",
        milestone: "call_ended",
        occurredAt: "2026-08-18T16:10:05.000Z",
      }),
    ).toBe("accepted");
    const beforeRestart = first.getSnapshot();
    expect(beforeRestart.elapsedMs).toBe(4_000);

    const restarted = createRecallService(
      new FileSessionRepository(repository.dataRoot),
      "restarted-live",
    );

    expect(restarted.getSnapshot()).toEqual(beforeRestart);
    expect(restarted.getSnapshot().capture).toMatchObject({
      mode: "recall",
      status: "ended",
      provider: {
        botId: "bot-restart-fixture",
        recordingId: "recording-restart-fixture",
      },
      lastEventAt: "2026-08-18T16:10:05.000Z",
    });
  });

  it("does not persist an in-flight mutation receipt after reset", async () => {
    const repository = createRepository();
    const provider = new DeferredProvider();
    const first = createService(repository, provider, "first");
    const pending = first.submitInput({
      input: "/revisit",
      mutationId: "same-id-after-reset",
    });

    first.controlSimulation("reset");
    provider.resolve({ text: "Stale cue.", citationTurnIds: [] });
    expect((await pending).ok).toBe(false);

    const restarted = createService(
      new FileSessionRepository(repository.dataRoot),
      new FakeMartyProvider(),
      "restarted",
    );
    const replacement = await restarted.submitInput({
      input: "/question Fresh mutation?",
      mutationId: "same-id-after-reset",
    });

    expect(replacement.ok).toBe(true);
    expect(restarted.getSnapshot().questions[0]?.text).toBe(
      "Ask a specific follow-up about: Fresh mutation?",
    );
  });
});

function createService(
  repository: FileSessionRepository,
  provider: MartyProvider,
  idPrefix: string,
  transcriptFixture: TranscriptTurn[] = transcript,
  timers?: SimulatorTimers,
): SessionService {
  let id = 0;
  return new SessionService({
    topics,
    transcript: transcriptFixture,
    provider,
    repository,
    timers,
    clock: new FixedClock("2026-08-18T16:00:10.000Z"),
    createId: () => `${idPrefix}-${++id}`,
  });
}

function createRecallService(
  repository: FileSessionRepository,
  idPrefix: string,
): SessionService {
  let id = 0;
  return new SessionService({
    topics,
    transcript,
    provider: new FakeMartyProvider(),
    captureProvider: new RestartCaptureProvider(),
    repository,
    clock: new FixedClock("2026-08-18T16:00:00.000Z"),
    createId: () => `${idPrefix}-${++id}`,
  });
}

class RestartCaptureProvider implements CaptureProvider {
  readonly region = "us-west-2" as const;

  async createBot(_input: CreateCaptureBotInput): Promise<{ botId: string }> {
    return { botId: "bot-restart-fixture" };
  }

  async stopRecordingNotice(_botId: string): Promise<void> {}
}

class DeferredProvider implements MartyProvider {
  invocationCount = 0;
  #resolve: ((response: MartyResponse) => void) | null = null;

  async requestRevisit(_context: MartyContext): Promise<MartyResponse> {
    this.invocationCount += 1;
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  async ask(_question: string, context: MartyContext): Promise<MartyResponse> {
    return this.requestRevisit(context);
  }

  async requestQuestion(
    _hint: string,
    context: MartyContext,
  ): Promise<MartyResponse> {
    return this.requestRevisit(context);
  }

  resolve(response: MartyResponse): void {
    if (!this.#resolve) {
      throw new Error("No deferred provider request is pending.");
    }
    this.#resolve(response);
    this.#resolve = null;
  }
}
