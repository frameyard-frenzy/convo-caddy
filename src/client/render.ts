import { isPreparation } from "../domain/session-lifecycle.js";
import type { ContentEditor } from "./content-editor.js";
import type {
  CheckableItem,
  MeetingPlatform,
  NoteItem,
  PreparedTopic,
  SessionState,
  TranscriptTurn,
} from "../domain/types.js";
import type { SimulationAction } from "../server/session-service.js";
import type { RuntimeReadiness } from "../server/connectivity/readiness.js";
import type { WorkspaceOverview } from "./api.js";
type WorkspaceSessionSummary = {
  sessionId: string;
  startedAt: string;
  completedAt: string;
  displayName: string | null;
  lifecycle: "completed";
};

export function parsePrepTopicLines(
  value: string,
): Array<{ tier: "must" | "more"; text: string }> {
  const parsed: Array<{ tier: "must" | "more"; text: string }> = [];
  for (const [index, sourceLine] of value.split("\n").entries()) {
    const line = sourceLine.trim();
    if (line.length === 0) continue;
    const match = /^(must|more):\s*(.*)$/i.exec(line);
    if (!match) {
      throw new Error(`Line ${index + 1} must start with must: or more:`);
    }
    const text = (match[2] ?? "").trim();
    if (text.length === 0) {
      throw new Error(`Line ${index + 1} must include prompt text.`);
    }
    parsed.push({
      tier: (match[1] ?? "").toLowerCase() as "must" | "more",
      text,
    });
  }
  return parsed;
}

export type RenderModel = {
  state: SessionState;
  transcriptVisible: boolean;
  revealedTurnIds: string[] | null;
  error: string | null;
  submitting: boolean;
  draftInput: string;
  sessionHistory: WorkspaceSessionSummary[];
  startingNextSession: boolean;
  captureMeetingUrl: string;
  captureMeetingPlatform?: MeetingPlatform;
  captureDisplayName: string;
  startingCapture: boolean;
  runtimeReadiness: RuntimeReadiness | null;
  retryingHermes?: boolean;
  runtimeDiagnosticsOpen: boolean;
  workspaceOverview: WorkspaceOverview | null;
  choosingPrep?: boolean;
  saving?: boolean;
  prepChooser?: WorkspaceOverview | null;
};

export type RenderHandlers = {
  contentEditor?: ContentEditor;
  setTopicChecked(id: string, checked: boolean): void;
  setRevisitChecked(id: string, checked: boolean): void;
  setQuestionChecked(id: string, checked: boolean): void;
  controlSimulation(action: SimulationAction): void;
  submitInput(input: string): void;
  startNextSession(): void;
  startRecallCapture(
    meetingPlatform: MeetingPlatform,
    meetingUrl: string,
    displayName: string,
  ): void;
  updateCaptureMeetingUrl(meetingUrl: string): void;
  updateCaptureMeetingPlatform(meetingPlatform: MeetingPlatform): void;
  updateCaptureDisplayName(displayName: string): void;
  retryHermes?(): void;
  setRuntimeDiagnosticsOpen(open: boolean): void;
  selectPrep(basename: string): void;
  refreshWorkspace(): void;
  choosePrep(): void;
  saveContent?(): void;
  cancelPrepChooser(): void;
  savePrep(
    basename: string,
    prep: WorkspaceOverview["prep"]["valid"][number]["prep"],
    expectedSourceBytes: string | null,
  ): void;
  reportError(message: string): void;
  finishSaving(): void;
  updateDraftInput(input: string): void;
  showTranscript(turnIds: string[] | null): void;
  hideTranscript(): void;
};

