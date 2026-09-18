import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PARTICIPANT_RECORDING_NOTICE } from "../../src/domain/types.js";
import type { CreateCaptureBotInput } from "../../src/server/capture/capture-provider.js";
import {
  RecallCaptureProvider,
  RECALL_API_ENDPOINTS,
} from "../../src/server/capture/recall/recall-capture-provider.js";

const meetingUrl = "https://teams.live.com/meet/123456789?p=fixture";
const webhookUrl =
  "https://interviews.example.ngrok-free.dev/api/capture/recall/webhook";
const operationId = "00000000-0000-4000-8000-000000000099";

describe("Recall recording notice", () => {
  it("shows the exact notice through video and best-effort chat when the bot joins", async () => {
    const rawResponse = readFileSync(
      new URL(
        "../fixtures/recall/000-create-bot-response.json",
        import.meta.url,
      ),
      "utf8",
    );
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(rawResponse, { status: 201 })),
    );
    const provider = new RecallCaptureProvider({
      region: "us-west-2",
      apiKey: "private-api-key",
      webhookUrl,
      fetchImpl,
    });

    await provider.createBot({
      meetingUrl,
      operationId,
    } as CreateCaptureBotInput);

    const request = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      automatic_video_output: {
        in_call_not_recording: { kind: string; b64_data: string };
        in_call_recording: { kind: string; b64_data: string };
      };
      chat: { on_bot_join: { message: string } };
    };
    expect(body.chat.on_bot_join.message).toBe(PARTICIPANT_RECORDING_NOTICE);
    expect(body.automatic_video_output.in_call_not_recording.kind).toBe("jpeg");
    expect(body.automatic_video_output.in_call_recording).toEqual(
      body.automatic_video_output.in_call_not_recording,
    );
    expect(
      Buffer.from(
        body.automatic_video_output.in_call_recording.b64_data,
        "base64",
      ).subarray(0, 3),
    ).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("stops the notice video through the bot output endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const provider = new RecallCaptureProvider({
      region: "us-west-2",
      apiKey: "private-api-key",
      webhookUrl,
      fetchImpl,
    });

    await provider.stopRecordingNotice("00000000-0000-4000-8000-000000000001");

    expect(fetchImpl).toHaveBeenCalledWith(
      `${RECALL_API_ENDPOINTS["us-west-2"]}00000000-0000-4000-8000-000000000001/output_video/`,
      {
        method: "DELETE",
        headers: {
          Authorization: "private-api-key",
          accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      },
    );
  });
});
