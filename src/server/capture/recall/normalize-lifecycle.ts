import { z } from "zod";
import type { RecallCaptureStatus } from "../../../domain/types.js";
import type { RecallLifecycleMilestone } from "../../../domain/session-lifecycle.js";

const lifecycleEventNames = [
  "bot.joining_call",
  "bot.in_waiting_room",
  "bot.in_call_not_recording",
  "bot.recording_permission_denied",
  "bot.in_call_recording",
  "bot.call_ended",
  "transcript.done",
  "recording.done",
  "bot.done",
  "bot.fatal",
] as const;

type RecallLifecycleEventName = (typeof lifecycleEventNames)[number];

const providerResourceSchema = z.object({
  id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
});

const lifecyclePayloadSchema = z.object({
  event: z.enum(lifecycleEventNames),
  data: z.object({
    data: z.object({
      code: z.string().min(1),
      sub_code: z.string().min(1).nullable(),
      updated_at: z.string().min(1),
    }),
    bot: providerResourceSchema,
    recording: providerResourceSchema.optional(),
    transcript: providerResourceSchema.optional(),
  }),
});

const providerTimestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const eventContract: Record<
  RecallLifecycleEventName,
  {
    code: string;
    status: RecallCaptureStatus;
    recordingRequired?: true;
    transcriptRequired?: true;
    error?: string;
    milestone: RecallLifecycleMilestone | null;
  }
> = {
  "bot.joining_call": {
    code: "joining_call",
    status: "joining",
    milestone: null,
  },
  "bot.in_waiting_room": {
    code: "in_waiting_room",
    status: "waiting_room",
    milestone: null,
  },
  "bot.in_call_not_recording": {
    code: "in_call_not_recording",
    status: "in_call",
    milestone: null,
  },
  "bot.recording_permission_denied": {
    code: "recording_permission_denied",
    status: "failed",
    milestone: "provider_error",
    error:
      "Recall could not record the meeting because recording permission was denied. Remove the bot and end the call.",
  },
  "bot.in_call_recording": {
    code: "in_call_recording",
    status: "recording",
    milestone: null,
  },
  "bot.call_ended": {
    code: "call_ended",
    status: "ended",
    milestone: "call_ended",
  },
  "transcript.done": {
    code: "done",
    status: "ended",
    recordingRequired: true,
    transcriptRequired: true,
    milestone: "transcript_done",
  },
  "recording.done": {
    code: "done",
    status: "ended",
    recordingRequired: true,
    milestone: "recording_done",
  },
  "bot.done": { code: "done", status: "ended", milestone: "bot_done" },
  "bot.fatal": {
    code: "fatal",
    status: "failed",
    milestone: "provider_error",
    error:
      "The Recall bot encountered a fatal error and shut down. Remove any remaining bot from the call before recovery.",
  },
};

export type NormalizedRecallLifecycle = {
  botId: string;
  operationId?: string;
  recordingId: string | null;
  milestone: RecallLifecycleMilestone | null;
  status: RecallCaptureStatus;
  occurredAt: string;
  error?: string;
};

export function isRecallLifecycleEvent(
  event: unknown,
): event is RecallLifecycleEventName {
  return (
    typeof event === "string" &&
    (lifecycleEventNames as readonly string[]).includes(event)
  );
}

export function normalizeRecallLifecycleEvent(
  rawBody: string,
): NormalizedRecallLifecycle {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid Recall lifecycle payload.");
  }

  const event =
    typeof payload === "object" && payload !== null && "event" in payload
      ? payload.event
      : undefined;
  if (!isRecallLifecycleEvent(event)) {
    throw new Error("Unsupported Recall lifecycle event.");
  }

  const parsed = lifecyclePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid Recall lifecycle payload.");
  }

  const contract = eventContract[parsed.data.event];
  const eventData = parsed.data.data;
  if (
    eventData.data.code !== contract.code ||
    (contract.recordingRequired && eventData.recording === undefined) ||
    (contract.transcriptRequired && eventData.transcript === undefined) ||
    !providerTimestamp.test(eventData.data.updated_at)
  ) {
    throw new Error("Invalid Recall lifecycle payload.");
  }

  const occurredAt = new Date(eventData.data.updated_at);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error("Invalid Recall lifecycle payload.");
  }

  return {
    botId: eventData.bot.id,
    ...operationIdFromMetadata(eventData.bot.metadata),
    recordingId: eventData.recording?.id ?? null,
    milestone: contract.milestone,
    status: contract.status,
    occurredAt: occurredAt.toISOString(),
    ...(contract.error === undefined ? {} : { error: contract.error }),
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
