import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeRecallTranscriptEvent } from "../../src/server/capture/recall/normalize-transcript.js";

describe("Recall transcript normalizer", () => {
  it("normalizes the observed finalized payload without inventing provider fields", () => {
    const rawBody = readFixture("001-transcript-data.json");

    const result = normalizeRecallTranscriptEvent({
      rawBody,
      webhookId: "msg_fixture_001",
      receivedAt: "2026-08-19T04:00:00.000Z",
    });

    expect(result).toEqual({
      botId: "00000000-0000-4000-8000-000000000001",
      recordingId: "00000000-0000-4000-8000-000000000005",
      turn: {
        id: "recall:msg_fixture_001",
        providerEventId: "msg_fixture_001",
        speakerId: "1001",
        speakerLabel: "Speaker 1",
        text: Array.from(
          { length: 13 },
          (_, index) => `synthetic fixture utterance ${index + 1}`,
        ).join(" "),
        startedAtMs: 6_800,
        endedAtMs: 9_360,
        receivedAt: "2026-08-19T04:00:00.000Z",
        final: true,
      },
    });
  });

  it("normalizes every captured transcript payload as a chronological final turn", () => {
    const turns = [1, 2, 3].map((fixtureNumber) =>
      normalizeRecallTranscriptEvent({
        rawBody: readFixture(`00${fixtureNumber}-transcript-data.json`),
        webhookId: `msg_fixture_00${fixtureNumber}`,
        receivedAt: `2026-08-19T04:00:0${fixtureNumber}.000Z`,
      }),
    );

    expect(turns.map(({ turn }) => [turn.startedAtMs, turn.endedAtMs])).toEqual(
      [
        [6_800, 9_360],
        [36_960, 39_600],
        [40_640, 42_080],
      ],
    );
    expect(turns.every(({ turn }) => turn.final)).toBe(true);
    expect(new Set(turns.map(({ turn }) => turn.id)).size).toBe(3);
  });

  it("rejects events outside the observed finalized transcript contract", () => {
    expect(() =>
      normalizeRecallTranscriptEvent({
        rawBody: '{"event":"transcript.partial_data","data":{}}',
        webhookId: "msg_partial",
        receivedAt: "2026-08-19T04:00:00.000Z",
      }),
    ).toThrow("Unsupported Recall transcript event");
  });

  it("rejects an unsafe provider delivery ID before it can become a canonical ID", () => {
    expect(() =>
      normalizeRecallTranscriptEvent({
        rawBody: readFixture("001-transcript-data.json"),
        webhookId: "unsafe delivery/id",
        receivedAt: "2026-08-19T04:00:00.000Z",
      }),
    ).toThrow("Invalid Recall webhook ID");
  });
});

function readFixture(filename: string): string {
  return readFileSync(
    new URL(`../fixtures/recall/${filename}`, import.meta.url),
    "utf8",
  );
}