export function renderApp(
  root: HTMLElement,
  model: RenderModel,
  handlers: RenderHandlers,
): void {
  const page = createElement("main", "app-shell");
  page.append(renderHeader(model.state, handlers));

  if (
    model.runtimeReadiness &&
    (model.runtimeReadiness.diagnostics.length ||
      model.retryingHermes ||
      [
        "setup_required",
        "starting",
        "ready_without_marty",
        "needs_attention",
      ].includes(model.runtimeReadiness.state))
  ) {
    page.append(
      renderRuntimeReadiness(
        model.runtimeReadiness,
        model.runtimeDiagnosticsOpen,
        handlers.setRuntimeDiagnosticsOpen,
        handlers.retryHermes,
        model.retryingHermes ?? false,
      ),
    );
  }
  page.append(
    model.workspaceOverview
      ? renderWorkspace(model.workspaceOverview, handlers, model)
      : renderWorkspaceFallback(model, handlers),
  );

  if (model.error) {
    const alert = createElement("p", "error-message", model.error);
    alert.setAttribute("role", "alert");
    page.append(alert);
  }

  if (model.state.capture.mode !== "recall") {
    page.append(renderLiveCapture(model, handlers));
  }

  const workspace = createElement("div", "workspace");
  const mutable = isSessionMutable(model.state);
  const preparedColumn = createElement("div", "prepared-column");
  preparedColumn.append(renderPrepared(model.state.topics, handlers, mutable));

  const captureColumn = createElement("div", "capture-column");
  captureColumn.append(
    renderCheckableSection(
      "Revisit",
      model.state.revisit,
      handlers.setRevisitChecked,
      handlers.showTranscript,
      mutable,
    ),
    renderCheckableSection(
      "Questions",
      model.state.questions,
      handlers.setQuestionChecked,
      handlers.showTranscript,
      mutable,
    ),
    renderNotes(model.state.notes, handlers.showTranscript),
  );
  workspace.append(preparedColumn, captureColumn);
  page.append(workspace, renderMarty(model, handlers));

  page.append(renderTranscript(model, handlers));

  const existingWorkspace = root.querySelector<HTMLElement>(".workspace");
  const existingPrep = root.querySelector<HTMLElement>(".workspace-prep");
  const newPrep = page.querySelector<HTMLElement>(".workspace-prep");
  if (existingPrep && newPrep) {
    // Keep the original metadata surface attached just like the list text.
    const oldText = existingPrep.querySelector<HTMLElement>(".selected-prep");
    const newText = newPrep.querySelector<HTMLElement>(".selected-prep");
    let cursor = existingPrep.firstChild;
    for (const child of [...newPrep.children]) {
      if (child === newText && oldText) {
        while (cursor && cursor !== oldText) {
          const next = cursor.nextSibling;
          cursor.remove();
          cursor = next;
        }
        cursor = oldText.nextSibling;
      } else {
        existingPrep.insertBefore(child, cursor);
        if (cursor && cursor !== oldText) {
          const next = cursor.nextSibling;
          cursor.remove();
          cursor = next;
        }
      }
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  }
  const metadata = (existingPrep ?? newPrep)?.querySelector<HTMLElement>(
    ".selected-prep",
  );
  if (metadata) handlers.contentEditor?.renderMetadata(metadata, model.state);
  handlers.contentEditor?.render(
    existingWorkspace ?? workspace,
    model.state,
    (section, id, checked) =>
      section === "topics"
        ? handlers.setTopicChecked(id, checked)
        : section === "questions"
          ? handlers.setQuestionChecked(id, checked)
          : handlers.setRevisitChecked(id, checked),
    handlers.showTranscript,
  );
  const previousChooser = root.querySelector(".prep-chooser");
  const chooserScroll = previousChooser?.scrollTop ?? 0;
  const currentPage = root.querySelector("main");
  if (!currentPage || !existingWorkspace) root.replaceChildren(page);
  else {
    // Neither editable surface detaches, including during IME composition.
    let cursor = currentPage.firstChild;
    for (const child of [...page.children]) {
      const retained =
        child === workspace
          ? existingWorkspace
          : child === newPrep
            ? existingPrep
            : null;
      if (retained) {
        while (cursor && cursor !== retained) {
          const next = cursor.nextSibling;
          cursor.remove();
          cursor = next;
        }
        cursor = retained.nextSibling;
      } else {
        currentPage.insertBefore(child, cursor);
        if (cursor && cursor !== existingWorkspace && cursor !== existingPrep) {
          const next = cursor.nextSibling;
          cursor.remove();
          cursor = next;
        }
      }
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    previousChooser?.remove();
  }
  if (model.prepChooser) {
    const dialog = document.createElement("dialog");
    dialog.className = "prep-chooser";
    dialog.setAttribute("aria-labelledby", "prep-chooser-heading");
    dialog.append(
      Object.assign(document.createElement("h2"), {
        id: "prep-chooser-heading",
        textContent: "Choose prep",
      }),
      createElement(
        "p",
        "workspace-path",
        `${model.prepChooser.root}/prep/current`,
      ),
    );
    for (const entry of model.prepChooser.prep.valid) {
      const button = createElement(
        "button",
        "secondary-button",
        `${entry.basename === model.prepChooser.selectedPrep ? (model.prepChooser.selectedPrepDisplayName ?? entry.basename) : entry.basename} — ${entry.prep.title}`,
      );
      button.id = `choose-${entry.basename}`;
      button.disabled = model.choosingPrep ?? false;
      button.addEventListener("click", () =>
        handlers.selectPrep(entry.basename),
      );
      dialog.append(button);
    }
    if (!model.prepChooser.prep.valid.length)
      dialog.append(
        createElement(
          "p",
          "empty-state",
          "No valid prep files. Add a Markdown prep file to prep/current, then choose again.",
        ),
      );
    for (const issue of model.prepChooser.prep.errors)
      dialog.append(
        createElement(
          "p",
          "error-message",
          `${issue.basename}: ${issue.error}`,
        ),
      );
    if (model.error) {
      const alert = createElement("p", "error-message", model.error);
      alert.setAttribute("role", "alert");
      dialog.append(alert);
    }
    const cancel = createElement("button", "secondary-button", "Cancel");
    cancel.id = "cancel-prep";
    cancel.disabled = model.choosingPrep ?? false;
    cancel.addEventListener("click", handlers.cancelPrepChooser);
    dialog.append(cancel);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!model.choosingPrep) handlers.cancelPrepChooser();
    });
    root.append(dialog);
    dialog.showModal();
    dialog.scrollTop = chooserScroll;
  }
}

