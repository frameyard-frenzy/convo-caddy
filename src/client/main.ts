import { ContentEditor } from "./content-editor.js";
import { editContent, openContentEditing, saveCurrentContent } from "./api.js";
import "@fontsource-variable/instrument-sans";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";
import type { MeetingPlatform, SessionState } from "../domain/types.js";
import type { SimulationAction } from "../server/session-service.js";
import {
  controlSimulation,
  getRuntimeReadiness,
  retryHermesConnection,
  getSession,
  getSessionHistory,
  getWorkspace,
  choosePrep,
  selectPrep,
  savePrep,
  finishSaving,
  setChecked,
  startNextSession,
  startRecallCapture,
  submitInput,
  subscribeToSession,
} from "./api.js";
import type { WorkspaceOverview } from "./api.js";
import type { RuntimeReadiness } from "../server/connectivity/readiness.js";
type WorkspaceSessionSummary = {
  sessionId: string;
  startedAt: string;
  completedAt: string;
  displayName: string | null;
  lifecycle: "completed";
};
import { renderApp } from "./render.js";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Convo Caddy root element is missing");
}
const appRoot = root;

let state: SessionState;
const editor = new ContentEditor(() => {
  captureDisplayName = editor.metadata?.displayName.text ?? captureDisplayName;
  error = null;
});
let composingInput = false;
appRoot.addEventListener("compositionstart", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement
  )
    composingInput = true;
});
appRoot.addEventListener("compositionend", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement
  ) {
    composingInput = false;
    render();
  }
});
let finishing = false;
let saving = false;
let autoFinishAttempted = false;
let transcriptVisible = false;
let revealedTurnIds: string[] | null = null;
let error: string | null = null;
let submitting = false;
let draftInput = "";
let pendingMutation: { input: string; id: string } | null = null;
let sessionHistory: WorkspaceSessionSummary[] = [];
let startingNextSession = false;
let captureMeetingUrl = "";
let captureMeetingPlatform: MeetingPlatform = "microsoft_teams_personal";
let captureDisplayName = "";
let startingCapture = false;
let runtimeReadiness: RuntimeReadiness | null = null;
let runtimeDiagnosticsOpen = false;
let retryingHermes = false;
let choosingPrep = false;
let prepChooser: WorkspaceOverview | null = null;
let prepChooserSessionId: string | undefined;
let workspaceOverview: WorkspaceOverview | null = null;

function render(): void {
  if (composingInput) return;
  const inputFocus = captureInputFocus();
  const focusedId =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.id
      : "";
  renderApp(
    appRoot,
    {
      state,
      transcriptVisible,
      revealedTurnIds,
      error,
      submitting: submitting || preparingClose,
      draftInput,
      sessionHistory,
      startingNextSession,
      captureMeetingUrl,
      captureMeetingPlatform,
      captureDisplayName:
        editor.metadata?.displayName.text ?? captureDisplayName,
      startingCapture,
      runtimeReadiness,
      retryingHermes,
      runtimeDiagnosticsOpen,
      workspaceOverview,
      choosingPrep,
      saving: saving || preparingClose,
      prepChooser,
    },
    {
      contentEditor: editor,
      setTopicChecked: (id, checked) => updateChecked("topics", id, checked),
      setRevisitChecked: (id, checked) => updateChecked("revisit", id, checked),
      setQuestionChecked: (id, checked) =>
        updateChecked("questions", id, checked),
      controlSimulation: runSimulationAction,
      submitInput: runInput,
      startNextSession: runStartNextSession,
      startRecallCapture: runStartRecallCapture,
      updateCaptureMeetingUrl: (meetingUrl) => {
        captureMeetingUrl = meetingUrl;
      },
      updateCaptureMeetingPlatform: (meetingPlatform) => {
        captureMeetingPlatform = meetingPlatform;
        render();
      },
      updateCaptureDisplayName: (displayName) => {
        captureDisplayName = displayName;
        if (editor.metadata) editor.metadata.displayName.text = displayName;
      },
      retryHermes: async () => {
        if (retryingHermes) return;
        retryingHermes = true;
        render();
        try {
          runtimeReadiness = (await retryHermesConnection()).readiness;
        } catch (caught) {
          error = errorMessage(caught);
        } finally {
          retryingHermes = false;
          render();
        }
      },
      setRuntimeDiagnosticsOpen: (open) => {
        runtimeDiagnosticsOpen = open;
      },
      saveContent: () => void runSaveContent(),
      choosePrep: () => void runChoosePrep(),
      cancelPrepChooser: () => {
        prepChooser = null;
        error = null;
        render();
        document.getElementById("choose-prep")?.focus();
      },
      selectPrep: (basename) => void runSelectPrep(basename),
      refreshWorkspace: () => void refreshWorkspace(),
      savePrep: (basename, prep, expected) =>
        void runSavePrep(basename, prep, expected),
      reportError: (message) => {
        error = message;
        render();
      },
      finishSaving: () => void runFinishSaving(),
      updateDraftInput: (input) => {
        draftInput = input;
        if (pendingMutation?.input !== input) {
          pendingMutation = null;
        }
      },
      showTranscript: (turnIds) => {
        transcriptVisible = true;
        revealedTurnIds = turnIds;
        render();
        document.getElementById("transcript-disclosure")?.focus();
      },
      hideTranscript: () => {
        transcriptVisible = false;
        revealedTurnIds = null;
        render();
        document.getElementById("transcript-disclosure")?.focus();
      },
    },
  );
  if (!inputFocus && focusedId && document.activeElement?.id !== focusedId)
    document.getElementById(focusedId)?.focus({ preventScroll: true });
  restoreInputFocus(inputFocus);
}

