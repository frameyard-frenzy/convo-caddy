import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PARTICIPANT_RECORDING_NOTICE } from "../../src/domain/types.js";
import {
  RecallCaptureProvider,
  RECALL_API_ENDPOINTS,
} from "../../src/server/capture/recall/recall-capture-provider.js";

const meetingUrl = "https://teams.live.com/meet/123456789?p=fixture";
const webhookUrl =
  "https://interviews.example.ngrok-free.dev/api/capture/recall/webhook";
const operationId = "00000000-0000-4000-8000-000000000099";

describe("RecallCaptureProvider", () => {
  it("forwards a Google Meet URL through the existing create-bot request", async () => {
    const meetUrl = "https://meet.google.com/abc-defg-hij?authuser=0";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "bot-meet-fixture" }, { status: 201 }),
    );
    const provider = new RecallCaptureProvider({
      apiKey: "fixture-key",
      region: "us-west-2",
      webhookUrl,
      fetchImpl: fetchMock,
    });

    await provider.createBot({
      meetingUrl: meetUrl,
      operationId: crypto.randomUUID(),
    });

    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      meeting_url: meetUrl,
    });
  });
  it("creates one zero-retention personal Teams bot and parses the observed response", async () => {
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

    const result = await provider.createBot({
      meetingUrl,
      operationId,
    });

    expect(result).toEqual({
      botId: "00000000-0000-4000-8000-000000000001",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(RECALL_API_ENDPOINTS["us-west-2"], {
      method: "POST",
      headers: {
        Authorization: "private-api-key",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: expect.any(String),
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      meeting_url: meetingUrl,
      bot_name: "Convo Caddy",
      metadata: { convo_caddy_operation_id: operationId },
      recording_config: {
        retention: null,
        transcript: {
          provider: {
            recallai_streaming: {
              mode: "prioritize_low_latency",
              language_code: "en",
            },
          },
          diarization: { use_separate_streams_when_available: true },
        },
        realtime_endpoints: [
          {
            type: "webhook",
            url: webhookUrl,
            events: ["transcript.data"],
          },
        ],
      },
      automatic_video_output: {
        in_call_not_recording: {
          kind: "jpeg",
          b64_data: expect.any(String),
        },
        in_call_recording: {
          kind: "jpeg",
          b64_data: expect.any(String),
        },
      },
      chat: {
        on_bot_join: {
          send_to: "everyone",
          message: PARTICIPANT_RECORDING_NOTICE,
          pin: false,
        },
      },
    });
  });

  it("does not retry or expose a provider error body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response('{"detail":"private provider response"}', {
          status: 507,
        }),
      ),
    );
    const provider = new RecallCaptureProvider({
      region: "us-west-2",
      apiKey: "private-api-key",
      webhookUrl,
      fetchImpl,
    });

    await expect(
      provider.createBot({
        meetingUrl,
        operationId,
      }),
    ).rejects.toThrow(
      "Recall bot creation returned HTTP 507. Check the Recall dashboard before any retry.",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("leaves an ambiguous create-bot timeout for dashboard inspection without retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new DOMException("private timeout detail", "TimeoutError");
    });
    const provider = new RecallCaptureProvider({
      region: "us-west-2",
      apiKey: "private-api-key",
      webhookUrl,
      fetchImpl,
    });

    await expect(
      provider.createBot({ meetingUrl, operationId }),
    ).rejects.toThrow(
      "Recall bot creation failed before a response. Check the Recall dashboard before any retry.",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retrieves one stored bot read-only and normalizes documented status and artifact proof", async () => {
    const botId = "00000000-0000-4000-8000-000000000001";
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        Response.json({
          id: botId,
          metadata: { convo_caddy_operation_id: operationId },
          status_changes: [
            {
              code: "call_ended",
              message: null,
              sub_code: null,
              created_at: "2026-08-25T12:00:04.000Z",
            },
            {
              code: "done",
              message: null,
              sub_code: null,
              created_at: "2026-08-25T12:00:06.000Z",
            },
          ],
          recordings: [
            {
              id: "00000000-0000-4000-8000-000000000005",
              status: {
                code: "done",
                sub_code: null,
                updated_at: "2026-08-25T12:00:05.000Z",
              },
              media_shortcuts: {
                transcript: {
                  status: {
                    code: "done",
                    sub_code: null,
                    updated_at: "2026-08-25T12:00:05.000Z",
                  },
                },
              },
            },
          ],
        }),
      ),
    );
    const provider = new RecallCaptureProvider({
      region: "us-west-2",
      apiKey: "private-api-key",
      webhookUrl,
      fetchImpl,
    });

    await expect(
      provider.retrieveBot({ botId, operationId }),
    ).resolves.toMatchObject({
      botId,
      operationId,
      observations: [
        { milestone: "call_ended", occurredAt: "2026-08-25T12:00:04.000Z" },
        {
          milestone: "recording_done",
          occurredAt: "2026-08-25T12:00:05.000Z",
        },
        {
          milestone: "transcript_done",
          occurredAt: "2026-08-25T12:00:05.000Z",
        },
        { milestone: "bot_done", occurredAt: "2026-08-25T12:00:06.000Z" },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      `${RECALL_API_ENDPOINTS["us-west-2"]}${botId}/`,
      {
        method: "GET",
        headers: {
          Authorization: "private-api-key",
          accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("does not retry or expose provider detail when the recovery read fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("private network detail");
    });
    const provider = new RecallCaptureProvider({
      region: "us-west-2",
      apiKey: "private-api-key",
      webhookUrl,
      fetchImpl,
    });

    await expect(
      provider.retrieveBot({
        botId: "00000000-0000-4000-8000-000000000001",
        operationId,
      }),
    ).rejects.toThrow(
      "The stored Recall bot could not be reconciled. Check the Recall dashboard before any recovery action.",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