function renderHeader(
  state: SessionState,
  handlers: RenderHandlers,
): HTMLElement {
  const header = createElement("header", "topbar");
  const identity = createElement("div", "app-identity");
  const mark = document.createElement("img");
  mark.className = "app-mark";
  mark.src = "/convo-caddy-mark.svg";
  mark.alt = "";
  mark.width = 58;
  mark.height = 58;
  const title = createElement("div", "identity-copy");
  title.append(
    createElement("p", "eyebrow", "Live interview companion"),
    createElement("h1", undefined, "Convo Caddy"),
    createElement("p", "brand-byline", "by Frameyard"),
  );
  identity.append(mark, title);

  const sessionStatus = createElement("div", "session-status");
  const elapsed = createElement(
    "p",
    "elapsed",
    `${formatTime(state.elapsedMs)} elapsed`,
  );
  elapsed.dataset.testid = "elapsed";
  const isSimulation = state.capture.mode === "simulation";
  const status = createElement(
    "p",
    isSimulation ? "simulation-status" : "capture-status",
    state.capture.mode === "recall"
      ? formatCaptureStatus(state.capture.status)
      : state.capture.mode === "live_ready"
        ? "Ready"
        : capitalize(state.simulation.status),
  );
  status.dataset.testid = isSimulation ? "simulation-status" : "capture-status";
  sessionStatus.append(
    createElement("p", "preservation-status", "Automatic local preservation"),
    elapsed,
    status,
  );
  if (state.capture.mode === "recall") {
    const authorization = createElement(
      "p",
      "capture-detail",
      state.capture.authorization.state === "confirmed"
        ? "Authorized by lobby admission"
        : "Awaiting lobby admission",
    );
    authorization.dataset.testid = "authorization-status";
    const notice = createElement(
      "p",
      state.capture.notice.state === "failed"
        ? "capture-detail capture-warning"
        : "capture-detail",
      state.capture.notice.state === "failed"
        ? state.capture.notice.error
        : `Notice ${state.capture.notice.state}`,
    );
    notice.dataset.testid = "notice-status";
    sessionStatus.append(authorization, notice);
    if (state.capture.error !== null) {
      const captureError = createElement(
        "p",
        "capture-detail capture-warning",
        state.capture.error,
      );
      captureError.dataset.testid = "capture-error";
      sessionStatus.append(captureError);
    }
  } else if (isSimulation) {
    sessionStatus.append(
      createElement("p", "speed", `${state.simulation.speed}× playback`),
    );
  }

  const controls = createElement("div", "simulation-controls");
  if (isSimulation) {
    controls.append(
      actionButton(
        "Start",
        "start",
        state.simulation.status !== "idle",
        handlers,
      ),
      actionButton(
        "Pause",
        "pause",
        state.simulation.status !== "running",
        handlers,
      ),
      actionButton(
        "Resume",
        "resume",
        state.simulation.status !== "paused",
        handlers,
      ),
      actionButton(
        "Step transcript",
        "step",
        state.simulation.status === "running" ||
          state.simulation.status === "complete",
        handlers,
      ),
      actionButton("Reset session", "reset", false, handlers),
    );
  }

  header.append(identity, sessionStatus);
  if (isSimulation) header.append(controls);
  return header;
}

