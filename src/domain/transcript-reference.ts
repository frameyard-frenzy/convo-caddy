import type { TranscriptRef, TranscriptTurn } from "./types.js";

const precedingTurnLimit = 5;

export function createTranscriptRef(
  transcript: TranscriptTurn[],
  commandRelativeMs: number,
  capturedAt: string,
): TranscriptRef {
  const eligibleTurns = transcript.filter(
    (turn) => turn.endedAtMs <= commandRelativeMs,
  );
  const anchor = eligibleTurns.at(-1);

  return {
    anchorTurnId: anchor?.id ?? null,
    windowTurnIds: anchor
      ? eligibleTurns.slice(-(precedingTurnLimit + 1)).map((turn) => turn.id)
      : [],
    capturedAt,
    relativeMs: commandRelativeMs,
  };
}