type InputFocus = {
  id: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: "forward" | "backward" | "none" | null;
};

function captureInputFocus(): InputFocus | null {
  const activeElement = document.activeElement;
  if (
    !(
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement
    ) ||
    !activeElement.id ||
    !appRoot.contains(activeElement)
  ) {
    return null;
  }
  return {
    id: activeElement.id,
    selectionStart: activeElement.selectionStart,
    selectionEnd: activeElement.selectionEnd,
    selectionDirection: activeElement.selectionDirection,
  };
}

function restoreInputFocus(focus: InputFocus | null): void {
  if (!focus) {
    return;
  }
  const input = document.getElementById(focus.id);
  if (
    !(
      input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
    ) ||
    !appRoot.contains(input) ||
    input.disabled
  ) {
    return;
  }
  input.focus({ preventScroll: true });
  if (focus.selectionStart !== null && focus.selectionEnd !== null) {
    input.setSelectionRange(
      focus.selectionStart,
      focus.selectionEnd,
      focus.selectionDirection ?? undefined,
    );
  }
}

async function runStartRecallCapture(
  meetingPlatform: MeetingPlatform,
  meetingUrl: string,
  displayName: string,
): Promise<void> {
  captureMeetingUrl = meetingUrl;
  startingCapture = true;
  error = null;
  render();

  try {
    await flushEdits();
    const savedDisplayName = editor.metadata?.displayName.text ?? displayName;
    const result = await startRecallCapture({
      meetingPlatform,
      meetingUrl,
      ...(savedDisplayName ? { displayName: savedDisplayName } : {}),
    });
    state = result.state;
    if (!result.ok) {
      throw new Error(result.error);
    }
  } catch (caught) {
    error = errorMessage(caught);
  } finally {
    startingCapture = false;
    render();
  }
}

async function runStartNextSession(): Promise<void> {
  startingNextSession = true;
  error = null;
  render();

  try {
    const result = await startNextSession();
    state = result.state;
    state = (await openContentEditing()).state;
    autoFinishAttempted = false;
    sessionHistory = result.sessions;
    captureMeetingUrl = "";
    captureDisplayName = "";
    transcriptVisible = false;
    revealedTurnIds = null;
  } catch (caught) {
    error = errorMessage(caught);
  } finally {
    startingNextSession = false;
    render();
  }
}

