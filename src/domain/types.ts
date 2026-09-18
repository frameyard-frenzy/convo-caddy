import type { CaptureState } from "./capture.js";
import type { SessionLifecycle } from "./session-lifecycle.js";

export {
  PARTICIPANT_RECORDING_NOTICE,
  RECORDING_NOTICE_DISPLAY_MS,
} from "./capture.js";
export type {
  CaptureState,
  RecallCaptureStatus,
  RecallRegion,
} from "./capture.js";
export type {
  ProviderMilestones,
  RecallLifecycleMilestone,
  RequiredProviderMilestone,
  SessionFinalization,
  SessionLifecycle,
} from "./session-lifecycle.js";

export type Tier = "must" | "more";

export type TranscriptTurn = {
  id: string;
  providerEventId?: string;
  speakerId: string;
  speakerLabel: string;
  text: string;
  startedAtMs: number;
  endedAtMs: number;
  receivedAt: string;
  final: true;
};

export type TranscriptRef = {
  anchorTurnId: string | null;
  windowTurnIds: string[];
  capturedAt: string;
  relativeMs: number;
};

export type PreparedTopic = {
  id: string;
  tier: Tier;
  text: string;
  checked: boolean;
  humanEdited?: boolean;
};

export type CheckableItem = {
  id: string;
  text: string;
  checked: boolean;
  humanEdited?: boolean;
  createdAt: string;
  relativeMs: number;
  transcriptRef: TranscriptRef;
};

export type NoteItem = Omit<CheckableItem, "checked">;

export type ChatEntry = {
  id: string;
  question: string;
  response: string | null;
  error: string | null;
  citationTurnIds: string[];
  createdAt: string;
  relativeMs: number;
};

export type SimulationStatus = "idle" | "running" | "paused" | "complete";

export type SimulationState = {
  status: SimulationStatus;
  cursor: number;
  speed: number;
};

export type HumanContext = {
  title: string;
  plannedDurationMinutes: number;
  personSummary: Array<{ id: string; text: string }>;
};

export type SessionState = {
  humanContext?: HumanContext;
  contentRevision?: number;
  contentEdited?: boolean;
  contentFlushRequired?: boolean;
  sessionId: string;
  startedAt: string;
  elapsedMs: number;
  topics: PreparedTopic[];
  revisit: CheckableItem[];
  questions: CheckableItem[];
  notes: NoteItem[];
  transcript: TranscriptTurn[];
  chat: ChatEntry[];
  capture: CaptureState;
  lifecycle: SessionLifecycle;
  simulation: SimulationState;
};

export type ParsedInput =
  | { kind: "note"; text: string }
  | { kind: "question"; text: string }
  | { kind: "revisit"; hint?: string }
  | { kind: "askMarty"; text: string }
  | { kind: "invalid"; message: string };
