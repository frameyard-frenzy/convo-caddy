import { contentLines, type ContentEdit } from "../domain/content-edit.js";
import type { SessionState, NoteItem } from "../domain/types.js";

type Section = Exclude<ContentEdit["section"], "metadata">;
type Row = {
  id: string;
  section: Section;
  tier?: "must" | "more";
  text: string;
  base?: string;
  deleted?: boolean;
  placeholder?: boolean;
  conflict?: boolean;
  sent?: string;
  element?: HTMLLIElement;
};
type Field = "title" | "plannedDurationMinutes" | "displayName";
type Metadata = {
  text: string;
  base: string;
  sent?: string;
  conflict?: boolean;
};
const labels: Record<Section, string> = {
  summary: "Person summary",
  topics: "Prepared question",
  notes: "Note",
  questions: "Question",
  revisit: "Revisit",
};
const conflict =
  "Interview content changed. Your draft was kept. Press Escape in the affected text to use the current saved content, or copy your draft before reloading.";

/** Local drafts live independently of snapshots. Only acknowledged versions become
 * clean; SSE may update other rows without replacing an active editing node. */
export class ContentEditor {
  rows: Row[] = [];
  checks = new Map<string, boolean>();
  metadata: Record<Field, Metadata> | null = null;
  state!: SessionState;
  sessionId = "";
  composing = false;
  private compositionFinished: Array<() => void> = [];
  locked = false;
  private undoStructure: (() => void) | null = null;
  private pending: {
    edit: ContentEdit;
    row?: Row;
    field?: Field;
    text: string;
    raw: string;
  } | null = null;
  private flushing: Promise<void> | null = null;
  private refresh: () => void = () => {};
  constructor(private changed: () => void) {}