function renderLiveCapture(
  model: RenderModel,
  handlers: RenderHandlers,
): HTMLElement {
  const section = createSection("Live capture", "live-capture");
  const meetingPlatform =
    model.captureMeetingPlatform ?? "microsoft_teams_personal";
  const isMeet = meetingPlatform === "google_meet";
  section.append(
    createElement(
      "p",
      "capture-guidance",
      `Paste the ${isMeet ? "Google Meet" : "personal Microsoft Teams"} meeting link. Nothing starts until you press the button.`,
    ),
  );
  const form = createElement("form", "live-capture-form");
  const primaryRow = createElement("div", "capture-primary-row");
  const platformField = createElement(
    "div",
    "capture-meeting-field capture-platform-field",
  );
  const platformLabel = createElement("label", undefined, "Meeting platform");
  platformLabel.htmlFor = "capture-meeting-platform";
  const platform = document.createElement("select");
  platform.id = "capture-meeting-platform";
  platform.name = "meetingPlatform";
  platform.append(
    new Option("Microsoft Teams (personal)", "microsoft_teams_personal"),
    new Option("Google Meet", "google_meet"),
  );
  platform.value = meetingPlatform;
  platform.disabled =
    model.startingCapture || model.state.capture.mode === "recall";
  platform.addEventListener("change", () => {
    handlers.updateCaptureMeetingPlatform(platform.value as MeetingPlatform);
  });
  platformField.append(platformLabel, platform);
  const meetingField = createElement(
    "div",
    "capture-meeting-field capture-primary-field",
  );
  const meetingLabel = createElement(
    "label",
    undefined,
    isMeet
      ? "Google Meet meeting link"
      : "Personal Microsoft Teams meeting link",
  );
  meetingLabel.htmlFor = "capture-meeting-url";
  const meetingUrl = document.createElement("input");
  meetingUrl.id = "capture-meeting-url";
  meetingUrl.name = "meetingUrl";
  meetingUrl.type = "url";
  meetingUrl.required = true;
  meetingUrl.placeholder = isMeet
    ? "https://meet.google.com/abc-defg-hij"
    : "https://teams.live.com/meet/…";
  meetingUrl.value = model.captureMeetingUrl;
  meetingUrl.disabled = model.startingCapture;
  meetingField.append(meetingLabel, meetingUrl);

  const submit = createElement(
    "button",
    "primary-button capture-submit",
    model.startingCapture ? "Starting…" : "Start live capture",
  );
  submit.type = "submit";
  const captureReady =
    model.runtimeReadiness === null ||
    model.runtimeReadiness.components.capture === "ready";
  const updateSubmit = () => {
    submit.disabled =
      model.startingCapture || !captureReady || !meetingUrl.value.trim();
  };
  meetingUrl.addEventListener("input", () => {
    handlers.updateCaptureMeetingUrl(meetingUrl.value);
    updateSubmit();
  });
  updateSubmit();
  primaryRow.append(platformField, meetingField, submit);

  const secondaryRow = createElement("div", "capture-secondary-row");
  const nameField = createElement(
    "div",
    "capture-meeting-field capture-secondary-field",
  );
  const nameLabel = document.createElement("label");
  nameLabel.htmlFor = "capture-display-name";
  nameLabel.append(
    "Interview name ",
    createElement("span", "field-optional", "(optional)"),
  );
  const displayName = document.createElement("input");
  displayName.id = "capture-display-name";
  displayName.name = "displayName";
  displayName.maxLength = 80;
  displayName.placeholder = "Customer or topic";
  displayName.value = model.captureDisplayName;
  displayName.disabled = model.startingCapture;
  displayName.addEventListener("input", () => {
    handlers.updateCaptureDisplayName(displayName.value);
  });
  nameField.append(nameLabel, displayName);
  secondaryRow.append(nameField);
  form.append(primaryRow, secondaryRow);

  if (!captureReady) {
    const waiting = createElement(
      "p",
      "capture-readiness-message",
      "Live capture will unlock when the secure webhook is ready.",
    );
    waiting.setAttribute("role", "status");
    form.append(waiting);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handlers.startRecallCapture(
      meetingPlatform,
      meetingUrl.value,
      displayName.value,
    );
  });
  const protocol = createElement("div", "capture-protocol");
  protocol.append(
    createElement("p", "capture-protocol-label", "After you press start"),
    createElement(
      "p",
      "capture-protocol-copy",
      `The visible Convo Caddy bot waits for admission in ${isMeet ? "Google Meet" : "the Teams lobby"}. Admitting it authorizes recording and transcription.`,
    ),
    createElement(
      "p",
      "recording-notice",
      "On admission, the bot displays a ten-second notice: “Convo Caddy is recording and transcribing this conversation.”",
    ),
  );
  section.append(form, protocol);
  return section;
}

