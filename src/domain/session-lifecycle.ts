import { z } from "zod";
import type { CaptureState } from "./capture.js";

export const requiredProviderMilestones = [
  "call_ended",
  "transcript_done",
  "bot_done",
] as const;

export type RequiredProviderMilestone =
  (typeof requiredProviderMilestones)[number];

export type RecallLifecycleMilestone =
  | RequiredProviderMilestone
  | "recording_done"
  | "provider_error";

export const providerMilestonesSchema = z.strictObject({
  callEndedAt: z.iso.datetime().nullable(),
  transcriptDoneAt: z.iso.datetime().nullable(),
  recordingDoneAt: z.iso.datetime().nullable(),
  botDoneAt: z.iso.datetime().nullable(),
  providerErrorAt: z.iso.datetime().nullable(),
});

export type ProviderMilestones = z.infer<typeof providerMilestonesSchema>;

const notApplicableFinalizationSchema = z.strictObject({
  state: z.literal("not_applicable"),
});

const pendingFinalizationSchema = z.strictObject({
  state: z.literal("pending"),
});

const waitingForProviderFinalizationSchema = z.strictObject({
  state: z.literal("waiting_for_provider"),
  missing: z.array(z.enum(requiredProviderMilestones)),
});

const finalizingFinalizationSchema = z.strictObject({
  state: z.literal("finalizing"),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  directory: z.string().min(1),
});

const completeFinalizationSchema = z.strictObject({
  state: z.literal("complete"),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  directory: z.string().min(1),
});

const needsAttentionFinalizationSchema = z.strictObject({
  state: z.literal("needs_attention"),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  attemptedAt: z.iso.datetime(),
  directory: z.string().min(1),
  error: z.string().min(1),
});

export const sessionFinalizationSchema = z.discriminatedUnion("state", [
  notApplicableFinalizationSchema,
  pendingFinalizationSchema,
  waitingForProviderFinalizationSchema,
  finalizingFinalizationSchema,
  completeFinalizationSchema,
  needsAttentionFinalizationSchema,
]);

export type SessionFinalization = z.infer<typeof sessionFinalizationSchema>;

export const sessionLifecycleSchema = z.strictObject({
  displayName: z.string().min(1).max(80).nullable(),
  providerMilestones: providerMilestonesSchema,
  finalization: sessionFinalizationSchema,
});

export type SessionLifecycle = z.infer<typeof sessionLifecycleSchema>;

export function createInitialSessionLifecycle(
  captureMode: CaptureState["mode"],
): SessionLifecycle {
  return {
    displayName: null,
    providerMilestones: {
      callEndedAt: null,
      transcriptDoneAt: null,
      recordingDoneAt: null,
      botDoneAt: null,
      providerErrorAt: null,
    },
    finalization:
      captureMode === "simulation"
        ? { state: "not_applicable" }
        : { state: "pending" },
  };
}

export function missingRequiredProviderMilestones(
  milestones: ProviderMilestones,
): RequiredProviderMilestone[] {
  const observed: Record<RequiredProviderMilestone, string | null> = {
    call_ended: milestones.callEndedAt,
    transcript_done: milestones.transcriptDoneAt,
    bot_done: milestones.botDoneAt,
  };
  return requiredProviderMilestones.filter(
    (milestone) => observed[milestone] === null,
  );
}

export function recordProviderMilestone(
  milestones: ProviderMilestones,
  milestone: RecallLifecycleMilestone,
  occurredAt: string,
): ProviderMilestones {
  const milestoneKeys: Record<
    RecallLifecycleMilestone,
    keyof ProviderMilestones
  > = {
    call_ended: "callEndedAt",
    transcript_done: "transcriptDoneAt",
    recording_done: "recordingDoneAt",
    bot_done: "botDoneAt",
    provider_error: "providerErrorAt",
  };
  const key = milestoneKeys[milestone];
  const current = milestones[key];
  if (current !== null && Date.parse(current) >= Date.parse(occurredAt)) {
    return milestones;
  }
  return { ...milestones, [key]: occurredAt };
}

// Preparation ends at an established capture, not at a UI click or wall time.
// A pending creation is a write barrier; an unestablished failed creation is
// still preparation without authorizing another remote creation attempt.
export function isPreparation(
  state: import("./types.js").SessionState,
): boolean {
  const capture = state.capture;
  return (
    capture.mode === "live_ready" ||
    (capture.mode === "simulation" &&
      state.simulation.status === "idle" &&
      state.simulation.cursor === 0 &&
      !state.transcript.length) ||
    (capture.mode === "recall" &&
      capture.status === "failed" &&
      !capture.provider.botId &&
      capture.authorization.state === "pending" &&
      !state.transcript.length)
  );
}