  sync(state: SessionState): void {
    if (this.sessionId && this.sessionId !== state.sessionId && this.dirty)
      throw new Error(
        "The interview changed while you were typing. Copy your draft before reloading.",
      );
    if (this.sessionId !== state.sessionId) {
      this.rows = [];
      this.metadata = null;
      this.sessionId = state.sessionId;
    }
    // A selected-prep/capture refresh is a semantic boundary, even if the
    // particular positional question being edited happens to retain its text.
    // Ordinary unrelated saved edits can reconcile per item; prep refresh cannot.
    if (
      this.state &&
      this.state.sessionId === state.sessionId &&
      !state.contentEdited &&
      (this.state.contentRevision ?? 0) !== (state.contentRevision ?? 0)
    ) {
      for (const row of this.rows)
        if (row.deleted || row.text !== (row.base ?? "")) row.conflict = true;
      if (this.metadata)
        for (const field of Object.values(this.metadata))
          if (field.text !== field.base) field.conflict = true;
    }
    this.state = state;
    for (const section of [
      "summary",
      "topics",
      "notes",
      "questions",
      "revisit",
    ] as const) {
      const items =
        section === "summary"
          ? (state.humanContext?.personSummary ?? [])
          : state[section];
      for (const item of items) {
        const row = this.rows.find(
          (r) => r.section === section && r.id === item.id,
        );
        if (!row)
          this.rows.push({
            id: item.id,
            section,
            text: item.text,
            base: item.text,
            ...("tier" in item ? { tier: item.tier as "must" | "more" } : {}),
          });
        // A later input can return to the old base while a different value is
        // in flight. Recognize that acknowledgement before testing cleanliness.
        else if (item.text === row.sent) {
          row.base = item.text;
          row.conflict = false;
        } else if (
          row.sent === undefined &&
          row.text === row.base &&
          !row.deleted &&
          !row.conflict
        ) {
          row.text = item.text;
          row.base = item.text;
        } else if (item.text !== row.base) row.conflict = true;
      }
      if (items.length)
        this.rows = this.rows.filter(
          (row) =>
            !(
              row.section === section &&
              row.placeholder &&
              row.base === undefined &&
              !row.text &&
              !row.element?.contains(document.activeElement)
            ),
        );
      for (const row of this.rows.filter(
        (r) =>
          r.section === section &&
          r.base !== undefined &&
          !items.some((i) => i.id === r.id),
      )) {
        if (this.pending?.row === row && this.pending.edit.remove) {
          // SSE may precede the removal response. Keep later replacement typing
          // and the old base until HTTP confirms this page's successful removal.
          continue;
        } else if (row.text !== row.base) row.conflict = true;
        else this.rows = this.rows.filter((r) => r !== row);
      }
    }
    const values = this.values(state);
    if (!this.metadata)
      this.metadata = Object.fromEntries(
        Object.entries(values).map(([k, text]) => [k, { text, base: text }]),
      ) as Record<Field, Metadata>;
    else
      for (const field of Object.keys(values) as Field[]) {
        const draft = this.metadata[field],
          current = values[field];
        if (current === draft.sent) {
          draft.base = current;
          draft.conflict = false;
        } else if (
          draft.sent === undefined &&
          draft.text === draft.base &&
          !draft.conflict
        )
          draft.text = draft.base = current;
        else if (current !== draft.base) draft.conflict = true;
      }
  }
  private values(state: SessionState): Record<Field, string> {
    return {
      title:
        state.humanContext?.title ?? state.lifecycle.displayName ?? "Interview",
      plannedDurationMinutes: String(
        state.humanContext?.plannedDurationMinutes ?? 30,
      ),
      displayName: state.lifecycle.displayName ?? "",
    };
  }
  get dirty(): boolean {
    return Boolean(
      this.pending ||
        this.rows.some((r) =>
          r.deleted
            ? r.base !== undefined
            : r.text !== (r.base ?? "") || r.conflict,
        ) ||
        (this.metadata &&
          Object.values(this.metadata).some(
            (f) => f.text !== f.base || f.conflict,
          )),
    );
  }
  async flush(
    send: (edit: ContentEdit) => Promise<{ state: SessionState }>,
    accept: (state: SessionState) => void,
  ): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain(send, accept).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  private async drain(
    send: (edit: ContentEdit) => Promise<{ state: SessionState }>,
    accept: (state: SessionState) => void,
  ): Promise<void> {
    for (;;) {
      if (this.composing)
        await new Promise<void>((resolve) =>
          this.compositionFinished.push(resolve),
        );
      if (!this.pending) {
        const row = this.rows.find((r) =>
          r.deleted
            ? r.base !== undefined
            : r.text !== (r.base ?? "") || r.conflict,
        );
        // A reused prep can carry an unavailable name. Validate its correction
        // before other drafts, but never replace an uncertain pending mutation.
        const field =
          this.metadata &&
          (["displayName", "title", "plannedDurationMinutes"] as const).find(
            (k) =>
              this.metadata![k].text !== this.metadata![k].base ||
              this.metadata![k].conflict,
          );
        const common = {
          sessionId: this.sessionId,
          revision: this.state.contentRevision ?? 0,
          mutationId: crypto.randomUUID(),
        };
        if (row && field !== "displayName") {
          if (row.conflict) throw new Error(conflict);
          const text = row.deleted
            ? ""
            : row.base === undefined
              ? contentLines(row.text).join("\n")
              : row.text.trim();
          if (row.base === undefined && !text) {
            row.text = "";
            continue;
          }
          const preceding = this.rows
            .slice(0, this.rows.indexOf(row))
            .filter(
              (r) =>
                r.section === row.section &&
                !r.deleted &&
                (r.base !== undefined || r.text.trim()),
            );
          const edit: ContentEdit = {
            ...common,
            section: row.section,
            text,
            ...(row.tier ? { tier: row.tier } : {}),
            ...(row.base !== undefined
              ? { id: row.id, ...(!text ? { remove: true } : {}) }
              : { newId: row.id, afterId: preceding.at(-1)?.id ?? null }),
          };
          row.sent = text;
          this.pending = { edit, row, text, raw: row.text };
        } else if (field && this.metadata) {
          const draft = this.metadata[field];
          if (draft.conflict) throw new Error(conflict);
          const text =
            field === "plannedDurationMinutes"
              ? String(Number(draft.text))
              : field === "displayName"
                ? draft.text
                : draft.text.trim();
          draft.sent = text;
          this.pending = {
            edit: {
              ...common,
              section: "metadata",
              text: JSON.stringify({
                [field]:
                  field === "plannedDurationMinutes" ? Number(text) : text,
              }),
            },
            field,
            text,
            raw: draft.text,
          };
        } else return;
      }
      this.undoStructure = null;
      const pending = this.pending;
      let response: { state: SessionState };
      try {
        response = await send(pending.edit);
      } catch (error) {
        if (
          error instanceof Error &&
          "status" in error &&
          (error.status === 409 || error.status === 413)
        ) {
          if (pending.row) pending.row.sent = undefined;
          if (pending.field && this.metadata)
            this.metadata[pending.field].sent = undefined;
          this.pending = null;
        }
        throw error;
      }
      // This acknowledgement belongs to the submitted version, never later typing.
      if (pending.row) {
        const row = pending.row;
        if (pending.edit.remove) {
          // Only our confirmed successful removal cancels its queued check.
          // A competing disappearance must still fail visibly in flushChecks.
          this.checks.delete(row.id);
          row.base = undefined;
          if (!row.text.trim() || row.deleted)
            this.rows = this.rows.filter((r) => r !== row);
          else {
            // Removal already committed: later typing is an intentional new
            // item, never resurrection of the removed identity/check/reference.
            row.id = crypto.randomUUID();
            row.element?.querySelector(".context-button")?.remove();
          }
        } else {
          row.base = pending.text;
          if (row.text === pending.raw) row.text = pending.text;
        }
        row.sent = undefined;
      } else if (pending.field && this.metadata) {
        this.metadata[pending.field].base = pending.text;
        if (this.metadata[pending.field].text === pending.raw)
          this.metadata[pending.field].text = pending.text;
        this.metadata[pending.field].sent = undefined;
      }
      this.pending = null;
      accept(response.state);
      this.sync(this.state);
      this.refresh();
    }
  }

