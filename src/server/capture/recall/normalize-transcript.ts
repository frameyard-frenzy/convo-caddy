import { z } from "zod";
import type { TranscriptTurn } from "../../../domain/types.js";

const relativeTimestampSchema = z.object({
  relative: z.number().finite().nonnegative(),
  absolute: z.iso.datetime().optional(),
});

const wordSchema = z.object({
  text: z.string(),
  start_timestamp: relativeTimestampSchema,
  end_timestamp: relativeTimestampSchema.nullable(),
});

const transcriptDataSchema = z.object({
  event: z.literal("transcript.data"),
  data: z.object({
    data: z.object({
      words: z.array(wordSchema).min(1),
      language_code: z.string().min(1),
      participant: z.object({
        id: z.number().int(),
        name: z.string().nullable(),
        is_host: z.boolean(),
      }),
    }),
    recording: z.object({ id: z.string().min(1) }),
    bot: z.object({
      id: z.string().min(1),
      metadata: z.record(z.string(), z.unknown()),
    }),
  }),
});

export type NormalizeRecallTranscriptInput = {
  rawBody: string;
  webhookId: string;
  receivedAt: string;
};

export type NormalizedRecallTranscript = {
  botId: string;
  operationId?: string;
  recordingId: string;
  turn: TranscriptTurn;
};

export function normalizeRecallTranscriptEvent(
  input: NormalizeRecallTranscriptInput,
): NormalizedRecallTranscript {
  const webhookId = input.webhookId;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(webhookId)) {
    throw new Error("Invalid Recall webhook ID.");
  }
  const receivedAt = z.iso.datetime().parse(input.receivedAt);
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    throw new Error("Invalid Recall transcript payload.");
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("event" in payload) ||
    payload.event !== "transcript.data"
  ) {
    throw new Error("Unsupported Recall transcript event.");
  }

  const parsed = transcriptDataSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid Recall transcript payload.");
  }

  const { words, participant } = parsed.data.data.data;
  const firstWord = words[0];
  const lastWord = words.at(-1);
  if (!firstWord || !lastWord) {
    throw new Error("Invalid Recall transcript payload.");
  }
  const text = words
    .map((word) => word.text)
    .join(" ")
    .trim();
  if (!text) {
    throw new Error("Invalid Recall transcript payload.");
  }

  const startedAtMs = Math.round(firstWord.start_timestamp.relative * 1_000);
  const endedAtMs = Math.round(
    (lastWord.end_timestamp?.relative ?? lastWord.start_timestamp.relative) *
      1_000,
  );
  if (endedAtMs < startedAtMs) {
    throw new Error("Invalid Recall transcript payload.");
  }

  return {
    botId: parsed.data.data.bot.id,
    ...operationIdFromMetadata(parsed.data.data.bot.metadata),
    recordingId: parsed.data.data.recording.id,
    turn: {
      id: `recall:${webhookId}`,
      providerEventId: webhookId,
      speakerId: String(participant.id),
      speakerLabel:
        participant.name?.trim() || `Speaker ${String(participant.id)}`,
      text,
      startedAtMs,
      endedAtMs,
      receivedAt,
      final: true,
    },
  };
}

function operationIdFromMetadata(metadata: Record<string, unknown>): {
  operationId?: string;
} {
  const operationId = metadata.convo_caddy_operation_id;
  return typeof operationId === "string" && operationId.length > 0
    ? { operationId }
    : {};
}
