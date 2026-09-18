import request from "supertest";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import type { PreparedTopic, TranscriptTurn } from "../../src/domain/types.js";
import { createApp } from "../../src/server/app.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import { SessionService } from "../../src/server/session-service.js";

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
];

function createTestContext() {
  const provider = new FakeMartyProvider();
  const clock = new FixedClock("2026-08-18T16:00:00.000Z");
  let id = 0;
  const service = new SessionService({
    topics,
    transcript,
    provider,
    clock,
    createId: () => `id-${++id}`,
  });
  return {
    app: createApp({ service, exposeTestControls: true }),
    provider,
    service,
  };
}

describe("GET /api/health", () => {
  it("reports the local server as healthy", async () => {
    const response = await request(createTestContext().app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("session routes", () => {
  it("returns the authoritative in-memory snapshot", async () => {
    const { app } = createTestContext();
    const response = await request(app).get("/api/session");

    expect(response.status).toBe(200);
    expect(response.body.state.topics).toEqual(topics);
    expect(response.body.state.transcript).toEqual([]);
    expect(response.body.diagnostics.providerCallCount).toBe(0);
  });

  it("steps simulation and attaches literal notes and contextual commands to the latest turn", async () => {
    const { app, provider } = createTestContext();

    await request(app)
      .post("/api/session/simulation/step")
      .send({})
      .expect(200);
    await request(app)
      .post("/api/input")
      .send({ input: "/note  Exact  note.  ", mutationId: "mutation-note" })
      .expect(200);
    await request(app)
      .post("/api/input")
      .send({
        input: "/question Who approved it?",
        mutationId: "mutation-question",
      })
      .expect(200);
    await request(app)
      .post("/api/input")
      .send({ input: "/revisit The SAP join.", mutationId: "mutation-revisit" })
      .expect(200);

    const snapshot = (await request(app).get("/api/session")).body.state;
    expect(snapshot.notes[0].text).toBe("Exact  note.");
    expect(snapshot.notes[0].transcriptRef.anchorTurnId).toBe("turn-1");
    expect(snapshot.questions[0].text).toBe(
      "Ask a specific follow-up about: Who approved it?",
    );
    expect(snapshot.revisit[0].text).toBe(
      "Return to the serial-number mismatch and how it changed the exposed lots.",
    );
    expect(provider.invocationCount).toBe(2);
  });

  it("checks and restores each checkable list without provider calls", async () => {
    const { app, provider } = createTestContext();
    await request(app)
      .post("/api/input")
      .send({ input: "/question Follow up?", mutationId: "question" })
      .expect(200);
    await request(app)
      .post("/api/input")
      .send({ input: "/revisit Earlier thread", mutationId: "revisit" })
      .expect(200);

    await request(app)
      .post("/api/session/topics/case/check")
      .send({ checked: true })
      .expect(200);
    await request(app)
      .post("/api/session/questions/id-2/check")
      .send({ checked: true })
      .expect(200);
    await request(app)
      .post("/api/session/revisit/id-3/check")
      .send({ checked: true })
      .expect(200);
    await request(app)
      .post("/api/session/topics/case/check")
      .send({ checked: false })
      .expect(200);
    await request(app)
      .post("/api/session/questions/id-2/check")
      .send({ checked: false })
      .expect(200);
    await request(app)
      .post("/api/session/revisit/id-3/check")
      .send({ checked: false })
      .expect(200);

    const state = (await request(app).get("/api/session")).body.state;
    expect(state.topics[0].checked).toBe(false);
    expect(state.questions[0].checked).toBe(false);
    expect(state.revisit[0].checked).toBe(false);
    expect(provider.invocationCount).toBe(2);
  });

  it("replays the prior mutation result without duplicating state", async () => {
    const { app } = createTestContext();
    const first = await request(app)
      .post("/api/input")
      .send({ input: "/question First wording", mutationId: "same-mutation" })
      .expect(200);
    const duplicate = await request(app)
      .post("/api/input")
      .send({
        input: "/question First wording",
        mutationId: "same-mutation",
      })
      .expect(200);

    expect(duplicate.body).toEqual(first.body);
    const state = (await request(app).get("/api/session")).body.state;
    expect(state.questions.map((item: { text: string }) => item.text)).toEqual([
      "Ask a specific follow-up about: First wording",
    ]);
  });

  it("rejects unknown commands without changing state or calling the provider", async () => {
    const { app, provider } = createTestContext();
    const before = (await request(app).get("/api/session")).body.state;
    const response = await request(app)
      .post("/api/input")
      .send({ input: "/unknown value", mutationId: "invalid" });
    const after = (await request(app).get("/api/session")).body.state;

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Unknown command: /unknown");
    expect(after).toEqual(before);
    expect(provider.invocationCount).toBe(0);
  });

  it("opens an SSE stream with the current authoritative session", async () => {
    const { app } = createTestContext();
    const server = app.listen(0, "127.0.0.1");

    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP test server address.");
      }

      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/events`,
      );
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const reader = response.body?.getReader();
      const firstChunk = await reader?.read();
      const text = new TextDecoder().decode(firstChunk?.value);

      expect(text).toContain("event: session");
      expect(text).toContain('"sessionId":"id-1"');
      await reader?.cancel();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
