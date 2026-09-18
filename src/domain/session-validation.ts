import type { SessionState } from "./types.js";

export function validateSessionReferences(state: SessionState): void {
  const turnIds = new Set<string>();
  const providerEventIds = new Set<string>();

  for (const turn of state.transcript) {
    if (turnIds.has(turn.id)) {
      throw new Error(`Duplicate transcript turn ID "${turn.id}".`);
    }
    turnIds.add(turn.id);

    if (turn.providerEventId !== undefined) {
      if (providerEventIds.has(turn.providerEventId)) {
        throw new Error(
          `Duplicate transcript provider event ID "${turn.providerEventId}".`,
        );
      }
      providerEventIds.add(turn.providerEventId);
    }
  }

  for (const [label, items] of [
    ["Note", state.notes],
    ["Revisit", state.revisit],
    ["Question", state.questions],
  ] as const) {
    for (const item of items) {
      const { anchorTurnId, windowTurnIds } = item.transcriptRef;
      if (anchorTurnId === null && windowTurnIds.length > 0) {
        throw new Error(
          `${label} "${item.id}" has a pre-turn anchor with a non-empty transcript window.`,
        );
      }
      if (anchorTurnId !== null && !turnIds.has(anchorTurnId)) {
        throw new Error(
          `${label} "${item.id}" references missing transcript turn "${anchorTurnId}".`,
        );
      }
      for (const turnId of windowTurnIds) {
        if (!turnIds.has(turnId)) {
          throw new Error(
            `${label} "${item.id}" references missing transcript window turn "${turnId}".`,
          );
        }
      }
      if (anchorTurnId !== null && !windowTurnIds.includes(anchorTurnId)) {
        throw new Error(
          `${label} "${item.id}" transcript window does not include its anchor.`,
        );
      }
    }
  }

  for (const entry of state.chat) {
    for (const turnId of entry.citationTurnIds) {
      if (!turnIds.has(turnId)) {
        throw new Error(
          `Chat entry "${entry.id}" cites missing transcript turn "${turnId}".`,
        );
      }
    }
  }
}
