import { z } from "zod";
import { captureStateSchema } from "./capture.js";
import { sessionLifecycleSchema } from "./session-lifecycle.js";
import { validateSessionReferences } from "./session-validation.js";
import type { SessionState } from "./types.js";

const transcriptTurnSchema = z
  .strictObject({
    id: z.string().min(1),
    providerEventId: z.string().min(1).optional(),
    speakerId: z.string().min(1),
    speakerLabel: z.string().min(1),
    text: z.string().min(1),
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: z.number().int().nonnegative(),
    receivedAt: z.iso.datetime(),
    final: z.literal(true),
  })
  .refine((turn) => turn.endedAtMs >= turn.startedAtMs, {
    message: "Transcript turns must end after they start.",
  });

const transcriptRefSchema = z.strictObject({
  anchorTurnId: z.string().min(1).nullable(),
  windowTurnIds: z.array(z.string().min(1)),
  capturedAt: z.iso.datetime(),
  relativeMs: z.number().nonnegative(),
});

const preparedTopicSchema = z.strictObject({
  id: z.string().min(1),
  tier: z.enum(["must", "more"]),
  text: z.string().min(1),
  checked: z.boolean(),
  humanEdited: z.boolean().optional(),
});

const checkableItemSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  checked: z.boolean(),
  humanEdited: z.boolean().optional(),
  createdAt: z.iso.datetime(),
  relativeMs: z.number().nonnegative(),
  transcriptRef: transcriptRefSchema,
});

const noteItemSchema = checkableItemSchema.omit({ checked: true });

const chatEntrySchema = z
  .strictObject({
    id: z.string().min(1),
    question: z.string().min(1),
    response: z.string().min(1).nullable(),
    error: z.string().min(1).nullable(),
    citationTurnIds: z.array(z.string().min(1)),
    createdAt: z.iso.datetime(),
    relativeMs: z.number().nonnegative(),
  })
  .refine((entry) => (entry.response === null) !== (entry.error === null), {
    message: "Chat entries must contain exactly one response or error.",
  });

export const sessionStateSchema = z
  .strictObject({
    contentRevision: z.number().int().nonnegative().optional(),
    contentEdited: z.boolean().optional(),
    contentFlushRequired: z.boolean().optional(),
    humanContext: z
      .strictObject({
        // Legacy JSON prep metadata has no Markdown authoring maxima.
        title: z.string().min(1),
        plannedDurationMinutes: z.number().int().positive(),
        personSummary: z
          .array(
            z.strictObject({
              id: z.string().min(1),
              text: z.string().min(1).max(4000),
            }),
          )
          .max(200),
      })
      .optional(),
    sessionId: z.string().min(1),
    startedAt: z.iso.datetime(),
    elapsedMs: z.number().int().nonnegative(),
    topics: z.array(preparedTopicSchema),
    revisit: z.array(checkableItemSchema),
    questions: z.array(checkableItemSchema),
    notes: z.array(noteItemSchema),
    transcript: z.array(transcriptTurnSchema),
    chat: z.array(chatEntrySchema),
    capture: captureStateSchema,
    lifecycle: sessionLifecycleSchema,
    simulation: z.strictObject({
      status: z.enum(["idle", "running", "paused", "complete"]),
      cursor: z.number().int().nonnegative(),
      speed: z.number().positive(),
    }),
  })
  .superRefine((state, context) => {
    for (const [label, ids] of [
      ["Prepared topic", state.topics.map((item) => item.id)],
      [
        "Captured item",
        [
          ...state.revisit.map((item) => item.id),
          ...state.questions.map((item) => item.id),
          ...state.notes.map((item) => item.id),
        ],
      ],
      ["Chat entry", state.chat.map((item) => item.id)],
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: "custom",
          message: `${label} IDs must be unique.`,
        });
      }
    }
    const chronological = state.transcript.every(
      (turn, index) =>
        index === 0 ||
        turn.endedAtMs >= (state.transcript[index - 1]?.endedAtMs ?? 0),
    );
    if (!chronological) {
      context.addIssue({
        code: "custom",
        message: "Transcript turns must be chronological.",
      });
    }
    const providerEventIds = state.transcript.flatMap((turn) =>
      turn.providerEventId === undefined ? [] : [turn.providerEventId],
    );
    if (new Set(providerEventIds).size !== providerEventIds.length) {
      context.addIssue({
        code: "custom",
        message: "Transcript provider event IDs must be unique.",
      });
    }
    try {
      validateSessionReferences(state);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message
            : "Session references are invalid.",
      });
    }
  }) satisfies z.ZodType<SessionState>;

export function parseSessionState(value: unknown): SessionState {
  return sessionStateSchema.parse(value);
}
