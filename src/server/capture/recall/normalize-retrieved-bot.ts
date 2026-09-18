import { z } from "zod";
import type {
  CaptureBotObservation,
  RetrieveCaptureBotInput,
  RetrieveCaptureBotResult,
} from "../capture-provider.js";

const providerTimestampSchema = z.iso.datetime({ offset: true });
const artifactStatusSchema = z.object({
  code: z.enum(["processing", "paused", "done", "failed", "deleted"]),
  sub_code: z.string().nullable(),
  updated_at: providerTimestampSchema,
});
const retrievedBotSchema = z.object({
  id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
  status_changes: z.array(
    z.object({
      code: z.string().min(1),
      message: z.string().nullable(),
      sub_code: z.string().nullable(),
      created_at: providerTimestampSchema,
    }),
  ),
  recordings: z.array(
    z.object({
      id: z.string().min(1),
      status: artifactStatusSchema.nullable(),
      media_shortcuts: z
        .object({
          transcript: z
            .object({ status: artifactStatusSchema })
            .nullable()
            .optional(),
        })
        .nullable(),
    }),
  ),
});

export function normalizeRetrievedRecallBot(
  payload: unknown,
  expected: RetrieveCaptureBotInput,
): RetrieveCaptureBotResult {
  const parsed = retrievedBotSchema.parse(payload);
  const operationId = parsed.metadata.convo_caddy_operation_id;
  if (parsed.id !== expected.botId || operationId !== expected.operationId) {
    throw new Error(
      "Retrieved Recall bot identity does not match the session.",
    );
  }

  const observations: CaptureBotObservation[] = [];
  for (const change of parsed.status_changes) {
    const observation = normalizeBotStatus(
      change.code,
      change.created_at,
      expected,
    );
    if (observation) {
      observations.push(observation);
    }
  }
  for (const recording of parsed.recordings) {
    if (recording.status?.code === "done") {
      observations.push({
        ...observationBase(expected, recording.status.updated_at),
        recordingId: recording.id,
        status: "ended",
        milestone: "recording_done",
      });
    } else if (recording.status?.code === "failed") {
      observations.push({
        ...observationBase(expected, recording.status.updated_at),
        recordingId: recording.id,
        status: "failed",
        milestone: "provider_error",
        error: "Recall reported a recording artifact failure.",
      });
    }
    const transcript = recording.media_shortcuts?.transcript;
    if (transcript?.status.code === "done") {
      observations.push({
        ...observationBase(expected, transcript.status.updated_at),
        recordingId: recording.id,
        status: "ended",
        milestone: "transcript_done",
      });
    } else if (transcript?.status.code === "failed") {
      observations.push({
        ...observationBase(expected, transcript.status.updated_at),
        recordingId: recording.id,
        status: "failed",
        milestone: "provider_error",
        error: "Recall reported a transcript artifact failure.",
      });
    }
  }
  observations.sort(
    (left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
  );
  return { ...expected, observations };
}

function normalizeBotStatus(
  code: string,
  occurredAt: string,
  expected: RetrieveCaptureBotInput,
): CaptureBotObservation | null {
  const base = observationBase(expected, occurredAt);
  switch (code) {
    case "joining_call":
      return { ...base, status: "joining", milestone: null };
    case "in_waiting_room":
      return { ...base, status: "waiting_room", milestone: null };
    case "in_call_not_recording":
      return { ...base, status: "in_call", milestone: null };
    case "in_call_recording":
      return { ...base, status: "recording", milestone: null };
    case "call_ended":
      return { ...base, status: "ended", milestone: "call_ended" };
    case "done":
      return { ...base, status: "ended", milestone: "bot_done" };
    case "recording_permission_denied":
      return {
        ...base,
        status: "failed",
        milestone: "provider_error",
        error:
          "Recall could not record the meeting because recording permission was denied.",
      };
    case "fatal":
      return {
        ...base,
        status: "failed",
        milestone: "provider_error",
        error: "The Recall bot encountered a fatal error.",
      };
    default:
      return null;
  }
}

function observationBase(
  expected: RetrieveCaptureBotInput,
  occurredAt: string,
): Pick<
  CaptureBotObservation,
  "botId" | "operationId" | "recordingId" | "occurredAt"
> {
  return {
    ...expected,
    recordingId: null,
    occurredAt: new Date(occurredAt).toISOString(),
  };
}
