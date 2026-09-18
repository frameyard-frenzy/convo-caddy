import type {
  CheckableItem,
  NoteItem,
  SessionState,
  TranscriptRef,
} from "../../domain/types.js";

type MartyTranscriptRef = Pick<TranscriptRef, "anchorTurnId" | "windowTurnIds">;

type MartyCheckableItem = Pick<
  CheckableItem,
  "text" | "checked" | "relativeMs" | "humanEdited"
> & {
  transcriptRef: MartyTranscriptRef;
};

type MartyNoteItem = Pick<NoteItem, "text" | "relativeMs" | "humanEdited"> & {
  transcriptRef: MartyTranscriptRef;
};

export type MartyContext = {
  humanContext?: {
    title: string;
    plannedDurationMinutes: number;
    personSummary: string[];
  };
  elapsedMs: number;
  topics: Array<
    Pick<SessionState["topics"][number], "tier" | "text" | "checked">
  >;
  revisit: MartyCheckableItem[];
  questions: MartyCheckableItem[];
  notes: MartyNoteItem[];
  transcript: Array<
    Pick<
      SessionState["transcript"][number],
      "id" | "speakerLabel" | "text" | "startedAtMs" | "endedAtMs"
    >
  >;
};

export function buildMartyContext(state: SessionState): MartyContext {
  return {
    ...(state.humanContext
      ? {
          humanContext: {
            ...state.humanContext,
            personSummary: state.humanContext.personSummary.map(
              (item) => item.text,
            ),
          },
        }
      : {}),
    elapsedMs: state.elapsedMs,
    topics: state.topics.map(({ tier, text, checked }) => ({
      tier,
      text,
      checked,
    })),
    revisit: state.revisit.map(toCheckableContext),
    questions: state.questions.map(toCheckableContext),
    notes: state.notes.map(
      ({ text, relativeMs, transcriptRef, humanEdited }) => ({
        ...(humanEdited ? { humanEdited } : {}),
        text,
        relativeMs,
        transcriptRef: toTranscriptRefContext(transcriptRef),
      }),
    ),
    transcript: state.transcript.map(
      ({ id, speakerLabel, text, startedAtMs, endedAtMs }) => ({
        id,
        speakerLabel,
        text,
        startedAtMs,
        endedAtMs,
      }),
    ),
  };
}

function toCheckableContext({
  text,
  checked,
  relativeMs,
  transcriptRef,
  humanEdited,
}: CheckableItem): MartyCheckableItem {
  return {
    ...(humanEdited ? { humanEdited } : {}),
    text,
    checked,
    relativeMs,
    transcriptRef: toTranscriptRefContext(transcriptRef),
  };
}

function toTranscriptRefContext({
  anchorTurnId,
  windowTurnIds,
}: TranscriptRef): MartyTranscriptRef {
  return {
    anchorTurnId,
    windowTurnIds: [...windowTurnIds],
  };
}