async function refreshWorkspace(): Promise<void> {
  try {
    workspaceOverview = (await getWorkspace()).workspace;
    error = null;
  } catch (caught) {
    error = errorMessage(caught);
  }
  render();
}
async function runChoosePrep(): Promise<void> {
  if (choosingPrep) return;
  if (editor.dirty) {
    error = "Save the current edits before choosing another prep.";
    render();
    return;
  }
  const stateAtRequest = state;
  choosingPrep = true;
  error = null;
  render();
  try {
    const result = await choosePrep();
    if (result.kind === "browser") {
      prepChooser = result.workspace;
      prepChooserSessionId = result.sessionId;
    }
    if (result.kind === "selected") {
      // Ordered SSE or another completed action may already carry newer state.
      if (state === stateAtRequest) state = result.state;
      workspaceOverview = result.workspace;
    }
  } catch (caught) {
    error = errorMessage(caught);
  } finally {
    choosingPrep = false;
    render();
    if (!prepChooser) document.getElementById("choose-prep")?.focus();
  }
}
async function runSelectPrep(basename: string): Promise<void> {
  if (choosingPrep) return;
  if (editor.dirty) {
    error = "Save the current edits before choosing another prep.";
    render();
    return;
  }
  const stateAtRequest = state;
  choosingPrep = true;
  error = null;
  render();
  try {
    const result = await selectPrep(basename, prepChooserSessionId);
    prepChooser = null;
    // Do not replay a delayed selection over newer session/capture events.
    if (state === stateAtRequest) state = result.state;
    workspaceOverview = result.workspace;
    error = null;
  } catch (caught) {
    error = errorMessage(caught);
  }
  choosingPrep = false;
  render();
  if (!prepChooser) document.getElementById("choose-prep")?.focus();
}
async function runSavePrep(
  basename: string,
  prep: WorkspaceOverview["prep"]["valid"][number]["prep"],
  expectedSourceBytes: string | null,
): Promise<void> {
  try {
    workspaceOverview = (
      await savePrep({ basename, prep, expectedSourceBytes })
    ).workspace;
    error = null;
  } catch (caught) {
    error = errorMessage(caught);
  }
  render();
}
let flushingChecks: Promise<void> | null = null;
async function flushChecks(): Promise<void> {
  if (flushingChecks) return flushingChecks;
  flushingChecks = (async () => {
    while (editor.checks.size) {
      const [id, checked] = editor.checks.entries().next().value!;
      const section = (["topics", "questions", "revisit"] as const).find(
        (name) => state[name].some((item) => item.id === id),
      );
      if (!section)
        throw new Error("The checked item changed. Your draft was kept.");
      const before = state;
      const next = await setChecked(section, id, checked);
      if (state === before) state = next;
      if (editor.checks.get(id) === checked) editor.checks.delete(id);
    }
  })().finally(() => {
    flushingChecks = null;
  });
  return flushingChecks;
}
let persistencePending = false;
let activeFlushes = 0;
let closeApproved = false;
let preparingClose = false;
async function flushEdits(): Promise<void> {
  activeFlushes++;
  try {
    persistencePending = true;
    do {
      editor.sync(state);
      await editor.flush(editContent, (next) => {
        if (
          next.sessionId === state.sessionId &&
          (next.contentRevision ?? 0) > (state.contentRevision ?? 0)
        )
          state = next;
        editor.sync(state);
      });
      await flushChecks();
      if (workspaceOverview)
        await saveCurrentContent(state.sessionId, state.contentRevision ?? 0);
    } while (editor.dirty || editor.checks.size || editor.composing);
    persistencePending = false;
  } finally {
    activeFlushes--;
  }
}
async function runSaveContent(): Promise<void> {
  if (
    saving ||
    preparingClose ||
    closeApproved ||
    finishing ||
    choosingPrep ||
    startingCapture
  )
    return;
  saving = true;
  error = null;
  render();
  try {
    await flushEdits();
  } catch (caught) {
    error = errorMessage(caught);
  } finally {
    saving = false;
    render();
  }
}
document.addEventListener("keydown", (event) => {
  if (
    event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "s"
  ) {
    event.preventDefault();
    if (state) void runSaveContent();
  }
});
async function runFinishSaving(): Promise<void> {
  if (finishing || submitting) return;
  finishing = true;
  try {
    await flushEdits();
    // No await between the last flush and disabling text entry: once export is
    // in flight there can be no unacknowledged later keystroke.
    editor.locked = true;
    render();
    const result = await finishSaving(
      state.sessionId,
      state.contentRevision ?? 0,
    );
    state = result.state;
    workspaceOverview = result.workspace;
    error = null;
  } catch (caught) {
    error = errorMessage(caught);
  } finally {
    finishing = false;
    editor.locked = false;
    render();
  }
}
function maybeFinish(): void {
  const milestones = state.lifecycle.providerMilestones;
  if (
    !autoFinishAttempted &&
    !preparingClose &&
    !closeApproved &&
    !editor.composing &&
    !submitting &&
    !finishing &&
    state.contentFlushRequired &&
    state.lifecycle.finalization.state === "pending" &&
    milestones.callEndedAt &&
    milestones.transcriptDoneAt &&
    milestones.botDoneAt
  ) {
    autoFinishAttempted = true;
    void runFinishSaving();
  }
}

async function refreshSessionHistory(): Promise<void> {
  try {
    sessionHistory = (await getSessionHistory()).sessions;
    render();
  } catch (caught) {
    error = errorMessage(caught);
    render();
  }
}

async function refreshRuntimeReadiness(): Promise<void> {
  try {
    const current = await getRuntimeReadiness();
    runtimeReadiness = current.readiness;
    if (
      current.workspaceRoot !== undefined &&
      current.workspaceRoot !== (workspaceOverview?.root ?? null)
    )
      workspaceOverview = (await getWorkspace()).workspace;
    render();
  } catch {
    // Session/API failures are surfaced by the authoritative event connection.
  }
}

