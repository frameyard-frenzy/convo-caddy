import type { ContentEdit } from "../domain/content-edit.js";
import type { SessionState } from "../domain/types.js";
import type {
  InputResult,
  SimulationAction,
  StartRecallCaptureResult,
} from "../server/session-service.js";
import type { RuntimeReadiness } from "../server/connectivity/readiness.js";
type WorkspaceSessionSummary = {
  sessionId: string;
  startedAt: string;
  displayName: string | null;
  lifecycle: "completed";
};
export type WorkspaceOverview = {
  root: string;
  warning: string | null;
  selectedPrep: string | null;
  selectedPrepDisplayName?: string | null;
  prep: {
    valid: Array<{
      basename: string;
      prep: {
        schemaVersion: 1;
        title: string;
        plannedDurationMinutes: number;
        personSummary?: string[];
        topics: Array<{ tier: "must" | "more"; text: string }>;
      };
      sourceBytes: string;
    }>;
    errors: Array<{ basename: string; error: string }>;
  };
  finished: {
    valid: Array<{ name: string; markdown: string }>;
    errors: Array<{ name: string; error: string }>;
  };
};

export type SessionEnvelope = {
  state: SessionState;
  diagnostics: { providerCallCount: number };
};

type CheckableSection = "topics" | "revisit" | "questions";

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch((error: unknown) => {
    // Express rejects oversized bodies before the JSON route handler runs.
    // Keep the byte cap and identify this known non-committed response so an
    // edited-down draft can replace its rejected request on retry.
    if (response.status === 413)
      throw new ApiRequestError(
        413,
        "This edit exceeds the request limit. Shorten the changed text; your draft was kept.",
      );
    throw error;
  })) as T;
  if (!response.ok) {
    const errorBody = body as { error?: string; message?: string };
    const message = errorBody.error ?? errorBody.message ?? "Request failed.";
    throw new ApiRequestError(response.status, message);
  }
  return body;
}

export function getSession(): Promise<SessionEnvelope> {
  return requestJson<SessionEnvelope>("/api/session");
}

export function getRuntimeReadiness(): Promise<{
  readiness: RuntimeReadiness | null;
  workspaceRoot?: string | null;
}> {
  return requestJson("/api/runtime/readiness");
}

export async function submitInput(
  input: string,
  mutationId: string,
): Promise<InputResult> {
  const response = await fetch("/api/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, mutationId }),
  });
  return (await response.json()) as InputResult;
}

export async function setChecked(
  section: CheckableSection,
  itemId: string,
  checked: boolean,
): Promise<SessionState> {
  const result = await requestJson<{ state: SessionState }>(
    `/api/session/${section}/${encodeURIComponent(itemId)}/check`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked }),
    },
  );
  return result.state;
}

export async function controlSimulation(
  action: SimulationAction,
): Promise<SessionState> {
  const result = await requestJson<{ state: SessionState }>(
    `/api/session/simulation/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  return result.state;
}

export function getSessionHistory(): Promise<{
  sessions: WorkspaceSessionSummary[];
}> {
  return requestJson("/api/sessions");
}
export function getWorkspace(): Promise<{
  workspace: WorkspaceOverview | null;
}> {
  return requestJson("/api/workspace");
}
export function selectPrep(
  basename: string,
  sessionId?: string,
): Promise<{ state: SessionState; workspace: WorkspaceOverview }> {
  return requestJson("/api/workspace/prep/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ basename, sessionId }),
  });
}
export function savePrep(input: {
  basename: string;
  prep: WorkspaceOverview["prep"]["valid"][number]["prep"];
  expectedSourceBytes: string | null;
}): Promise<{ workspace: WorkspaceOverview }> {
  return requestJson("/api/workspace/prep", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
export function finishSaving(
  sessionId: string,
  revision: number,
): Promise<{
  state: SessionState;
  workspace: WorkspaceOverview;
}> {
  return requestJson("/api/session/finish-saving", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, revision }),
  });
}

export function startNextSession(): Promise<{
  state: SessionState;
  sessions: WorkspaceSessionSummary[];
}> {
  return requestJson("/api/session/new", {
    method: "POST",
  });
}

export async function startRecallCapture(input: {
  meetingUrl: string;
  displayName?: string;
}): Promise<StartRecallCaptureResult> {
  const response = await fetch("/api/capture/recall/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await response.json()) as StartRecallCaptureResult;
}

export function subscribeToSession(
  onState: (state: SessionState) => void,
): EventSource {
  const eventSource = new EventSource("/api/events");
  eventSource.addEventListener("session", (event) => {
    onState(JSON.parse(event.data) as SessionState);
  });
  return eventSource;
}

export function retryHermesConnection(): Promise<{
  readiness: RuntimeReadiness | null;
}> {
  return requestJson("/api/runtime/hermes/retry", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function choosePrep(): Promise<
  | { kind: "canceled" }
  | { kind: "browser"; workspace: WorkspaceOverview; sessionId: string }
  | { kind: "selected"; workspace: WorkspaceOverview; state: SessionState }
> {
  return requestJson("/api/workspace/prep/choose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export function editContent(
  edit: ContentEdit,
): Promise<{ state: SessionState }> {
  return requestJson("/api/session/content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edit),
  });
}

export function openContentEditing(): Promise<{ state: SessionState }> {
  return requestJson("/api/session/content/open", { method: "POST" });
}

export function saveCurrentContent(
  sessionId: string,
  revision: number,
): Promise<{ state: SessionState }> {
  return requestJson("/api/session/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, revision }),
  });
}
