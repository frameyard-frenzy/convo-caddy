import { z } from "zod";

export const PARTICIPANT_RECORDING_NOTICE =
  "Convo Caddy is recording and transcribing this conversation.";

export const RECORDING_NOTICE_DISPLAY_MS = 10_000;

export const recallRegionSchema = z.enum([
  "us-west-2",
  "us-east-1",
  "eu-central-1",
  "ap-northeast-1",
]);

export const recallCaptureStatusSchema = z.enum([
  "creating",
  "joining",
  "waiting_room",
  "in_call",
  "recording",
  "ended",
  "failed",
]);

const liveReadyCaptureSchema = z.strictObject({
  mode: z.literal("live_ready"),
  meetingPlatform: z.literal("microsoft_teams_personal"),
  recording: z.strictObject({ location: z.null(), retention: z.null() }),
});

const simulationCaptureSchema = z.strictObject({
  mode: z.literal("simulation"),
  authorization: z.strictObject({
    method: z.literal("not_required_synthetic"),
    state: z.literal("not_required"),
    admittedAt: z.null(),
  }),
  recording: z.strictObject({ location: z.null(), retention: z.null() }),
});

const recallCaptureShape = {
  mode: z.literal("recall"),
  operationId: z.string().uuid().optional(),
  status: recallCaptureStatusSchema,
  authorization: z.discriminatedUnion("state", [
    z.strictObject({
      method: z.literal("operator_admission"),
      state: z.literal("pending"),
      admittedAt: z.null(),
    }),
    z.strictObject({
      method: z.literal("operator_admission"),
      state: z.literal("confirmed"),
      admittedAt: z.iso.datetime(),
    }),
  ]),
  notice: z.discriminatedUnion("state", [
    z.strictObject({
      text: z.literal(PARTICIPANT_RECORDING_NOTICE),
      displayDurationMs: z.literal(RECORDING_NOTICE_DISPLAY_MS),
      delivery: z.literal("video_with_chat_fallback"),
      state: z.literal("pending"),
      displayedAt: z.null(),
      clearedAt: z.null(),
      error: z.null(),
    }),
    z.strictObject({
      text: z.literal(PARTICIPANT_RECORDING_NOTICE),
      displayDurationMs: z.literal(RECORDING_NOTICE_DISPLAY_MS),
      delivery: z.literal("video_with_chat_fallback"),
      state: z.literal("displaying"),
      displayedAt: z.iso.datetime(),
      clearedAt: z.null(),
      error: z.null(),
    }),
    z.strictObject({
      text: z.literal(PARTICIPANT_RECORDING_NOTICE),
      displayDurationMs: z.literal(RECORDING_NOTICE_DISPLAY_MS),
      delivery: z.literal("video_with_chat_fallback"),
      state: z.literal("cleared"),
      displayedAt: z.iso.datetime(),
      clearedAt: z.iso.datetime(),
      error: z.null(),
    }),
    z.strictObject({
      text: z.literal(PARTICIPANT_RECORDING_NOTICE),
      displayDurationMs: z.literal(RECORDING_NOTICE_DISPLAY_MS),
      delivery: z.literal("video_with_chat_fallback"),
      state: z.literal("failed"),
      displayedAt: z.iso.datetime(),
      clearedAt: z.null(),
      error: z.string().min(1),
    }),
  ]),
  provider: z.strictObject({
    name: z.literal("recall_ai"),
    region: recallRegionSchema,
    botId: z.string().min(1).nullable(),
    recordingId: z.string().min(1).nullable(),
  }),
  meetingPlatform: z.literal("microsoft_teams_personal"),
  lastEventAt: z.iso.datetime(),
  error: z.string().min(1).nullable(),
} as const;

export const captureStateV5Schema = z.discriminatedUnion("mode", [
  liveReadyCaptureSchema,
  simulationCaptureSchema,
  z.strictObject({
    ...recallCaptureShape,
    recording: z.strictObject({
      location: z.literal("recall_ai"),
      retention: z.literal("zero_data"),
    }),
  }),
]);

export const recallRecordingRetentionSchema = z.strictObject({
  requestedMedia: z.literal("none"),
  providerConfirmed: z.literal(false),
  accountMetadata: z.literal("unknown"),
});

export const captureStateSchema = z.discriminatedUnion("mode", [
  liveReadyCaptureSchema,
  simulationCaptureSchema,
  z.strictObject({
    ...recallCaptureShape,
    recording: z.strictObject({
      location: z.literal("recall_ai"),
      retention: recallRecordingRetentionSchema,
    }),
  }),
]);

export const UNVERIFIED_RECALL_RECORDING_RETENTION = {
  requestedMedia: "none",
  providerConfirmed: false,
  accountMetadata: "unknown",
} as const;

export type RecallRegion = z.infer<typeof recallRegionSchema>;
export type RecallCaptureStatus = z.infer<typeof recallCaptureStatusSchema>;
export type CaptureState = z.infer<typeof captureStateSchema>;