  render(
    workspace: HTMLElement,
    state: SessionState,
    check: (
      section: "topics" | "questions" | "revisit",
      id: string,
      checked: boolean,
    ) => void,
    context: (ids: string[] | null) => void,
  ): void {
    this.sync(state);
    this.refresh = () => this.render(workspace, this.state, check, context);
    const mutable =
      !["complete", "finalizing", "needs_attention"].includes(
        state.lifecycle.finalization.state,
      ) && !this.locked;
    const column = workspace.querySelector<HTMLElement>(".prepared-column")!;
    let summary = column.querySelector<HTMLElement>(".person-summary");
    if (!summary) {
      summary = document.createElement("section");
      summary.className = "panel person-summary";
      summary.innerHTML =
        '<h2 id="person-summary-heading">Person summary</h2><ul class="summary-list"></ul>';
      summary.setAttribute("aria-labelledby", "person-summary-heading");
      column.prepend(summary);
    }
    for (const [section, tier, container] of [
      ["summary", undefined, summary],
      [
        "topics",
        "must",
        workspace.querySelectorAll<HTMLElement>(".topic-tier")[0]!,
      ],
      [
        "topics",
        "more",
        workspace.querySelectorAll<HTMLElement>(".topic-tier")[1]!,
      ],
      ...(["revisit", "questions", "notes"] as const).map(
        (s) =>
          [
            s,
            undefined,
            workspace.querySelector<HTMLElement>(`.${s}`)!,
          ] as const,
      ),
    ] as const) {
      container.querySelector(".empty-state")?.remove();
      let list = container.querySelector<HTMLUListElement>("ul");
      if (!list) {
        list = document.createElement("ul");
        list.className = section === "notes" ? "notes-list" : "checklist";
        container.append(list);
      }
      if (!list.dataset.inline) {
        list.replaceChildren();
        list.dataset.inline = "true";
      }
      let rows = this.rows.filter(
        (r) => r.section === section && r.tier === tier && !r.deleted,
      );
      if (!rows.length && mutable) {
        const row: Row = {
          id: crypto.randomUUID(),
          section,
          text: "",
          placeholder: true,
          ...(tier ? { tier } : {}),
        };
        this.rows.push(row);
        rows = [row];
      }
      for (const child of [...list.children])
        if (!rows.some((r) => r.element === child)) child.remove();
      let cursor = list.firstChild;
      for (const row of rows) {
        if (!row.element) {
          const li = document.createElement("li");
          row.element = li;
          li.dataset.rowId = row.id;
          li.className =
            section === "summary"
              ? "summary-item"
              : section === "notes"
                ? "note-item"
                : "check-item";
          const line = document.createElement("div");
          line.className = "inline-line";
          if (!["summary", "notes"].includes(section)) {
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.id = `check-${row.id}`;
            checkbox.addEventListener("change", () => {
              this.checks.set(row.id, checkbox.checked);
              check(
                section as "topics" | "questions" | "revisit",
                row.id,
                checkbox.checked,
              );
            });
            line.append(checkbox);
          }
          const el = this.textbox(`${labels[section]} text`);
          el.id = `text-${row.id}`;
          el.dataset.placeholder =
            section === "summary"
              ? "Person summary…"
              : section === "topics"
                ? "Question…"
                : `No ${section} yet.`;
          el.addEventListener("input", () => {
            this.undoStructure = null;
            row.text = el.innerText;
            row.element!.dataset.empty = String(!row.text);
            this.changed();
          });
          el.addEventListener("keydown", (event) => this.key(event, row, el));
          el.addEventListener("paste", (event) => {
            event.preventDefault();
            this.paste(
              row,
              el,
              event.clipboardData?.getData("text/plain") ?? "",
            );
          });
          line.append(el);
          li.append(line);
        }
        row.element.dataset.rowId = row.id;
        const el = row.element.querySelector<HTMLElement>("[role=textbox]")!;
        el.id = `text-${row.id}`;
        if (el.innerText !== row.text) el.textContent = row.text;
        el.contentEditable = mutable ? "plaintext-only" : "false";
        el.setAttribute("aria-readonly", String(!mutable));
        row.element.dataset.empty = String(!row.text);
        const saved =
          section === "summary"
            ? state.humanContext?.personSummary.find((i) => i.id === row.id)
            : state[section].find((i) => i.id === row.id);
        const checkbox = row.element.querySelector<HTMLInputElement>("input");
        if (checkbox) {
          checkbox.id = `check-${row.id}`;
          const checked = Boolean(saved && "checked" in saved && saved.checked);
          checkbox.checked = this.checks.get(row.id) ?? checked;
          checkbox.disabled = !mutable;
          checkbox.setAttribute("aria-label", row.text || "Empty question");
          row.element.classList.toggle("checked", checkbox.checked);
        }
        if (
          saved &&
          "transcriptRef" in saved &&
          !row.element.querySelector(".context-button")
        ) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "context-button";
          const mark = saved as NoteItem;
          const seconds = Math.floor(mark.relativeMs / 1000);
          b.textContent = `Context ${[Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, "0")).join(":")}`;
          b.disabled = !mark.transcriptRef.windowTurnIds.length;
          b.addEventListener("click", () =>
            context(mark.transcriptRef.windowTurnIds),
          );
          row.element.append(b);
        }
        if (saved && "humanEdited" in saved && saved.humanEdited)
          el.title = "Edited by you";
        if (row.element !== cursor) list.insertBefore(row.element, cursor);
        cursor = row.element.nextSibling;
      }
      container.onclick = (event) => {
        if (mutable && (event.target === container || event.target === list)) {
          const last = rows.at(-1);
          if (last && !last.text) this.focus(last, 0);
          else {
            const row: Row = {
              id: crypto.randomUUID(),
              section,
              text: "",
              ...(tier ? { tier } : {}),
            };
            this.rows.push(row);
            this.refresh();
            this.focus(row, 0);
          }
        }
      };
    }
  }
  renderMetadata(metadata: HTMLElement, state: SessionState): void {
    this.sync(state);
    const mutable =
      !["complete", "finalizing", "needs_attention"].includes(
        state.lifecycle.finalization.state,
      ) && !this.locked;
    metadata.classList.add("interview-metadata");
    if (!metadata.querySelector("[data-field]")) metadata.replaceChildren();
    if (!metadata.childNodes.length) {
      for (const [field, label] of [
        ["title", "Interview title"],
        ["plannedDurationMinutes", "Planned minutes"],
        ["displayName", "Saved interview name (optional)"],
      ] as const) {
        if (field === "plannedDurationMinutes") metadata.append(" · ");
        if (field === "displayName") metadata.append(" · ");
        const el = this.textbox(label);
        el.dataset.field = field;
        el.addEventListener("input", () => {
          this.metadata![field].text = el.innerText;
          this.changed();
        });
        el.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            el.blur();
          }
          if (event.key === "Escape") {
            this.metadata![field] = {
              text: this.values(this.state)[field],
              base: this.values(this.state)[field],
            };
            el.textContent = this.metadata![field].text;
          }
        });
        if (field === "displayName") el.dataset.placeholder = "Interview name";
        metadata.append(el);
        if (field === "plannedDurationMinutes") metadata.append(" minutes");
      }
    }
    for (const el of metadata.querySelectorAll<HTMLElement>("[data-field]")) {
      const draft = this.metadata![el.dataset.field as Field];
      if (el.innerText !== draft.text) el.textContent = draft.text;
      el.contentEditable = mutable ? "plaintext-only" : "false";
      el.setAttribute("aria-readonly", String(!mutable));
    }
  }
  private textbox(label: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = "inline-text";
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-label", label);
    el.setAttribute("aria-multiline", "true");
    el.tabIndex = 0;
    el.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    el.addEventListener("compositionend", () => {
      this.composing = false;
      for (const resolve of this.compositionFinished.splice(0)) resolve();
      this.changed();
    });
    return el;
  }
  private selection(el: HTMLElement): { start: number; end: number } {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !el.contains(selection.anchorNode))
      return { start: el.innerText.length, end: el.innerText.length };
    const range = selection.getRangeAt(0);
    const before = range.cloneRange();
    before.selectNodeContents(el);
    before.setEnd(range.startContainer, range.startOffset);
    return {
      start: before.toString().length,
      end: before.toString().length + range.toString().length,
    };
  }
  private focus(row: Row, offset: number): void {
    const el = row.element!.querySelector<HTMLElement>("[role=textbox]")!;
    el.focus();
    if (!el.firstChild) el.append(document.createTextNode(""));
    const range = document.createRange();
    range.setStart(
      el.firstChild!,
      Math.min(offset, el.firstChild!.textContent?.length ?? 0),
    );
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }
  private key(event: KeyboardEvent, row: Row, el: HTMLElement): void {
    if (
      event.isComposing ||
      this.composing ||
      el.contentEditable !== "plaintext-only"
    )
      return;
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "z" &&
      !event.shiftKey &&
      this.undoStructure
    ) {
      event.preventDefault();
      const undo = this.undoStructure;
      this.undoStructure = null;
      undo();
      this.changed();
      return;
    }
    if (event.key === "Escape") {
      const saved =
        row.section === "summary"
          ? this.state.humanContext?.personSummary.find((i) => i.id === row.id)
          : this.state[row.section].find((i) => i.id === row.id);
      row.base = saved?.text;
      row.text = saved?.text ?? "";
      row.conflict = false;
      row.deleted = false;
      el.textContent = row.text;
      this.changed();
      return;
    }
    const { start, end } = this.selection(el);
    if (event.key === "Enter") {
      event.preventDefault();
      this.paste(row, el, "\n");
    } else if (event.key === "Backspace" && start === 0 && end === 0) {
      const rows = this.rows.filter(
        (r) => r.section === row.section && r.tier === row.tier && !r.deleted,
      );
      const previous = rows[rows.indexOf(row) - 1];
      if (previous) {
        event.preventDefault();
        const offset = previous.text.length;
        const previousText = previous.text;
        this.undoStructure = () => {
          previous.text = previousText;
          row.deleted = false;
          this.refresh();
          this.focus(row, 0);
        };
        previous.text += row.text;
        row.deleted = true;
        this.refresh();
        this.focus(previous, offset);
        this.changed();
      }
    }
  }
  private paste(row: Row, el: HTMLElement, text: string): void {
    if (el.contentEditable !== "plaintext-only") return;
    const { start, end } = this.selection(el);
    const original = row.text;
    const created: Row[] = [];
    this.undoStructure = () => {
      row.text = original;
      this.rows = this.rows.filter((r) => !created.includes(r));
      this.refresh();
      this.focus(row, start);
    };
    const parts = text.includes("\n")
      ? text.split(/\r?\n/).map((line) => contentLines(line)[0] ?? "")
      : [text];
    if (start === 0 && end === 0 && parts.length > 1) {
      // Inserting lines before an existing item must leave its identity,
      // checked state and evidence attached to the existing text.
      for (const part of parts.slice(0, -1)) {
        const inserted: Row = {
          id: crypto.randomUUID(),
          section: row.section,
          ...(row.tier ? { tier: row.tier } : {}),
          text: part,
        };
        created.push(inserted);
        this.rows.splice(this.rows.indexOf(row), 0, inserted);
      }
      const prefix = parts.at(-1) ?? "";
      row.text = prefix + original;
      this.refresh();
      this.focus(row, prefix.length);
      this.changed();
      return;
    }
    const before = row.text.slice(0, start),
      after = row.text.slice(end);
    row.text = before + parts[0];
    let last = row;
    for (const part of parts.slice(1)) {
      const next: Row = {
        id: crypto.randomUUID(),
        section: row.section,
        ...(row.tier ? { tier: row.tier } : {}),
        text: part,
      };
      created.push(next);
      this.rows.splice(this.rows.indexOf(last) + 1, 0, next);
      last = next;
    }
    const offset = last.text.length;
    last.text += after;
    this.refresh();
    this.focus(last, offset);
    this.changed();
  }
}
