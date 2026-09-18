import { z } from "zod";
import type { SessionState, TranscriptRef } from "./types.js";

export const contentEditSchema = z.strictObject({
  sessionId: z.string().min(1),
  mutationId: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  section: z.enum([
    "summary",
    "topics",
    "notes",
    "questions",
    "revisit",
    "metadata",
  ]),
  id: z.string().min(1).optional(),
  tier: z.enum(["must", "more"]).optional(),
  text: z.string().max(256 * 1024),
  remove: z.boolean().optional(),
  newId: z.uuid().optional(),
  afterId: z.string().min(1).max(200).nullable().optional(),
});
export type ContentEdit = z.infer<typeof contentEditSchema>;

// Plain newline entry is intentional. Existing item edits preserve internal newlines.
export function contentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(
          /^(?:(?:[-+*]|\d+[.)])\s+)?\[[ xX]\]\s*|^(?:[-+*]|\d+[.)])\s+/,
          "",
        ),
    )
    .filter(Boolean);
}
export function applyContentEdit(
  state: SessionState,
  edit: ContentEdit,
  reference: TranscriptRef,
  createId: () => string,
): SessionState {
  if (
    edit.sessionId !== state.sessionId ||
    edit.revision !== (state.contentRevision ?? 0)
  )
    throw new Error(
      "Interview content changed. Keep your draft and reload the current content before saving again.",
    );
  const next = structuredClone(state);
  next.humanContext ??= {
    title: state.lifecycle.displayName ?? "Interview",
    plannedDurationMinutes: 30,
    personSummary: [],
  };
  if (edit.section === "metadata") {
    if (edit.id || edit.remove || edit.newId || edit.afterId !== undefined)
      throw new Error("Invalid metadata edit.");
    const metadata = z
      .strictObject({
        title: z
          .string()
          .trim()
          .min(1)
          .refine(
            (title) =>
              title.length <= 200 || title === next.humanContext?.title,
            "Changed titles must be 1–200 characters; an unchanged legacy title can be kept.",
          )
          .optional(),
        plannedDurationMinutes: z
          .number()
          .int()
          .positive()
          .refine(
            (duration) =>
              duration <= 480 ||
              duration === next.humanContext?.plannedDurationMinutes,
            "Changed duration must be 1–480 minutes; an unchanged legacy duration can be kept.",
          )
          .optional(),
        displayName: z.string().trim().max(80).optional(),
      })
      .parse(JSON.parse(edit.text));
    next.humanContext = {
      ...next.humanContext,
      title: metadata.title ?? next.humanContext.title,
      plannedDurationMinutes:
        metadata.plannedDurationMinutes ??
        next.humanContext.plannedDurationMinutes,
    };
    if (metadata.displayName !== undefined)
      next.lifecycle.displayName = metadata.displayName || null;
  } else {
    const items =
      edit.section === "summary"
        ? next.humanContext.personSummary
        : next[edit.section];
    if (edit.id) {
      if (edit.newId || edit.afterId !== undefined)
        throw new Error("Invalid existing item edit.");
      const index = items.findIndex((item) => item.id === edit.id);
      const item = items[index];
      if (!item)
        throw new Error("The item no longer exists. Your draft was kept.");
      if (edit.remove) items.splice(index, 1);
      else {
        const text = edit.text.trim();
        if (!text || text.length > 4000 || text.includes("\0"))
          throw new Error(
            "Enter 1–4000 characters, or delete the text to remove the item.",
          );
        item.text = text;
        if (edit.section !== "summary")
          Object.assign(item, { humanEdited: true });
      }
    } else {
      if (edit.remove) throw new Error("Choose an item to remove.");
      const lines = contentLines(edit.text);
      if (
        !lines.length ||
        items.length + lines.length > 200 ||
        lines.some((text) => text.length > 4000 || text.includes("\0"))
      )
        throw new Error("Enter up to 200 items, each 1–4000 characters.");
      if (
        edit.newId &&
        (lines.length !== 1 ||
          [
            ...next.topics,
            ...next.notes,
            ...next.questions,
            ...next.revisit,
            ...next.humanContext.personSummary,
          ].some((item) => item.id === edit.newId))
      )
        throw new Error("Invalid or duplicate item identity.");
      const position =
        edit.afterId === null
          ? 0
          : edit.afterId === undefined
            ? items.length
            : items.findIndex((item) => item.id === edit.afterId) + 1;
      if (edit.afterId && position === 0)
        throw new Error("The preceding item changed. Your draft was kept.");
      let inserted = 0;
      for (const text of lines) {
        const base = { id: edit.newId ?? createId(), text, humanEdited: true };
        if (edit.section === "summary")
          next.humanContext.personSummary.splice(position + inserted++, 0, {
            id: base.id,
            text,
          });
        else if (edit.section === "topics")
          next.topics.splice(position + inserted++, 0, {
            ...base,
            tier: edit.tier ?? "must",
            checked: false,
          });
        else {
          const mark = {
            ...base,
            createdAt: reference.capturedAt,
            relativeMs: reference.relativeMs,
            transcriptRef: structuredClone(reference),
          };
          if (edit.section === "notes")
            next.notes.splice(position + inserted++, 0, mark);
          else
            next[edit.section].splice(position + inserted++, 0, {
              ...mark,
              checked: false,
            });
        }
      }
    }
  }
  next.contentEdited = true;
  next.contentRevision = (state.contentRevision ?? 0) + 1;
  return next;
}