function renderRuntimeReadiness(
  readiness: RuntimeReadiness,
  diagnosticsOpen: boolean,
  setDiagnosticsOpen: (open: boolean) => void,
  retryHermes?: () => void,
  retrying = false,
): HTMLElement {
  const section = createElement("div", "runtime-recovery");
  section.setAttribute("aria-label", "Connection recovery");
  const summary = createElement(
    "p",
    "runtime-recovery-summary",
    formatRuntimeState(readiness.state),
  );
  summary.dataset.testid = "runtime-readiness";
  summary.setAttribute("role", "status");
  section.append(summary);
  if (
    retryHermes &&
    (retrying ||
      (readiness.diagnostics.some(
        (item) => item.component === "hermesTunnel",
      ) &&
        ["failed", "unavailable"].includes(readiness.components.hermesTunnel)))
  ) {
    const retry = createElement(
      "button",
      "secondary-button",
      retrying ? "Retrying connection…" : "Retry connection",
    );
    retry.type = "button";
    retry.disabled = retrying;
    retry.addEventListener("click", retryHermes);
    section.append(retry);
    section.append(
      createElement(
        "p",
        undefined,
        "Check that the Hermes Mac and private network are online. Retry restores the connection; it never resends an assistant request.",
      ),
    );
  }
  if (readiness.diagnostics.length > 0) {
    const details = document.createElement("details");
    details.className = "runtime-diagnostics";
    details.open = diagnosticsOpen;
    details.addEventListener("toggle", () => {
      setDiagnosticsOpen(details.open);
    });
    details.append(
      createElement(
        "summary",
        undefined,
        `${readiness.diagnostics.length} diagnostic${readiness.diagnostics.length === 1 ? "" : "s"}`,
      ),
    );
    const list = createElement("ul");
    for (const diagnostic of readiness.diagnostics) {
      list.append(
        createElement(
          "li",
          diagnostic.severity === "error" ? "runtime-warning" : undefined,
          `${diagnostic.message} ${diagnostic.action}`,
        ),
      );
    }
    details.append(list);
    section.append(details);
  }
  return section;
}

function formatRuntimeState(state: RuntimeReadiness["state"]): string {
  return {
    setup_required: "Configuration required",
    starting: "Starting meeting connections…",
    ready: "Ready for a meeting",
    ready_without_marty: "Ready for capture; Assistant is unavailable",
    needs_attention: "Meeting connections need attention",
    interview_active: "Interview active",
    finalizing: "Finalizing and saving the interview",
  }[state];
}

function renderWorkspace(
  workspace: WorkspaceOverview,
  handlers: RenderHandlers,
  model: RenderModel,
): HTMLElement {
  const section = createSection("Workspace and prep", "workspace-prep");
  section.append(createElement("p", "workspace-path", workspace.root));
  if (workspace.warning) {
    const warning = createElement("p", "error-message", workspace.warning);
    warning.setAttribute("role", "alert");
    section.append(warning);
  }
  const choose = createElement(
    "button",
    "secondary-button",
    model.choosingPrep ? "Choosing prep…" : "Choose prep…",
  );
  choose.id = "choose-prep";
  choose.title = "Choose a markdown prep file.";
  choose.type = "button";
  choose.disabled =
    Boolean(model.choosingPrep) ||
    (model.state.capture.mode === "recall" && !isPreparation(model.state));
  choose.addEventListener("click", handlers.choosePrep);
  const save = createElement(
    "button",
    "secondary-button",
    model.saving ? "Saving…" : "Save",
  );
  save.id = "save-content";
  save.type = "button";
  save.title = "Save (⌘S)";
  save.setAttribute("aria-keyshortcuts", "Meta+S");
  save.disabled =
    Boolean(model.saving || model.choosingPrep || model.startingCapture) ||
    model.state.lifecycle.finalization.state === "complete";
  save.addEventListener("click", () => handlers.saveContent?.());
  const actions = createElement("div", "workspace-actions");
  actions.append(choose, save);
  section.append(actions);
  if (model.state.capture.mode === "recall" && !isPreparation(model.state))
    section.append(
      createElement(
        "p",
        "empty-state workspace-edit-status",
        "Edits save to this interview. The selected prep file stays unchanged.",
      ),
    );
  const selected = workspace.prep.valid.find(
    (entry) => entry.basename === workspace.selectedPrep,
  );
  if (selected)
    section.append(
      createElement(
        "p",
        "selected-prep",
        `${selected.prep.title} · ${selected.prep.plannedDurationMinutes} minutes`,
      ),
      createElement(
        "p",
        "workspace-path",
        `${workspace.selectedPrepDisplayName ?? selected.basename} — selected`,
      ),
    );
  else if (workspace.selectedPrep)
    section.append(
      createElement(
        "p",
        "empty-state",
        `${workspace.selectedPrepDisplayName ?? workspace.selectedPrep} — selected for this interview`,
      ),
    );
  section.append(renderWorkspaceLifecycle(model, handlers, workspace.finished));
  return section;
}

