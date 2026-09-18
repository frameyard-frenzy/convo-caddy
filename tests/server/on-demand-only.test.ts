import { describe, expect, it } from "vitest";
import type { PreparedTopic, TranscriptTurn } from "../../src/domain/types.js";
import { UnavailableMartyProvider } from "../../src/server/marty/unavailable-marty-provider.js";
import { SessionService } from "../../src/server/session-service.js";

describe("no-credential Marty boundary", () => {
  it("keeps literal notes and local controls available without pretending to reason", async () => {
    const provider = new UnavailableMartyProvider();
    const service = createService(provider);

    service.controlSimulation("step");
    service.setTopicChecked("case", true);
    const note = await service.submitInput({
      input: "/note Exact observation.",
      mutationId: "note",
    });
    const question = await service.submitInput({
      input: "/question Exact question?",
      mutationId: "question",
    });
    const revisit = await service.submitInput({
      input: "/revisit Exact participant thread.",
      mutationId: "manual-revisit",
    });

    expect(service.getSnapshot()).toMatchObject({
      topics: [{ id: "case", checked: true }],
      notes: [{ text: "Exact observation." }],
      questions: [],
      revisit: [],
    });
    expect(note.ok).toBe(true);
    expect(question.ok).toBe(false);
    expect(revisit.ok).toBe(false);
    expect(provider.invocationCount).toBe(2);
  });

  it("fails each explicit reasoning action once without unrelated mutation", async () => {
    const provider = new UnavailableMartyProvider();
    const service = createService(provider);
    service.controlSimulation("step");
    const before = service.getSnapshot();

    const revisit = await service.submitInput({
      input: "/revisit",
      mutationId: "inferred-revisit",
    });
    const answer = await service.submitInput({
      input: "What changed the investigation?",
      mutationId: "answer",
    });
    const after = service.getSnapshot();

    expect(revisit).toMatchObject({
      ok: false,
      kind: "provider_failure",
      error:
        "Assistant is unavailable until the server-side Hermes connection is configured.",
    });
    expect(answer).toMatchObject({
      ok: false,
      kind: "provider_failure",
      error:
        "Assistant is unavailable until the server-side Hermes connection is configured.",
    });
    expect(after.revisit).toEqual(before.revisit);
    expect(after.questions).toEqual(before.questions);
    expect(after.notes).toEqual(before.notes);
    expect(after.chat).toEqual([
      expect.objectContaining({
        question: "What changed the investigation?",
        response: null,
        error:
          "Assistant is unavailable until the server-side Hermes connection is configured.",
      }),
    ]);
    expect(provider.invocationCount).toBe(2);
  });
});

const topics: PreparedTopic[] = [
  { id: "case", tier: "must", text: "Select one case.", checked: false },
];

const transcript: TranscriptTurn[] = [
  {
    id: "turn-1",
    providerEventId: "fixture-1",
    speakerId: "participant",
    speakerLabel: "Participant",
    text: "The serial mismatch changed the suspect population.",
    startedAtMs: 1_000,
    endedAtMs: 4_000,
    receivedAt: "2026-08-18T16:00:04.000Z",
    final: true,
  },
];

function createService(provider: UnavailableMartyProvider): SessionService {
  let id = 0;
  return new SessionService({
    topics,
    transcript,
    provider,
    createId: () => `id-${++id}`,
  });
}