async function updateChecked(
  _section: "topics" | "revisit" | "questions",
  id: string,
  checked: boolean,
): Promise<void> {
  editor.checks.set(id, checked);
  try {
    error = null;
    await flushEdits();
  } catch (caught) {
    error = errorMessage(caught);
  }
  render();
}

async function runSimulationAction(action: SimulationAction): Promise<void> {
  try {
    error = null;
    state = await controlSimulation(action);
    if (action === "reset") {
      transcriptVisible = false;
      revealedTurnIds = null;
    }
  } catch (caught) {
    error = errorMessage(caught);
  }
  render();
}

async function runInput(input: string): Promise<void> {
  const mutation =
    pendingMutation?.input === input
      ? pendingMutation
      : { input, id: crypto.randomUUID() };
  pendingMutation = mutation;
  draftInput = input;
  submitting = true;
  error = null;
  render();

  try {
    await flushEdits();
    const before = state;
    const result = await submitInput(input, mutation.id);
    if (state === before) state = result.state;
    error = result.error ?? null;
    pendingMutation = null;
    if (result.ok) {
      draftInput = "";
    }
  } catch (caught) {
    error = errorMessage(caught);
  } finally {
    submitting = false;
    render();
    maybeFinish();
  }
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Something went wrong.";
}

try {
  const initial = await getSession();
  state = initial.state;
  if (state.capture.mode !== "simulation")
    captureMeetingPlatform = state.capture.meetingPlatform;
  if (
    !["complete", "finalizing", "needs_attention"].includes(
      state.lifecycle.finalization.state,
    )
  )
    state = (await openContentEditing()).state;
  sessionHistory = (await getSessionHistory()).sessions;
  runtimeReadiness = (await getRuntimeReadiness()).readiness;
  workspaceOverview = (await getWorkspace()).workspace;
  render();
  window.setInterval(() => void refreshRuntimeReadiness(), 1_000);
  subscribeToSession((nextState) => {
    // HTTP can acknowledge multiple content saves before their ordered SSE
    // snapshots arrive. Never replay older content over that accepted state.
    // This is NOT a whole-session event counter: equal content revisions still
    // carry newer transcript, checkbox and lifecycle updates and must render.
    // Revisions are local to a session; a new session starts its own sequence.
    if (
      nextState.sessionId === state.sessionId &&
      (nextState.contentRevision ?? 0) < (state.contentRevision ?? 0)
    )
      return;
    const shouldRefreshHistory =
      nextState.sessionId !== state.sessionId ||
      nextState.lifecycle.finalization.state !==
        state.lifecycle.finalization.state;
    state = nextState;
    if (state.capture.mode === "recall")
      captureMeetingPlatform = state.capture.meetingPlatform;
    render();
    maybeFinish();
    if (shouldRefreshHistory) {
      void refreshSessionHistory();
    }
  });
} catch (caught) {
  appRoot.replaceChildren(
    Object.assign(document.createElement("p"), {
      className: "error-message",
      textContent: errorMessage(caught),
    }),
  );
}

appRoot.addEventListener("compositionend", () => {
  queueMicrotask(maybeFinish);
});
function hasCloseDraft(): boolean {
  return Boolean(
    editor.dirty ||
      editor.checks.size ||
      editor.composing ||
      persistencePending ||
      saving,
  );
}
Object.defineProperty(window, "caddyPrepareClose", {
  value: async (action: unknown) => {
    if (action === "cancel") {
      if (closeApproved) {
        closeApproved = false;
        editor.locked = false;
        appRoot.inert = false;
        render();
      }
      return "clean";
    }
    if (action === "status") return hasCloseDraft() ? "dirty" : "clean";
    if (!["save", "discard", "clean"].includes(String(action)))
      return "blocked";
    if (
      activeFlushes > 0 ||
      submitting ||
      finishing ||
      startingCapture ||
      startingNextSession ||
      choosingPrep ||
      saving
    )
      return "blocked";
    if (action === "clean" && hasCloseDraft()) return "dirty";
    try {
      preparingClose = true;
      render();
      if (action === "save") await flushEdits();
      // Atomic with the last drain: no later edit may arrive before native close.
      closeApproved = true;
      editor.locked = true;
      appRoot.inert = true;
      render();
      return "ready";
    } catch (caught) {
      error = errorMessage(caught);
      render();
      return "blocked";
    } finally {
      preparingClose = false;
      render();
    }
  },
});
window.addEventListener("beforeunload", (event) => {
  if (!closeApproved && hasCloseDraft()) event.preventDefault();
});