function renderWorkspaceFallback(
  model: RenderModel,
  handlers: RenderHandlers,
): HTMLElement {
  const section = createSection("Workspace", "workspace-prep");
  section.classList.add("workspace-fallback");
  section.append(
    createElement(
      "p",
      "empty-state",
      "Choose a workspace to prepare and save interviews.",
    ),
    renderWorkspaceLifecycle(model, handlers, null),
  );
  return section;
}

function renderWorkspaceLifecycle(
  model: RenderModel,
  handlers: RenderHandlers,
  finishedRecords: WorkspaceOverview["finished"] | null,
): HTMLElement {
  const section = createElement("div", "workspace-lifecycle");
  section.append(createElement("h3", undefined, "Saved interviews"));
  for (const issue of finishedRecords?.errors ?? []) {
    const alert = createElement(
      "p",
      "error-message",
      `Finished record ${issue.name}: ${issue.error}`,
    );
    alert.setAttribute("role", "alert");
    section.append(alert);
  }
  appendSessionLifecycle(section, model, handlers);
  return section;
}

function actionButton(
  label: string,
  action: SimulationAction,
  disabled: boolean,
  handlers: RenderHandlers,
): HTMLButtonElement {
  const button = createElement("button", "secondary-button", label);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", () => handlers.controlSimulation(action));
  return button;
}

function renderPrepared(
  topics: PreparedTopic[],
  handlers: RenderHandlers,
  mutable: boolean,
): HTMLElement {
  const section = createSection("Prepared Questions", "prepared");
  section.append(
    renderTopicTier(
      "Must",
      topics.filter((topic) => topic.tier === "must"),
      handlers,
      mutable,
    ),
    renderTopicTier(
      "More Avenues",
      topics.filter((topic) => topic.tier === "more"),
      handlers,
      mutable,
    ),
  );
  return section;
}

function renderTopicTier(
  title: string,
  topics: PreparedTopic[],
  handlers: RenderHandlers,
  mutable: boolean,
): HTMLElement {
  const group = createElement("div", "topic-tier");
  group.append(createElement("h3", undefined, title));
  const list = createElement("ul", "checklist");

  for (const topic of topics) {
    list.append(
      renderCheckbox(
        topic,
        (checked) => handlers.setTopicChecked(topic.id, checked),
        !mutable,
      ),
    );
  }
  group.append(list);
  return group;
}

