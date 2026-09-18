import { describe, expect, it } from "vitest";
import { parseInput } from "../../src/domain/input-parser.js";
import { reduceSession } from "../../src/domain/session-reducer.js";
import { createInitialSessionLifecycle } from "../../src/domain/session-lifecycle.js";
import type { SessionState, TranscriptTurn } from "../../src/domain/types.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import type {
  MartyContext,
  MartyProvider,
  MartyRequest,
  MartyResponse,
} from "../../src/server/marty/marty-provider.js";
import { SessionService } from "../../src/server/session-service.js";

function emptyState(): SessionState {
  return {
    sessionId: "session-1",
    startedAt: "2026-08-18T16:00:00.000Z",
    elapsedMs: 0,
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

describe("model-call boundary", () => {
  it("leaves the provider untouched for literal notes, invalid input, and checks", () => {
    const provider = new FakeMartyProvider();

    expect(parseInput("/note exact text").kind).toBe("note");
    expect(parseInput("/question exact text").kind).toBe("question");
    expect(parseInput("/revisit exact text").kind).toBe("revisit");
    expect(parseInput("/unknown exact text").kind).toBe("invalid");
    reduceSession(emptyState(), {
      type: "topic.setChecked",
      topicId: "case",
      checked: true,
    });

    expect(provider.invocationCount).toBe(0);
  });

  it("calls fake Marty once for inferred Revisit and appends one cited item", async () => {
    const provider = new FakeMartyProvider();
    const service = createService(provider);
    service.controlSimulation("step");

    const result = await service.submitInput({
      input: "/revisit",
      mutationId: "inferred-revisit",
    });

    expect(result.ok).toBe(true);
    expect(service.getSnapshot().revisit).toHaveLength(1);
    expect(service.getSnapshot().revisit[0]?.transcriptRef.anchorTurnId).toBe(
      "turn-serial",
    );
    expect(provider.invocationCount).toBe(1);
  });

  it("delivers a hinted Revisit separately and saves only generated text", async () => {
    const provider = new RecordsRequestProvider();
    const service = createService(provider);
    service.controlSimulation("step");

    await service.submitInput({
      input: "/revisit spreadsheets",
      mutationId: "hinted-revisit",
    });

    expect(provider.revisitHints).toEqual(["spreadsheets"]);
    expect(provider.contexts[0]?.transcript.map((turn) => turn.id)).toEqual([
      "turn-serial",
    ]);
    expect(service.getSnapshot().revisit.map((item) => item.text)).toEqual([
      "Return to the serial mismatch.",
    ]);
    expect(service.getSnapshot().questions).toEqual([]);
    expect(service.getSnapshot().chat).toEqual([]);
  });

  it("expands a contextual question into the Questions list only", async () => {
    const provider = new FakeMartyProvider();
    const service = createService(provider);
    service.controlSimulation("step");

    await service.submitInput({
      input: "/question why is that",
      mutationId: "contextual-question",
    });

    expect(service.getSnapshot().questions.map((item) => item.text)).toEqual([
      "Why did you switch from the ERP to a spreadsheet?",
    ]);
    expect(service.getSnapshot().revisit).toEqual([]);
    expect(service.getSnapshot().chat).toEqual([]);
    expect(provider.invocationCount).toBe(1);
  });

  it("attaches an inferred Revisit to Marty's validated cited turn", async () => {
    const provider = new CitesEarlierTurnProvider();
    const laterTurn: TranscriptTurn = {
      ...transcript[0],
      id: "turn-later",
      providerEventId: "fixture-later",
      text: "A later unrelated detail.",
      startedAtMs: 5_000,
      endedAtMs: 8_000,
    };
    const service = createService(provider, [
      transcript[0] as TranscriptTurn,
      laterTurn,
    ]);
    service.controlSimulation("step");
    service.controlSimulation("step");

    await service.submitInput({
      input: "/revisit",
      mutationId: "cited-revisit",
    });

    expect(service.getSnapshot().revisit[0]?.transcriptRef).toMatchObject({
      anchorTurnId: "turn-serial",
      windowTurnIds: ["turn-serial"],
      relativeMs: 8_000,
    });
  });

  it("changes chat only for an ordinary Marty question", async () => {
    const provider = new FakeMartyProvider();
    const service = createService(provider);
    service.controlSimulation("step");
    const before = service.getSnapshot();

    await service.submitInput({
      input: "What did they say about SAP?",
      mutationId: "ask-marty",
    });
    const after = service.getSnapshot();

    expect(after.chat).toHaveLength(1);
    expect(after.chat[0]?.citationTurnIds).toEqual(["turn-serial"]);
    expect(after.topics).toEqual(before.topics);
    expect(after.revisit).toEqual(before.revisit);
    expect(after.questions).toEqual(before.questions);
    expect(after.notes).toEqual(before.notes);
    expect(provider.invocationCount).toBe(1);
  });

  it.each(["/revisit spreadsheets", "/question why is that"])(
    "does not append either list when %s fails",
    async (input) => {
      const provider = new FakeMartyProvider();
      const service = createService(provider);
      service.controlSimulation("step");
      provider.failNext("Synthetic provider failure.");

      const result = await service.submitInput({
        input,
        mutationId: `failed-${input}`,
      });

      expect(result).toMatchObject({
        ok: false,
        error: "Synthetic provider failure.",
      });
      expect(service.getSnapshot().revisit).toEqual([]);
      expect(service.getSnapshot().questions).toEqual([]);
      expect(provider.invocationCount).toBe(1);
    },
  );

  it("records an ordinary provider failure in chat without mutating lists", async () => {
    const provider = new FakeMartyProvider();
    const service = createService(provider);
    service.controlSimulation("step");
    provider.failNext("Synthetic answer failure.");
    const before = service.getSnapshot();

    const result = await service.submitInput({
      input: "What happened in SAP?",
      mutationId: "failed-answer",
    });
    const after = service.getSnapshot();

    expect(result.ok).toBe(false);
    expect(after.chat).toHaveLength(1);
    expect(after.chat[0]).toMatchObject({
      question: "What happened in SAP?",
      response: null,
      error: "Synthetic answer failure.",
    });
    expect(after.topics).toEqual(before.topics);
    expect(after.revisit).toEqual(before.revisit);
    expect(after.questions).toEqual(before.questions);
    expect(after.notes).toEqual(before.notes);
    expect(provider.invocationCount).toBe(1);
  });

  it("rejects provider citations that are not in the current transcript", async () => {
    const provider = new InvalidCitationProvider();
    const service = createService(provider);
    service.controlSimulation("step");

    const result = await service.submitInput({
      input: "/revisit",
      mutationId: "invalid-citation",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Assistant returned an invalid transcript citation.",
    );
    expect(service.getSnapshot().revisit).toEqual([]);
    expect(provider.invocationCount).toBe(1);
  });

  it("does not call Marty for simulation lifecycle changes", () => {
    const provider = new FakeMartyProvider();
    const service = createService(provider);

    service.controlSimulation("start");
    service.controlSimulation("pause");
    service.controlSimulation("resume");
    service.controlSimulation("pause");
    service.controlSimulation("step");
    service.controlSimulation("reset");

    expect(provider.invocationCount).toBe(0);
  });

  it("deduplicates an explicit provider mutation before making the call", async () => {
    const provider = new FakeMartyProvider();
    const service = createService(provider);
    service.controlSimulation("step");

    const first = service.submitInput({
      input: "/revisit",
      mutationId: "same-inference",
    });
    const duplicate = service.submitInput({
      input: "/revisit",
      mutationId: "same-inference",
    });

    expect(await duplicate).toEqual(await first);
    expect(provider.invocationCount).toBe(1);
    expect(service.getSnapshot().revisit).toHaveLength(1);
  });

  it("deduplicates an in-flight contextual Question", async () => {
    const provider = new DeferredProvider();
    const service = createService(provider);
    service.controlSimulation("step");
    const submission = {
      input: "/question why is that",
      mutationId: "same-question",
    };

    const first = service.submitInput(submission);
    const duplicate = service.submitInput(submission);
    provider.resolve({
      text: "Why did you switch from the ERP to a spreadsheet?",
      citationTurnIds: ["turn-serial"],
    });

    expect(await duplicate).toEqual(await first);
    expect(provider.invocationCount).toBe(1);
    expect(service.getSnapshot().questions).toHaveLength(1);
  });

  it("rejects one mutation ID reused for different input without a second call", async () => {
    const provider = new FakeMartyProvider();
    const service = createService(provider);
    service.controlSimulation("step");

    const first = await service.submitInput({
      input: "What changed?",
      mutationId: "same-id-different-input",
    });
    const conflicting = await service.submitInput({
      input: "/revisit",
      mutationId: "same-id-different-input",
    });

    expect(first.ok).toBe(true);
    expect(conflicting).toMatchObject({
      ok: false,
      kind: "invalid_input",
      error: "Mutation ID was already used for different input.",
    });
    expect(provider.invocationCount).toBe(1);
    expect(service.getSnapshot().chat).toHaveLength(1);
    expect(service.getSnapshot().revisit).toEqual([]);
  });

  it("passes each mutation ID to the provider as its idempotency key", async () => {
    const provider = new RecordsRequestProvider();
    const service = createService(provider);
    service.controlSimulation("step");

    await service.submitInput({
      input: "/revisit",
      mutationId: "revisit-request-id",
    });
    await service.submitInput({
      input: "What changed?",
      mutationId: "answer-request-id",
    });

    expect(provider.idempotencyKeys).toEqual([
      "revisit-request-id",
      "answer-request-id",
    ]);
  });

  it.each(["/revisit", "/revisit spreadsheets", "/question why is that"])(
    "rejects pending %s after reset",
    async (input) => {
      const provider = new DeferredProvider();
      const service = createService(provider);
      service.controlSimulation("step");

      const pending = service.submitInput({
        input,
        mutationId: "pending-before-reset",
      });
      service.controlSimulation("reset");
      const afterReset = service.getSnapshot();
      provider.resolve({
        text: "Stale return cue.",
        citationTurnIds: ["turn-serial"],
      });

      const result = await pending;
      expect(result.ok).toBe(false);
      expect(service.getSnapshot().revisit).toEqual([]);
      expect(service.getSnapshot().transcript).toEqual([]);
      expect(service.getSnapshot()).toEqual(afterReset);
    },
  );

  it.each([
    ["revisit", "/revisit spreadsheets"],
    ["question", "/question why is that"],
  ] as const)(
    "anchors a pending %s command to its command-time context",
    async (kind, input) => {
      const provider = new DeferredProvider();
      const laterTurn: TranscriptTurn = {
        ...transcript[0],
        id: "turn-later",
        providerEventId: "fixture-later",
        text: "A later arrival that must not enter the command context.",
        startedAtMs: 5_000,
        endedAtMs: 8_000,
      };
      const service = createService(provider, [
        transcript[0] as TranscriptTurn,
        laterTurn,
      ]);
      service.controlSimulation("step");

      const pending = service.submitInput({
        input,
        mutationId: `pending-${kind}`,
      });
      service.controlSimulation("step");
      expect(provider.contexts[0]?.transcript.map((turn) => turn.id)).toEqual([
        "turn-serial",
      ]);
      provider.resolve({
        text: `Generated ${kind} item.`,
        citationTurnIds: ["turn-serial"],
      });

      expect((await pending).ok).toBe(true);
      const item =
        kind === "revisit"
          ? service.getSnapshot().revisit[0]
          : service.getSnapshot().questions[0];
      expect(item?.relativeMs).toBe(4_000);
      expect(item?.transcriptRef).toMatchObject({
        anchorTurnId: "turn-serial",
        windowTurnIds: ["turn-serial"],
      });
    },
  );

  it.each(["What changed?", "/revisit spreadsheets", "/question why is that"])(
    "rejects pending %s after close",
    async (input) => {
      const provider = new DeferredProvider();
      const service = createService(provider);
      service.controlSimulation("step");
      const beforeClose = service.getSnapshot();

      const pending = service.submitInput({
        input,
        mutationId: "pending-before-close",
      });
      service.close();
      provider.resolve({
        text: "This result arrived after shutdown.",
        citationTurnIds: ["turn-serial"],
      });

      const result = await pending;
      expect(result.ok).toBe(false);
      expect(service.getSnapshot()).toEqual(beforeClose);
    },
  );

  it("starts a fresh mutation namespace after reset", async () => {
    const provider = new FakeMartyProvider();
    const service = createService(provider);

    await service.submitInput({
      input: "/question Before reset?",
      mutationId: "reused-after-reset",
    });
    service.controlSimulation("reset");
    const result = await service.submitInput({
      input: "/question After reset?",
      mutationId: "reused-after-reset",
    });

    expect(result.ok).toBe(true);
    expect(service.getSnapshot().questions.map((item) => item.text)).toEqual([
      "Ask a specific follow-up about: After reset?",
    ]);
  });
});

const transcript: TranscriptTurn[] = [
  {
    id: "turn-serial",
    providerEventId: "fixture-serial",
    speakerId: "participant",
    speakerLabel: "Participant",
    text: "The serial number was tracked in SAP and a spreadsheet.",
    startedAtMs: 1_000,
    endedAtMs: 4_000,
    receivedAt: "2026-08-18T16:00:04.000Z",
    final: true,
  },
];

function createService(
  provider: MartyProvider,
  fixture: TranscriptTurn[] = transcript,
): SessionService {
  let id = 0;
  return new SessionService({
    topics: emptyState().topics,
    transcript: fixture,
    provider,
    createId: () => `generated-${++id}`,
  });
}

class CitesEarlierTurnProvider implements MartyProvider {
  invocationCount = 0;

  async requestRevisit(_context: MartyContext): Promise<MartyResponse> {
    this.invocationCount += 1;
    return {
      text: "Return to the serial-number mismatch.",
      citationTurnIds: ["turn-serial"],
    };
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
}

class DeferredProvider implements MartyProvider {
  invocationCount = 0;
  readonly contexts: MartyContext[] = [];
  #resolve: ((response: MartyResponse) => void) | null = null;

  async requestRevisit(_context: MartyContext): Promise<MartyResponse> {
    this.invocationCount += 1;
    this.contexts.push(_context);
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

class InvalidCitationProvider implements MartyProvider {
  invocationCount = 0;

  async requestRevisit(_context: MartyContext): Promise<MartyResponse> {
    this.invocationCount += 1;
    return {
      text: "A fabricated citation.",
      citationTurnIds: ["missing-turn"],
    };
  }

  async ask(_question: string, _context: MartyContext): Promise<MartyResponse> {
    this.invocationCount += 1;
    return {
      text: "A fabricated citation.",
      citationTurnIds: ["missing-turn"],
    };
  }

  async requestQuestion(
    _hint: string,
    context: MartyContext,
  ): Promise<MartyResponse> {
    return this.ask("", context);
  }
}

class RecordsRequestProvider implements MartyProvider {
  invocationCount = 0;
  readonly idempotencyKeys: string[] = [];
  readonly revisitHints: Array<string | undefined> = [];
  readonly questionHints: string[] = [];
  readonly contexts: MartyContext[] = [];

  async requestRevisit(
    _context: MartyContext,
    request: MartyRequest,
    hint?: string,
  ): Promise<MartyResponse> {
    this.invocationCount += 1;
    this.idempotencyKeys.push(request.idempotencyKey);
    this.revisitHints.push(hint);
    this.contexts.push(_context);
    return {
      text: "Return to the serial mismatch.",
      citationTurnIds: ["turn-serial"],
    };
  }

  async ask(
    _question: string,
    context: MartyContext,
    request: MartyRequest,
  ): Promise<MartyResponse> {
    return this.requestRevisit(context, request);
  }

  async requestQuestion(
    hint: string,
    context: MartyContext,
    request: MartyRequest,
  ): Promise<MartyResponse> {
    this.invocationCount += 1;
    this.idempotencyKeys.push(request.idempotencyKey);
    this.questionHints.push(hint);
    this.contexts.push(context);
    return {
      text: "Why did you switch from the ERP to a spreadsheet?",
      citationTurnIds: ["turn-serial"],
    };
  }
}
