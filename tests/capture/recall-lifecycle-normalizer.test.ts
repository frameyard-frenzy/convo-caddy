import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeRecallLifecycleEvent } from "../../src/server/capture/recall/normalize-lifecycle.js";

const botId = "00000000-0000-4000-8000-000000000001";
const recordingId = "00000000-0000-4000-8000-000000000005";

describe("Recall lifecycle normalizer", () => {
  it("normalizes every observed lifecycle payload without inventing provider fields", () => {
    const cases = [
      ["004-bot-joining-call.json", "joining", null, null, 0],
      ["005-bot-in-waiting-room.json", "waiting_room", null, null, 1],
      ["006-bot-in-call-not-recording.json", "in_call", null, null, 2],
      ["007-bot-in-call-recording.json", "recording", null, null, 3],
      ["008-bot-call-ended.json", "ended", null, "call_ended", 4],
      ["009-transcript-done.json", "ended", recordingId, "transcript_done", 5],
      ["010-recording-done.json", "ended", recordingId, "recording_done", 5],
      ["011-bot-done.json", "ended", null, "bot_done", 6],
    ] as const;

    expect(
      cases.map(([filename]) =>
        normalizeRecallLifecycleEvent(readFixture(filename)),
      ),
    ).toEqual(
      cases.map(([, status, expectedRecordingId, milestone, second]) => ({
        botId,
        milestone,
        recordingId: expectedRecordingId,
        status,
        occurredAt: `2026-01-01T00:00:0${second}.000Z`,
      })),
    );
  });

  it("rejects a known event whose provider code contradicts its event name", () => {
    const payload = JSON.parse(
      readFixture("004-bot-joining-call.json"),
    ) as Record<string, unknown>;
    const data = payload.data as { data: { code: string } };
    data.data.code = "done";

    expect(() =>
      normalizeRecallLifecycleEvent(JSON.stringify(payload)),
    ).toThrow("Invalid Recall lifecycle payload");
  });

  it("normalizes the provider's offset timestamp form to canonical UTC", () => {
    const payload = JSON.parse(
      readFixture("004-bot-joining-call.json"),
    ) as Record<string, unknown>;
    const data = payload.data as { data: { updated_at: string } };
    data.data.updated_at = "2026-08-19T03:00:01.123456+00:00";

    expect(
      normalizeRecallLifecycleEvent(JSON.stringify(payload)).occurredAt,
    ).toBe("2026-08-19T03:00:01.123Z");
  });

  it.each([
    [
      "bot.recording_permission_denied",
      "recording_permission_denied",
      "Recall could not record the meeting because recording permission was denied. Remove the bot and end the call.",
    ],
    [
      "bot.fatal",
      "fatal",
      "The Recall bot encountered a fatal error and shut down. Remove any remaining bot from the call before recovery.",
    ],
  ])(
    "normalizes the documented terminal event %s as a visible failure",
    (event, code, error) => {
      const payload = JSON.parse(
        readFixture("004-bot-joining-call.json"),
      ) as Record<string, unknown>;
      payload.event = event;
      const data = payload.data as {
        data: { code: string; sub_code: string | null };
      };
      data.data.code = code;
      data.data.sub_code = "documented_failure_fixture";

      expect(normalizeRecallLifecycleEvent(JSON.stringify(payload))).toEqual({
        botId,
        error,
        milestone: "provider_error",
        recordingId: null,
        status: "failed",
        occurredAt: "2026-01-01T00:00:00.000Z",
      });
    },
  );
});

function readFixture(filename: string): string {
  return readFileSync(
    new URL(`../fixtures/recall/${filename}`, import.meta.url),
    "utf8",
  );
}
