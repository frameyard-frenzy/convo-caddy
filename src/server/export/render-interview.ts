import type {
  CheckableItem,
  NoteItem,
  SessionState,
} from "../../domain/types.js";
import { validateSessionReferences } from "../../domain/session-validation.js";

type RenderableMark = {
  id: string;
  kind: "Note" | "Revisit" | "Question";
  text: string;
  relativeMs: number;
  anchorTurnId: string | null;
  checked?: boolean;
  humanEdited?: boolean;
};

const kindOrder: Record<RenderableMark["kind"], number> = {
  Note: 0,
  Revisit: 1,
  Question: 2,
};

export function renderInterview(state: SessionState): string {
  validateSessionReferences(state);
  const marks = collectMarks(state);
  const byAnchor = new Map<string | null, RenderableMark[]>();
  for (const mark of marks) {
    const group = byAnchor.get(mark.anchorTurnId) ?? [];
    group.push(mark);
    byAnchor.set(mark.anchorTurnId, group);
  }

  const lines = [
    "# Convo Caddy Interview",
    "",
    `Session: \`${escapeInline(state.sessionId)}\``,
    `Started: ${state.startedAt}`,
    `Duration: ${formatTime(state.elapsedMs)}`,
  ];

  if (state.humanContext) {
    lines.push(
      "",
      `Interview: ${escapeInline(state.humanContext.title)}`,
      `Planned duration: ${state.humanContext.plannedDurationMinutes} minutes`,
      "",
      "## Person summary",
      "",
      "_Human-supplied reference context; not participant testimony._",
      "",
      ...state.humanContext.personSummary.map(
        (item) => `- ${escapeInline(item.text)}`,
      ),
      "",
      "## Prepared Questions",
    );
    for (const [tier, title] of [
      ["must", "Must"],
      ["more", "More Avenues"],
    ] as const)
      lines.push(
        "",
        `### ${title}`,
        "",
        ...state.topics
          .filter((item) => item.tier === tier)
          .map(
            (item) =>
              `- [${item.checked ? "x" : " "}] ${escapeInline(item.text)}`,
          ),
      );
  }

  const preTurnMarks = byAnchor.get(null) ?? [];
  if (preTurnMarks.length > 0) {
    lines.push("", "## Before first transcript turn", "");
    appendMarks(lines, preTurnMarks, Boolean(state.humanContext));
  }

  lines.push("", "## Transcript");
  if (state.transcript.length === 0) {
    lines.push("", "_No finalized transcript turns._");
  }

  for (const turn of state.transcript) {
    lines.push(
      "",
      `### ${formatTime(turn.startedAtMs)}–${formatTime(turn.endedAtMs)} · ${escapeInline(turn.speakerLabel)}`,
      "",
      ...turn.text.split(/\r?\n/).map((line) => `> ${escapeQuoted(line)}`),
    );
    const turnMarks = byAnchor.get(turn.id) ?? [];
    if (turnMarks.length > 0) {
      lines.push("");
      appendMarks(lines, turnMarks, Boolean(state.humanContext));
    }
  }

  return `${lines.join("\n")}\n`;
}

function collectMarks(state: SessionState): RenderableMark[] {
  const marks: RenderableMark[] = [
    ...state.notes.map((item) => noteMark(item)),
    ...state.revisit.map((item) => checkableMark("Revisit", item)),
    ...state.questions.map((item) => checkableMark("Question", item)),
  ];
  return marks.sort(
    (left, right) =>
      left.relativeMs - right.relativeMs ||
      kindOrder[left.kind] - kindOrder[right.kind] ||
      compareCodePoints(left.id, right.id),
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function noteMark(item: NoteItem): RenderableMark {
  return {
    ...(item.humanEdited ? { humanEdited: true } : {}),
    id: item.id,
    kind: "Note",
    text: item.text,
    relativeMs: item.relativeMs,
    anchorTurnId: item.transcriptRef.anchorTurnId,
  };
}

function checkableMark(
  kind: "Revisit" | "Question",
  item: CheckableItem,
): RenderableMark {
  return {
    ...(item.humanEdited ? { humanEdited: true } : {}),
    id: item.id,
    kind,
    text: item.text,
    relativeMs: item.relativeMs,
    anchorTurnId: item.transcriptRef.anchorTurnId,
    checked: item.checked,
  };
}

function appendMarks(
  lines: string[],
  marks: RenderableMark[],
  editable = false,
): void {
  for (const mark of marks) {
    const checkState =
      mark.checked === undefined ? "" : ` · ${mark.checked ? "done" : "open"}`;
    lines.push(
      `- ${editable && mark.checked !== undefined ? `[${mark.checked ? "x" : " "}] ` : ""}**${mark.kind}${mark.humanEdited ? " (human-authored edit)" : ""} · ${formatTime(mark.relativeMs)}${checkState}:** ${escapeInline(mark.text)}`,
    );
  }
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? [hours, minutes, seconds].map(pad).join(":")
    : [minutes, seconds].map(pad).join(":");
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function escapeInline(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/\r?\n/g, "<br>");
}

function escapeQuoted(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
