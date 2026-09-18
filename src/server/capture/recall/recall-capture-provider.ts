import { readFileSync } from "node:fs";
import { z } from "zod";
import { PARTICIPANT_RECORDING_NOTICE } from "../../../domain/types.js";
import type {
  CaptureProvider,
  CreateCaptureBotInput,
  RetrieveCaptureBotInput,
  RetrieveCaptureBotResult,
} from "../capture-provider.js";
import { normalizeRetrievedRecallBot } from "./normalize-retrieved-bot.js";

export const RECALL_API_ENDPOINTS = {
  "us-west-2": "https://us-west-2.recall.ai/api/v1/bot/",
} as const;

const createBotResponseSchema = z.object({ id: z.string().min(1) });
const recordingNoticeBase64 = readFileSync(
  new URL("./recording-notice.jpg", import.meta.url),
).toString("base64");

export type RecallCaptureProviderOptions = {
  region: "us-west-2";
  apiKey: string;
  webhookUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class RecallCaptureProvider implements CaptureProvider {
  readonly region: "us-west-2";
  readonly #apiKey: string;
  readonly #webhookUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: RecallCaptureProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("A Recall API key is required.");
    }

    this.region = options.region;
    this.#apiKey = apiKey;
    this.#webhookUrl = normalizeWebhookUrl(options.webhookUrl);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Recall timeout must be a positive integer.");
    }
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async createBot(input: CreateCaptureBotInput): Promise<{ botId: string }> {
    let response: Response;
    try {
      response = await this.#fetch(RECALL_API_ENDPOINTS[this.region], {
        method: "POST",
        headers: {
          Authorization: this.#apiKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          meeting_url: input.meetingUrl,
          bot_name: "Convo Caddy",
          metadata: { convo_caddy_operation_id: input.operationId },
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
                url: this.#webhookUrl,
                events: ["transcript.data"],
              },
            ],
          },
          automatic_video_output: {
            in_call_not_recording: {
              kind: "jpeg",
              b64_data: recordingNoticeBase64,
            },
            in_call_recording: {
              kind: "jpeg",
              b64_data: recordingNoticeBase64,
            },
          },
          chat: {
            on_bot_join: {
              send_to: "everyone",
              message: PARTICIPANT_RECORDING_NOTICE,
              pin: false,
            },
          },
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Error(
        "Recall bot creation failed before a response. Check the Recall dashboard before any retry.",
      );
    }

    if (response.status !== 201) {
      throw new Error(
        `Recall bot creation returned HTTP ${response.status}. Check the Recall dashboard before any retry.`,
      );
    }

    try {
      const parsed = createBotResponseSchema.parse(await response.json());
      return { botId: parsed.id };
    } catch {
      throw new Error(
        "Recall bot creation returned an invalid response. Check the Recall dashboard before any retry.",
      );
    }
  }

  async retrieveBot(
    input: RetrieveCaptureBotInput,
  ): Promise<RetrieveCaptureBotResult> {
    let response: Response;
    try {
      response = await this.#fetch(
        `${RECALL_API_ENDPOINTS[this.region]}${encodeURIComponent(input.botId)}/`,
        {
          method: "GET",
          headers: {
            Authorization: this.#apiKey,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      throw new Error(
        "The stored Recall bot could not be reconciled. Check the Recall dashboard before any recovery action.",
      );
    }
    if (response.status !== 200) {
      throw new Error(
        "The stored Recall bot could not be reconciled. Check the Recall dashboard before any recovery action.",
      );
    }
    try {
      return normalizeRetrievedRecallBot(await response.json(), input);
    } catch {
      throw new Error(
        "The stored Recall bot returned an invalid recovery response. Check the Recall dashboard before any recovery action.",
      );
    }
  }

  async stopRecordingNotice(botId: string): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(
        `${RECALL_API_ENDPOINTS[this.region]}${encodeURIComponent(botId)}/output_video/`,
        {
          method: "DELETE",
          headers: {
            Authorization: this.#apiKey,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      throw new Error("Recall recording notice could not be cleared.");
    }
    if (response.status !== 204) {
      throw new Error("Recall recording notice could not be cleared.");
    }
  }
}

function normalizeWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Recall webhook URL must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/capture/recall/webhook"
  ) {
    throw new Error(
      "Recall webhook URL must be an HTTPS /api/capture/recall/webhook endpoint.",
    );
  }
  return url.toString();
}