function renderCheckableSection(
  title: string,
  items: CheckableItem[],
  update: (id: string, checked: boolean) => void,
  showTranscript: (turnIds: string[] | null) => void,
  mutable: boolean,
): HTMLElement {
  const section = createSection(title, title.toLocaleLowerCase());
  if (items.length === 0) {
    section.append(
      createElement("p", "empty-state", `No ${title.toLocaleLowerCase()} yet.`),
    );
    return section;
  }

  const list = createElement("ul", "checklist");
  for (const item of items) {
    const row = renderCheckbox(
      item,
      (checked) => update(item.id, checked),
      !mutable,
    );
    row.append(renderContextButton(item, showTranscript));
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderNotes(
  notes: NoteItem[],
  showTranscript: (turnIds: string[] | null) => void,
): HTMLElement {
  const section = createSection("Notes", "notes");
  if (notes.length === 0) {
    section.append(createElement("p", "empty-state", "No notes yet."));
    return section;
  }

  const list = createElement("ul", "notes-list");
  for (const note of notes) {
    const row = createElement("li", "note-item");
    row.append(
      createElement("p", undefined, note.text),
      renderContextButton(note, showTranscript),
    );
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderContextButton(
  item: CheckableItem | NoteItem,
  showTranscript: (turnIds: string[] | null) => void,
): HTMLButtonElement {
  const button = createElement(
    "button",
    "context-button",
    `Context ${formatTime(item.relativeMs)}`,
  );
  button.type = "button";
  button.disabled = item.transcriptRef.windowTurnIds.length === 0;
  button.addEventListener("click", () =>
    showTranscript(item.transcriptRef.windowTurnIds),
  );
  return button;
}

function renderCheckbox(
  item: { id: string; text: string; checked: boolean },
  onChange: (checked: boolean) => void,
  disabled = false,
): HTMLLIElement {
  const row = createElement(
    "li",
    item.checked ? "check-item checked" : "check-item",
  );
  const label = createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = `check-${item.id}`;
  checkbox.checked = item.checked;
  checkbox.disabled = disabled;
  checkbox.addEventListener("change", () => onChange(checkbox.checked));
  label.append(checkbox, createElement("span", undefined, item.text));
  row.append(label);
  return row;
}

function renderMarty(
  model: RenderModel,
  handlers: RenderHandlers,
): HTMLElement {
  const section = createSection("Assistant", "marty");
  const form = createElement("form", "marty-form");
  const label = createElement("label", undefined, "Command or question");
  label.htmlFor = "marty-input";
  const input = document.createElement("input");
  input.id = "marty-input";
  input.name = "input";
  input.autocomplete = "off";
  input.placeholder = "/note, /question, /revisit, or ask your agent";
  input.value = model.draftInput;
  input.disabled = model.submitting || !isSessionMutable(model.state);
  input.addEventListener("input", () => handlers.updateDraftInput(input.value));
  const submit = createElement(
    "button",
    "primary-button",
    model.submitting ? "Sending…" : "Submit",
  );
  submit.type = "submit";
  submit.disabled = model.submitting || !isSessionMutable(model.state);
  form.append(label, input, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handlers.submitInput(input.value);
  });
  section.append(form);

  const latest = model.state.chat.at(-1);
  if (latest) {
    const response = createElement("div", "marty-response");
    response.append(
      createElement("p", "response-label", "Last reply"),
      createElement(
        "p",
        undefined,
        latest.response ?? latest.error ?? "Assistant did not answer.",
      ),
    );
    const citations = latest.citationTurnIds.filter((turnId) =>
      model.state.transcript.some((turn) => turn.id === turnId),
    );
    for (const turnId of citations) {
      const citation = createElement(
        "button",
        "context-button",
        `Citation ${turnId}`,
      );
      citation.type = "button";
      citation.addEventListener("click", () =>
        handlers.showTranscript([turnId]),
      );
      response.append(citation);
    }
    section.append(response);
  }
  return section;
}

function appendSessionLifecycle(
  section: HTMLElement,
  model: RenderModel,
  handlers: RenderHandlers,
): void {
  const finalization = model.state.lifecycle.finalization;
  const status = createElement("p", "finalization-status");
  status.dataset.testid = "finalization-status";
  switch (finalization.state) {
    case "not_applicable":
      status.textContent =
        "This synthetic developer session is saved locally. Automatic interview bundles are created for live capture.";
      break;
    case "pending":
      if (
        model.state.contentFlushRequired &&
        Object.entries(model.state.lifecycle.providerMilestones)
          .filter(([key]) =>
            ["callEndedAt", "transcriptDoneAt", "botDoneAt"].includes(key),
          )
          .every(([, value]) => value !== null)
      ) {
        status.textContent =
          "Saving your latest edits before finishing the conversation.";
        const finish = createElement(
          "button",
          "primary-button",
          "Finish saving",
        );
        finish.type = "button";
        finish.addEventListener("click", handlers.finishSaving);
        section.append(finish);
        break;
      }
      status.textContent =
        "This interview is being saved locally. Its canonical bundle will be created automatically when Recall finishes.";
      break;
    case "waiting_for_provider":
      status.textContent = `Waiting for Recall to finish: ${finalization.missing
        .map(formatMissingMilestone)
        .join(", ")}.`;
      break;
    case "finalizing":
      status.textContent = "Finalizing and saving the interview…";
      break;
    case "complete": {
      status.textContent = `Finished conversation saved in ${finalization.directory}.`;
      status.setAttribute("role", "status");
      const next = createElement(
        "button",
        "primary-button",
        model.startingNextSession ? "Starting…" : "New interview",
      );
      next.type = "button";
      next.disabled = model.startingNextSession;
      next.addEventListener("click", handlers.startNextSession);
      section.append(status, next);
      break;
    }
    case "needs_attention":
      status.classList.add("finalization-warning");
      status.textContent = finalization.error;
      status.setAttribute("role", "alert");
      {
        const retry = createElement(
          "button",
          "primary-button",
          "Finish saving",
        );
        retry.type = "button";
        retry.addEventListener("click", handlers.finishSaving);
        section.append(retry);
      }
      break;
  }
  if (finalization.state !== "complete") {
    section.append(status);
  }

  if (model.sessionHistory.length > 0) {
    const list = createElement("ul", "session-history");
    const latest = [...model.sessionHistory].sort(
      (a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt),
    )[0]!;
    const row = createElement("li", "session-history-item");
    row.append(
      createElement(
        "p",
        "session-history-summary",
        latest.displayName ?? "Interview",
      ),
    );
    list.append(row);
    section.append(createElement("h3", undefined, "History"), list);
  }
}

function isSessionMutable(state: SessionState): boolean {
  const finalization = state.lifecycle.finalization.state;
  return (
    finalization !== "complete" &&
    finalization !== "finalizing" &&
    finalization !== "needs_attention"
  );
}

function formatMissingMilestone(
  milestone: "call_ended" | "transcript_done" | "bot_done",
): string {
  return {
    call_ended: "call ended",
    transcript_done: "transcript ready",
    bot_done: "bot finished",
  }[milestone];
}

function renderTranscript(
  model: RenderModel,
  handlers: RenderHandlers,
): HTMLElement {
  const section = createSection("Transcript", "transcript");
  section.classList.add("transcript-panel");
  const close = createElement(
    "button",
    "secondary-button",
    model.transcriptVisible ? "Hide transcript" : "Show transcript",
  );
  close.id = "transcript-disclosure";
  close.type = "button";
  close.setAttribute("aria-expanded", String(model.transcriptVisible));
  close.setAttribute("aria-controls", "transcript-content");
  close.addEventListener("click", () =>
    model.transcriptVisible
      ? handlers.hideTranscript()
      : handlers.showTranscript(null),
  );
  const header = createElement("div", "transcript-header");
  const heading = section.querySelector("h2")!;
  header.append(heading, close);
  section.prepend(header);
  const content = createElement("div");
  content.id = "transcript-content";
  content.hidden = !model.transcriptVisible;
  section.append(content);
  if (!model.transcriptVisible) return section;
  const selectedIds = model.revealedTurnIds
    ? new Set(model.revealedTurnIds)
    : null;
  const turns = selectedIds
    ? model.state.transcript.filter((turn) => selectedIds.has(turn.id))
    : model.state.transcript;

  if (selectedIds) {
    const filterStatus = createElement("div", "transcript-filter-status");
    const label = createElement("p", undefined, "Filtered");
    label.setAttribute("role", "status");
    const clear = createElement("button", "text-button", "Clear filter");
    clear.id = "transcript-filter-clear";
    clear.type = "button";
    clear.addEventListener("click", () => handlers.showTranscript(null));
    filterStatus.append(label, clear);
    header.append(filterStatus);
  }

  if (turns.length === 0) {
    content.append(
      createElement("p", "empty-state", "No finalized turns yet."),
    );
    return section;
  }

  const list = createElement("ol", "transcript-list");
  for (const turn of turns) {
    list.append(renderTurn(turn));
  }
  content.append(list);
  return section;
}

function renderTurn(turn: TranscriptTurn): HTMLLIElement {
  const row = createElement("li", "transcript-turn");
  row.id = `transcript-${turn.id}`;
  row.append(
    createElement(
      "p",
      "turn-meta",
      `${formatTime(turn.startedAtMs)} · ${turn.speakerLabel}`,
    ),
    createElement("p", undefined, turn.text),
  );
  return row;
}

function createSection(title: string, className: string): HTMLElement {
  const section = createElement("section", `panel ${className}`);
  const heading = createElement("h2", undefined, title);
  heading.id = `${className}-heading`;
  section.setAttribute("aria-labelledby", heading.id);
  section.append(heading);
  return section;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":");
}

function capitalize(value: string): string {
  return `${value.charAt(0).toLocaleUpperCase()}${value.slice(1)}`;
}

function formatCaptureStatus(value: string): string {
  return value
    .split("_")
    .map((part) => capitalize(part))
    .join(" ");
}
