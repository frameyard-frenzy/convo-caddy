import { rebaseWorkspaceBinding } from "./persistence/file-session-repository.js";
import { realpathSync, lstatSync } from "node:fs";
import {
  renderUpdatedPrep,
  replaceSelectedPrep,
} from "./workspace/prep-writeback.js";
import { parsePrep } from "./workspace/prep-format.js";
import { applyContentEdit, contentEditSchema } from "../domain/content-edit.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type Clock, SystemClock } from "../domain/clock.js";
import { parseInput } from "../domain/input-parser.js";
import {
  createInitialSessionLifecycle,
  isPreparation,
  missingRequiredProviderMilestones,
  recordProviderMilestone,
} from "../domain/session-lifecycle.js";
import {
  reduceSession,
  type SessionAction,
} from "../domain/session-reducer.js";
import { createTranscriptRef } from "../domain/transcript-reference.js";
import type {
  CaptureState,
  ChatEntry,
  CheckableItem,
  NoteItem,
  PreparedTopic,
  RecallCaptureStatus,
  RecallLifecycleMilestone,
  SessionState,
  TranscriptRef,
  TranscriptTurn,
} from "../domain/types.js";
import {
  PARTICIPANT_RECORDING_NOTICE,
  RECORDING_NOTICE_DISPLAY_MS,
} from "../domain/types.js";
import { UNVERIFIED_RECALL_RECORDING_RETENTION } from "../domain/capture.js";
import {
  type CaptureProvider,
  isPersonalTeamsMeetingUrl,
} from "./capture/capture-provider.js";
import { buildMartyContext } from "./marty/context-builder.js";
import { FakeMartyProvider } from "./marty/fake-marty-provider.js";
import type {
  MartyContext,
  MartyProvider,
  MartyResponse,
} from "./marty/marty-provider.js";
import { parseMartyResponse } from "./marty/response-schema.js";
import { UnavailableMartyProvider } from "./marty/unavailable-marty-provider.js";
import type {
  MutationReceipt,
  SessionRepository,
} from "./persistence/file-session-repository.js";
import {
  type InterviewPrep,
  type PrepFile,
  publishFinishedConversation,
  readPrep,
  readPrepText,
  savePrep,
  scanFinishedConversations,
  scanPrep,
  snapshotNativePrep,
  templateTopics,
} from "./workspace/user-workspace.js";
import {
  type SimulatorTimers,
  TranscriptSimulator,
} from "./transcript/simulator.js";

const transcriptTurnSchema = z
  .strictObject({
    id: z.string().min(1),
    providerEventId: z.string().min(1).optional(),
    speakerId: z.string().min(1),
    speakerLabel: z.string().min(1),
    text: z.string().min(1),
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: z.number().int().nonnegative(),
    receivedAt: z.iso.datetime(),
    final: z.literal(true),
  })
  .refine((turn) => turn.endedAtMs >= turn.startedAtMs, {
    message: "Transcript turns must end after they start.",
  });

const transcriptFixtureSchema = z
  .array(transcriptTurnSchema)
  .refine(
    (turns) => new Set(turns.map((turn) => turn.id)).size === turns.length,
    "Transcript turn IDs must be unique.",
  )
  .refine(
    (turns) =>
      turns.every(
        (turn, index) =>
          index === 0 || turn.endedAtMs >= (turns[index - 1]?.endedAtMs ?? 0),
      ),
    "Transcript turns must be chronological.",
  );

const captureStatusOrder: Record<RecallCaptureStatus, number> = {
  creating: 0,
  joining: 1,
  waiting_room: 2,
  in_call: 3,
  recording: 4,
  ended: 5,
  failed: 5,
};

type RecallCaptureState = Extract<CaptureState, { mode: "recall" }>;

function canAdvanceCaptureStatus(
  current: RecallCaptureStatus,
  next: RecallCaptureStatus,
): boolean {
  if (current === "failed") {
    return next === "failed";
  }
  if (current === "ended") {
    return next === "ended";
  }
  return captureStatusOrder[next] >= captureStatusOrder[current];
}

function latestTimestamp(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function isLifecycleMilestoneConsistent(
  status: RecallCaptureStatus,
  milestone: RecallLifecycleMilestone | null,
): boolean {
  if (status === "failed") {
    return milestone === "provider_error";
  }
  if (status === "ended") {
    return milestone !== null && milestone !== "provider_error";
  }
  return milestone === null;
}

function observeOperatorAdmission(
  capture: RecallCaptureState,
  observedAt: string,
): RecallCaptureState {
  if (capture.authorization.state === "confirmed") {
    return capture;
  }
  const callAlreadyEnded = capture.status === "ended";
  const notice: RecallCaptureState["notice"] = callAlreadyEnded
    ? {
        text: PARTICIPANT_RECORDING_NOTICE,
        displayDurationMs: RECORDING_NOTICE_DISPLAY_MS,
        delivery: "video_with_chat_fallback",
        state: "cleared",
        displayedAt: observedAt,
        clearedAt: observedAt,
        error: null,
      }
    : {
        text: PARTICIPANT_RECORDING_NOTICE,
        displayDurationMs: RECORDING_NOTICE_DISPLAY_MS,
        delivery: "video_with_chat_fallback",
        state: "displaying",
        displayedAt: observedAt,
        clearedAt: null,
        error: null,
      };
  return {
    ...capture,
    authorization: {
      method: "operator_admission",
      state: "confirmed",
      admittedAt: observedAt,
    },
    notice,
  };
}

export type InputSubmission = {
  input: string;
  mutationId: string;
};

export type InputResult = {
  ok: boolean;
  mutationId: string;
  kind: "accepted" | "invalid_input" | "provider_failure";
  state: SessionState;
  error?: string;
};

export type SimulationAction = "start" | "pause" | "resume" | "step" | "reset";
export type SessionListener = (state: SessionState) => void;
export type StartRecallCaptureInput = {
  meetingUrl: string;
  displayName?: string;
};

export type StartRecallCaptureResult =
  | { ok: true; kind: "accepted"; state: SessionState }
  | {
      ok: false;
      kind: "invalid" | "conflict" | "provider_failure";
      error: string;
      state: SessionState;
    };

export type IngestRecallTranscriptInput = {
  botId: string;
  operationId?: string;
  recordingId: string;
  turn: TranscriptTurn;
};

export type IngestRecallEventResult =
  | "accepted"
  | "duplicate"
  | "ignored"
  | "conflict";

export type IngestRecallLifecycleInput = {
  botId: string;
  operationId?: string;
  recordingId: string | null;
  status: RecallCaptureStatus;
  milestone: RecallLifecycleMilestone | null;
  occurredAt: string;
  error?: string;
};

export type RecallReconciliationResult =
  | { kind: "not_needed" }
  | { kind: "already_attempted" }
  | { kind: "reconciled"; observations: number }
  | {
      kind: "needs_attention";
      diagnostic:
        | "recall_bot_id_missing"
        | "recall_reconciliation_failed"
        | "recall_reconciliation_conflict";
    };

export type SessionServiceOptions = {
  topics: PreparedTopic[];
  transcript: TranscriptTurn[];
  provider: MartyProvider;
  clock?: Clock;
  createId?: () => string;
  timers?: SimulatorTimers;
  simulationSpeed?: number;
  repository?: SessionRepository;
  captureProvider?: CaptureProvider;
  noticeTimers?: RecordingNoticeTimers;
  initialCaptureMode?: "simulation" | "live_ready";
  userWorkspaceRoot?: string;
  recallCaptureAvailable?: boolean;
};

export type RecordingNoticeTimers = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const systemRecordingNoticeTimers: RecordingNoticeTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SessionService {
  readonly #provider: MartyProvider;
  readonly #clock: Clock;
  readonly #createId: () => string;
  #topicTemplate: PreparedTopic[];
  readonly #simulator: TranscriptSimulator;
  #repository?: SessionRepository;
  #userWorkspaceRoot?: string;
  #workspaceMoving = false;
  #workspaceMoveRecovery: string | undefined;
  #activeWrites = 0;
  #pendingInputs = 0;
  readonly #captureProvider?: CaptureProvider;
  readonly #noticeTimers: RecordingNoticeTimers;
  readonly #listeners = new Set<SessionListener>();
  readonly #mutations = new Map<
    string,
    { input: string; result: Promise<InputResult> }
  >();
  readonly #receipts = new Map<string, MutationReceipt>();
  #state: SessionState;
  #generation = 0;
  #closed = false;
  #suppressSimulatorState = false;
  #noticeTimer: unknown;
  #noticeTimerBotId: string | null = null;
  #recallReconciliationAttempted = false;
  #recallCaptureAvailable: boolean;
  #readOnlyRecallReconciliation = false;
  #recordingNoticeMutationEnabled: boolean;
  #reconciledActiveNotice = false;
  #workspaceWarning: string | null = null;

  constructor(options: SessionServiceOptions) {
    this.#provider = options.provider;
    this.#clock = options.clock ?? new SystemClock();
    this.#createId = options.createId ?? randomUUID;
    this.#repository = options.repository;
    this.#userWorkspaceRoot = options.userWorkspaceRoot;
    this.#captureProvider = options.captureProvider;
    this.#noticeTimers = options.noticeTimers ?? systemRecordingNoticeTimers;
    this.#recallCaptureAvailable = options.recallCaptureAvailable ?? true;
    this.#recordingNoticeMutationEnabled = this.#recallCaptureAvailable;
    const persisted = this.#repository?.load() ?? null;
    const persistedBinding = this.#repository?.getWorkspaceBinding?.() ?? null;
    const startupTopics =
      persisted && persistedBinding
        ? topicsFromPrep(persistedBinding.prep)
        : options.topics;
    this.#topicTemplate = startupTopics.map((topic) => ({
      ...topic,
      checked: false,
    }));
    this.#state =
      persisted?.state ??
      this.#createInitialState(
        this.#createId(),
        this.#clock.now().toISOString(),
        options.simulationSpeed ?? 20,
        options.initialCaptureMode ?? "simulation",
      );
    // Old checkpoints predate editable context. The saved prep binding is their
    // metadata authority, even if the working source has changed since saving.
    if (!this.#state.humanContext && persistedBinding)
      this.#state = {
        ...this.#state,
        humanContext: contextFromPrep(persistedBinding.prep),
      };
    for (const receipt of persisted?.mutations ?? []) {
      this.#receipts.set(receipt.mutationId, receipt);
    }
    if (persisted) {
      this.#validatePersistedSession(options.transcript);
    }
    this.#simulator = new TranscriptSimulator(
      options.transcript,
      (turn) => this.#appendTranscriptTurn(turn),
      options.timers,
      (simulation) => {
        if (!this.#suppressSimulatorState) {
          this.#setSimulationState(simulation);
        }
      },
      this.#state.simulation.speed,
    );
    if (this.#state.capture.mode !== "simulation") {
      this.#simulator.restore(this.#state.simulation);
    } else {
      this.#simulator.restore(this.#state.simulation, this.#state.elapsedMs);
    }
    if (!persisted) {
      this.#persist();
    }
    this.#recoverFinalization();
    this.#scheduleRecordingNoticeClear();
  }

  beginWriteRequest(): () => void {
    if (this.#workspaceMoveRecovery)
      throw new Error(this.#workspaceMoveRecovery);
    if (this.#workspaceMoving)
      throw new Error(
        "Workspace move in progress. Keep your draft and retry when it finishes.",
      );
    this.#activeWrites++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#activeWrites--;
      }
    };
  }
  beginWorkspaceMove(): (recoveryMessage?: string) => void {
    if (this.#workspaceMoveRecovery)
      throw new Error(this.#workspaceMoveRecovery);
    if (this.#repository?.getWorkspaceBinding?.()?.pendingPrepWrite)
      throw new Error("Retry Save before moving the workspace.");
    const finalization = this.#state.lifecycle.finalization.state;
    if (this.#workspaceMoving || this.#activeWrites || this.#pendingInputs)
      throw new Error(
        "Finish the open file chooser or pending write before moving the workspace.",
      );
    if (
      (this.#state.capture.mode === "recall" && finalization !== "complete") ||
      ["finalizing", "needs_attention", "waiting_for_provider"].includes(
        finalization,
      )
    )
      throw new Error("Finish capture and saving before moving the workspace.");
    this.#workspaceMoving = true;
    return (recoveryMessage) => {
      this.#workspaceMoveRecovery = recoveryMessage;
      this.#workspaceMoving = Boolean(recoveryMessage);
    };
  }
  rebaseWorkspace(root: string): void {
    if (!this.#workspaceMoving)
      throw new Error("Workspace rebasing requires the move lock.");
    const binding = this.#repository?.getWorkspaceBinding?.();
    if (binding)
      this.#repository?.setWorkspaceBinding?.(
        rebaseWorkspaceBinding(binding, binding.workspaceRoot, root),
      );
    this.#userWorkspaceRoot = root;
    this.#publish();
  }

  getSnapshot(): SessionState {
    return structuredClone(this.#state);
  }

  getProviderCallCount(): number {
    return this.#provider.invocationCount;
  }

  setRecallCaptureAvailable(available: boolean): void {
    this.#recallCaptureAvailable = available;
    this.#recordingNoticeMutationEnabled = available;
    if (available) {
      this.#scheduleRecordingNoticeClear();
    } else {
      this.#clearRecordingNoticeTimer();
    }
  }

  async reconcileRecallCapture(): Promise<RecallReconciliationResult> {
    if (this.#recallReconciliationAttempted) {
      return { kind: "already_attempted" };
    }
    this.#recallReconciliationAttempted = true;
    const capture = this.#state.capture;
    if (
      capture.mode !== "recall" ||
      this.#state.lifecycle.finalization.state === "complete" ||
      missingRequiredProviderMilestones(
        this.#state.lifecycle.providerMilestones,
      ).length === 0
    ) {
      return { kind: "not_needed" };
    }
    if (capture.provider.botId === null || !capture.operationId) {
      return {
        kind: "needs_attention",
        diagnostic: "recall_bot_id_missing",
      };
    }
    if (!this.#captureProvider?.retrieveBot) {
      return {
        kind: "needs_attention",
        diagnostic: "recall_reconciliation_failed",
      };
    }

    try {
      const retrieved = await this.#captureProvider.retrieveBot({
        botId: capture.provider.botId,
        operationId: capture.operationId,
      });
      let observations = 0;
      this.#readOnlyRecallReconciliation = true;
      try {
        for (const observation of retrieved.observations) {
          if (
            observation.status === "in_call" ||
            observation.status === "recording"
          ) {
            this.#reconciledActiveNotice = true;
          }
          const result = this.ingestRecallLifecycle(observation);
          if (result === "ignored" || result === "conflict") {
            return {
              kind: "needs_attention",
              diagnostic: "recall_reconciliation_conflict",
            };
          }
          observations += 1;
        }
      } finally {
        this.#readOnlyRecallReconciliation = false;
      }
      return { kind: "reconciled", observations };
    } catch {
      return {
        kind: "needs_attention",
        diagnostic: "recall_reconciliation_failed",
      };
    }
  }

  async startRecallCapture(
    input: StartRecallCaptureInput,
  ): Promise<StartRecallCaptureResult> {
    if (this.#closed) {
      return this.#captureStartFailure(
        "provider_failure",
        "Convo Caddy is shutting down.",
      );
    }
    const workspaceBinding = this.#repository?.getWorkspaceBinding?.() ?? null;
    if (this.#userWorkspaceRoot && !workspaceBinding) {
      return this.#captureStartFailure(
        "conflict",
        "Select a valid prep before starting the interview.",
      );
    }
    if (workspaceBinding?.pendingPrepWrite)
      return this.#captureStartFailure(
        "conflict",
        "Retry Save before starting capture.",
      );
    const generation = this.#generation;
    if (!isPersonalTeamsMeetingUrl(input.meetingUrl)) {
      return this.#captureStartFailure(
        "invalid",
        "A personal Microsoft Teams meeting link is required.",
      );
    }
    const displayName = input.displayName?.trim() || null;
    if (displayName !== null && displayName.length > 80) {
      return this.#captureStartFailure(
        "invalid",
        "Interview name must be 80 characters or fewer.",
      );
    }
    if (!this.#captureProvider) {
      return this.#captureStartFailure(
        "provider_failure",
        "Recall live capture is not configured.",
      );
    }
    if (!this.#recallCaptureAvailable) {
      return this.#captureStartFailure(
        "conflict",
        "Recall callback connectivity is not ready. Wait for capture readiness before starting.",
      );
    }
    if (this.#state.capture.mode === "recall") {
      return this.#captureStartFailure(
        "conflict",
        "A Recall capture has already been started for this session.",
      );
    }
    if (!this.#isPristineForLiveCapture()) {
      return this.#captureStartFailure(
        "conflict",
        "Reset the current synthetic session before starting live capture.",
      );
    }

    const previousState = this.#state;
    const previousTopicTemplate = this.#topicTemplate;
    if (
      this.#userWorkspaceRoot &&
      workspaceBinding &&
      !this.#state.contentEdited
    ) {
      let selected: PrepFile;
      try {
        selected = readPrep(
          this.#userWorkspaceRoot,
          workspaceBinding.prepSourceFile,
        );
      } catch (error) {
        return this.#captureStartFailure(
          "conflict",
          error instanceof Error
            ? error.message
            : "The selected prep is unavailable or malformed.",
        );
      }
      this.#repository?.setWorkspaceBinding?.({
        ...workspaceBinding,
        workspaceRoot: this.#userWorkspaceRoot,
        prep: selected.prep,
        prepSourceFile: selected.basename,
        prepSourceBytes: selected.sourceBytes,
      });
      this.#topicTemplate = topicsFromPrep(selected.prep);
      const topics = isDeepStrictEqual(selected.prep, workspaceBinding.prep)
        ? this.#state.topics
        : this.#topicTemplate.map((topic) => ({ ...topic }));
      const humanContext = contextFromPrep(selected.prep);
      const changed =
        !isDeepStrictEqual(topics, this.#state.topics) ||
        !isDeepStrictEqual(humanContext, this.#state.humanContext);
      this.#state = {
        ...this.#state,
        topics,
        humanContext,
        ...(changed
          ? { contentRevision: (this.#state.contentRevision ?? 0) + 1 }
          : {}),
      };
    }

    const requestedAt = this.#clock.now().toISOString();
    const operationId = randomUUID();
    const creating: CaptureState = {
      mode: "recall",
      operationId,
      status: "creating",
      authorization: {
        method: "operator_admission",
        state: "pending",
        admittedAt: null,
      },
      notice: {
        text: PARTICIPANT_RECORDING_NOTICE,
        displayDurationMs: RECORDING_NOTICE_DISPLAY_MS,
        delivery: "video_with_chat_fallback",
        state: "pending",
        displayedAt: null,
        clearedAt: null,
        error: null,
      },
      provider: {
        name: "recall_ai",
        region: this.#captureProvider.region,
        botId: null,
        recordingId: null,
      },
      meetingPlatform: "microsoft_teams_personal",
      recording: {
        location: "recall_ai",
        retention: UNVERIFIED_RECALL_RECORDING_RETENTION,
      },
      lastEventAt: requestedAt,
      error: null,
    };
    this.#state = reduceSession(
      { ...this.#state, startedAt: requestedAt, elapsedMs: 0 },
      {
        type: "lifecycle.set",
        lifecycle: {
          ...createInitialSessionLifecycle("recall"),
          displayName: displayName ?? this.#state.lifecycle.displayName,
        },
      },
    );
    try {
      this.#dispatch({ type: "capture.set", capture: creating });
    } catch {
      this.#state = previousState;
      this.#topicTemplate = previousTopicTemplate;
      if (workspaceBinding)
        this.#repository?.setWorkspaceBinding?.(workspaceBinding);
      return this.#captureStartFailure(
        "provider_failure",
        "Recall capture could not be saved before bot creation. No bot was created.",
      );
    }

    try {
      const result = await this.#captureProvider.createBot({
        meetingUrl: input.meetingUrl,
        operationId,
      });
      if (generation !== this.#generation) {
        const error =
          "Recall bot creation completed after Convo Caddy began shutting down. Check the Recall dashboard before any recovery action.";
        return this.#captureStartFailure("provider_failure", error);
      }
      const currentCapture = this.#state.capture;
      if (
        currentCapture.mode !== "recall" ||
        currentCapture.operationId !== creating.operationId
      ) {
        const error =
          "Recall bot creation completed after the local capture operation changed. Check the Recall dashboard before any recovery action.";
        return this.#captureStartFailure("provider_failure", error);
      }
      if (
        currentCapture.provider.botId !== null &&
        currentCapture.provider.botId !== result.botId
      ) {
        const error =
          "Recall bot creation conflicted with the bot correlated by the webhook. Check the Recall dashboard before any recovery action.";
        return this.#captureStartFailure("provider_failure", error);
      }
      const joined: CaptureState = {
        ...currentCapture,
        status: canAdvanceCaptureStatus(currentCapture.status, "joining")
          ? currentCapture.status === "creating"
            ? "joining"
            : currentCapture.status
          : currentCapture.status,
        provider: { ...currentCapture.provider, botId: result.botId },
        lastEventAt: latestTimestamp(
          currentCapture.lastEventAt,
          this.#clock.now().toISOString(),
        ),
      };
      try {
        this.#dispatch({ type: "capture.set", capture: joined });
      } catch {
        const error =
          "Recall created a bot with a known bot ID, but local state could not be saved. Check the Recall dashboard before any recovery action.";
        this.#state = reduceSession(this.#state, {
          type: "capture.set",
          capture: { ...joined, status: "failed", error },
        });
        return this.#captureStartFailure("provider_failure", error);
      }
      return { ok: true, kind: "accepted", state: this.getSnapshot() };
    } catch {
      if (generation !== this.#generation) {
        const error =
          "Recall bot creation did not complete before Convo Caddy began shutting down. Check the Recall dashboard before any recovery action.";
        return this.#captureStartFailure("provider_failure", error);
      }
      const error =
        "Recall bot creation failed. Check the Recall dashboard before resetting or retrying.";
      this.#dispatch({
        type: "capture.set",
        capture: {
          ...creating,
          status: "failed",
          lastEventAt: this.#clock.now().toISOString(),
          error,
        },
      });
      return this.#captureStartFailure("provider_failure", error);
    }
  }

  ingestRecallTranscript(
    input: IngestRecallTranscriptInput,
  ): IngestRecallEventResult {
    const previousState = this.#state;
    let capture = this.#state.capture;
    if (
      capture.mode !== "recall" ||
      (capture.provider.botId === null
        ? !capture.operationId || capture.operationId !== input.operationId
        : capture.provider.botId !== input.botId)
    ) {
      return "ignored";
    }
    if (capture.provider.botId === null) {
      capture = {
        ...capture,
        provider: { ...capture.provider, botId: input.botId },
      };
      this.#state = reduceSession(this.#state, {
        type: "capture.set",
        capture,
      });
    }
    if (
      capture.provider.recordingId !== null &&
      capture.provider.recordingId !== input.recordingId
    ) {
      return "conflict";
    }
    if (this.#isImmutable()) {
      return "duplicate";
    }

    let appended: boolean;
    try {
      appended = this.#appendTranscriptTurn(input.turn);
    } catch {
      return "conflict";
    }
    if (!appended) {
      return "duplicate";
    }

    try {
      const admittedCapture = observeOperatorAdmission(
        capture,
        input.turn.receivedAt,
      );
      this.#dispatch({
        type: "capture.set",
        capture: {
          ...admittedCapture,
          status: canAdvanceCaptureStatus(admittedCapture.status, "recording")
            ? "recording"
            : admittedCapture.status,
          provider: {
            ...admittedCapture.provider,
            recordingId: input.recordingId,
          },
          lastEventAt: latestTimestamp(
            admittedCapture.lastEventAt,
            input.turn.receivedAt,
          ),
          error:
            admittedCapture.status === "failed" ? admittedCapture.error : null,
        },
      });
      this.#scheduleRecordingNoticeClear();
    } catch (error) {
      this.#state = previousState;
      throw error;
    }
    return "accepted";
  }

  ingestRecallLifecycle(
    input: IngestRecallLifecycleInput,
  ): IngestRecallEventResult {
    if (!isLifecycleMilestoneConsistent(input.status, input.milestone)) {
      return "conflict";
    }
    const previousState = this.#state;
    let capture = this.#state.capture;
    if (
      capture.mode !== "recall" ||
      (capture.provider.botId === null
        ? !capture.operationId || capture.operationId !== input.operationId
        : capture.provider.botId !== input.botId)
    ) {
      return "ignored";
    }
    if (capture.provider.botId === null) {
      capture = {
        ...capture,
        provider: { ...capture.provider, botId: input.botId },
      };
      this.#state = reduceSession(this.#state, {
        type: "capture.set",
        capture,
      });
    }
    if (
      capture.provider.recordingId !== null &&
      input.recordingId !== null &&
      capture.provider.recordingId !== input.recordingId
    ) {
      return "conflict";
    }
    if (this.#isImmutable()) {
      return "duplicate";
    }
    if (input.milestone === "provider_error") {
      const nextMilestones = recordProviderMilestone(
        this.#state.lifecycle.providerMilestones,
        input.milestone,
        input.occurredAt,
      );
      const nextCapture: RecallCaptureState = {
        ...capture,
        status: input.status,
        provider: {
          ...capture.provider,
          recordingId:
            capture.provider.recordingId ?? input.recordingId ?? null,
        },
        lastEventAt: latestTimestamp(capture.lastEventAt, input.occurredAt),
        error: input.error ?? capture.error,
      };
      if (
        isDeepStrictEqual(nextCapture, capture) &&
        isDeepStrictEqual(
          nextMilestones,
          this.#state.lifecycle.providerMilestones,
        )
      ) {
        return "duplicate";
      }
      try {
        const missing = missingRequiredProviderMilestones(nextMilestones);
        this.#state = reduceSession(this.#state, {
          type: "capture.set",
          capture: nextCapture,
        });
        this.#state = reduceSession(this.#state, {
          type: "lifecycle.set",
          lifecycle: {
            ...this.#state.lifecycle,
            providerMilestones: nextMilestones,
            finalization:
              missing.length > 0
                ? { state: "waiting_for_provider", missing }
                : { state: "pending" },
          },
        });
        this.#persist();
        this.#publish();
      } catch (error) {
        this.#state = previousState;
        throw error;
      }
      return "accepted";
    }
    if (!canAdvanceCaptureStatus(capture.status, input.status)) {
      if (input.milestone !== null) {
        const nextMilestones = recordProviderMilestone(
          this.#state.lifecycle.providerMilestones,
          input.milestone,
          input.occurredAt,
        );
        if (
          !isDeepStrictEqual(
            nextMilestones,
            this.#state.lifecycle.providerMilestones,
          )
        ) {
          const missing = missingRequiredProviderMilestones(nextMilestones);
          const terminalProofAdvanced =
            missing.length === 0 &&
            missingRequiredProviderMilestones(
              this.#state.lifecycle.providerMilestones,
            ).length > 0;
          if (terminalProofAdvanced) {
            this.#generation += 1;
          }
          const nextLifecycle = {
            ...this.#state.lifecycle,
            providerMilestones: nextMilestones,
            finalization:
              missing.length > 0
                ? { state: "waiting_for_provider" as const, missing }
                : { state: "pending" as const },
          };
          try {
            this.#state = reduceSession(this.#state, {
              type: "lifecycle.set",
              lifecycle: nextLifecycle,
            });
            this.#persist();
            this.#publish();
          } catch (error) {
            this.#state = previousState;
            throw error;
          }
          this.#maybeFinalize();
          return "accepted";
        }
      }
      return "duplicate";
    }

    let nextCapture: RecallCaptureState = {
      ...capture,
      status: input.status,
      provider: {
        ...capture.provider,
        recordingId: capture.provider.recordingId ?? input.recordingId ?? null,
      },
      lastEventAt: latestTimestamp(capture.lastEventAt, input.occurredAt),
      error: input.error ?? null,
    };
    if (input.status === "in_call" || input.status === "recording") {
      nextCapture = observeOperatorAdmission(nextCapture, input.occurredAt);
    } else if (
      input.status === "ended" &&
      nextCapture.notice.state === "displaying"
    ) {
      nextCapture = {
        ...nextCapture,
        notice: {
          ...nextCapture.notice,
          state: "cleared",
          clearedAt: input.occurredAt,
        },
      };
    }
    const nextMilestones =
      input.milestone === null
        ? this.#state.lifecycle.providerMilestones
        : recordProviderMilestone(
            this.#state.lifecycle.providerMilestones,
            input.milestone,
            input.occurredAt,
          );
    const nextMissingMilestones =
      missingRequiredProviderMilestones(nextMilestones);
    const currentFinalization = this.#state.lifecycle.finalization;
    const terminalProofAdvanced =
      nextMissingMilestones.length === 0 &&
      missingRequiredProviderMilestones(
        this.#state.lifecycle.providerMilestones,
      ).length > 0;
    if (terminalProofAdvanced) {
      this.#generation += 1;
    }
    const nextFinalization =
      (currentFinalization.state === "pending" ||
        currentFinalization.state === "waiting_for_provider") &&
      Object.values(nextMilestones).some((value) => value !== null)
        ? nextMissingMilestones.length > 0
          ? {
              state: "waiting_for_provider" as const,
              missing: nextMissingMilestones,
            }
          : { state: "pending" as const }
        : currentFinalization;
    const nextLifecycle = {
      ...this.#state.lifecycle,
      providerMilestones: nextMilestones,
      finalization: nextFinalization,
    };
    if (
      isDeepStrictEqual(nextCapture, capture) &&
      isDeepStrictEqual(nextLifecycle, this.#state.lifecycle)
    ) {
      this.#maybeFinalize();
      return "duplicate";
    }

    try {
      this.#state = reduceSession(this.#state, {
        type: "capture.set",
        capture: nextCapture,
      });
      this.#state = reduceSession(this.#state, {
        type: "lifecycle.set",
        lifecycle: nextLifecycle,
      });
      this.#persist();
      this.#publish();
    } catch (error) {
      this.#state = previousState;
      throw error;
    }
    this.#scheduleRecordingNoticeClear();
    this.#maybeFinalize();
    return "accepted";
  }

  startNextSession(): SessionState {
    if (!this.#userWorkspaceRoot || !this.#repository)
      throw new Error("User workspace persistence is not configured.");
    if (this.#state.lifecycle.finalization.state !== "complete") {
      throw new Error(
        "Complete the current interview before starting another.",
      );
    }
    const nextState = this.#createInitialState(
      this.#createId(),
      this.#clock.now().toISOString(),
      this.#simulator.snapshot().speed,
      "live_ready",
    );
    this.#repository.clear?.();
    this.#generation += 1;
    this.#mutations.clear();
    this.#receipts.clear();
    this.#clearRecordingNoticeTimer();
    this.#recallReconciliationAttempted = false;
    this.#reconciledActiveNotice = false;
    this.#suppressSimulatorState = true;
    this.#simulator.reset();
    this.#suppressSimulatorState = false;
    this.#state = nextState;
    this.#publish();
    return this.getSnapshot();
  }

  listSessions() {
    return this.#userWorkspaceRoot
      ? scanFinishedConversations(this.#userWorkspaceRoot).valid.map(
          (record) => ({
            sessionId: record.manifest.sessionId,
            startedAt: record.manifest.startedAt,
            displayName: record.conversation.session.lifecycle.displayName,
            lifecycle: "completed" as const,
          }),
        )
      : [];
  }

  openContentEditing(): SessionState {
    if (!this.#isImmutable() && !this.#state.contentFlushRequired) {
      const next = { ...this.#state, contentFlushRequired: true };
      this.#repository?.save(next, [...this.#receipts.values()]);
      this.#state = next;
      this.#publish();
    }
    return this.getSnapshot();
  }

  retryFinalization(flushed?: { sessionId: string; revision: number }): void {
    if (this.#state.contentFlushRequired) {
      if (
        !flushed ||
        flushed.sessionId !== this.#state.sessionId ||
        flushed.revision !== (this.#state.contentRevision ?? 0)
      )
        throw new Error(
          "Current edits must be saved before finishing. Your draft was kept.",
        );
      if (
        missingRequiredProviderMilestones(
          this.#state.lifecycle.providerMilestones,
        ).length
      )
        throw new Error("Waiting for the provider to finish the conversation.");
      const next = { ...this.#state, contentFlushRequired: false };
      this.#repository?.save(next, [...this.#receipts.values()]);
      this.#state = next;
    }
    this.#maybeFinalize();
  }

  getWorkspaceRoot(): string | null {
    return this.#userWorkspaceRoot ?? null;
  }

  getWorkspaceOverview() {
    if (!this.#userWorkspaceRoot) return null;
    const binding = this.#repository?.getWorkspaceBinding?.();
    return {
      root: this.#userWorkspaceRoot,
      warning: this.#workspaceWarning,
      prep: scanPrep(this.#userWorkspaceRoot),
      finished: scanFinishedConversations(this.#userWorkspaceRoot),
      selectedPrep: binding?.prepSourceFile ?? null,
      // Display identity is separate from the unique working-copy routing key.
      // Old bindings without original authority retain their exact stored name.
      selectedPrepDisplayName: binding?.prepWriteTarget
        ? path.basename(binding.prepWriteTarget)
        : (binding?.prepSourceFile ?? null),
    };
  }

  // Only the injected native Open panel supplies this authority. HTTP callers
  // can select current basenames, but cannot submit an arbitrary file path.
  selectNativePrep(file: string): SessionState {
    if (!this.#userWorkspaceRoot || !this.#repository?.setWorkspaceBinding)
      throw new Error("User workspace is unavailable.");
    if (this.#state.capture.mode === "recall" && !isPreparation(this.#state))
      throw new Error("Prep cannot change after the interview starts.");
    const selected = snapshotNativePrep(this.#userWorkspaceRoot, file);
    return this.selectPrep(
      selected.basename,
      path.join(realpathSync(path.dirname(file)), path.basename(file)),
    );
  }

  selectPrep(basename: string, nativeTarget?: string): SessionState {
    if (!this.#userWorkspaceRoot || !this.#repository?.setWorkspaceBinding)
      throw new Error("User workspace is unavailable.");
    if (this.#state.capture.mode === "recall" && !isPreparation(this.#state))
      throw new Error("Prep cannot change after the interview starts.");
    const selected = readPrep(this.#userWorkspaceRoot, basename);
    this.#repository.setWorkspaceBinding({
      workspaceRoot: this.#userWorkspaceRoot,
      prep: selected.prep,
      prepSourceFile: selected.basename,
      prepSourceBytes: selected.sourceBytes,
      ...(nativeTarget ? { prepWriteTarget: nativeTarget } : {}),
    });
    this.#topicTemplate = topicsFromPrep(selected.prep);
    this.#state = {
      ...this.#state,
      topics: this.#topicTemplate.map((topic) => ({ ...topic })),
      humanContext: contextFromPrep(selected.prep),
      ...(selected.prep.savedContent || isPreparation(this.#state)
        ? {
            notes: selected.prep.savedContent?.notes ?? [],
            questions: selected.prep.savedContent?.questions ?? [],
            revisit: selected.prep.savedContent?.revisit ?? [],
            lifecycle: {
              ...this.#state.lifecycle,
              displayName: selected.prep.savedContent?.displayName ?? null,
            },
          }
        : {}),
      contentRevision: (this.#state.contentRevision ?? -1) + 1,
      contentEdited: false,
    };
    this.#persist();
    this.#publish();
    return this.getSnapshot();
  }

  editContent(value: unknown): SessionState {
    const edit = contentEditSchema.parse(value);
    if (this.#isImmutable())
      throw new Error(
        "This interview is finished or waiting for saving recovery.",
      );
    const input = `content-edit:${JSON.stringify(edit)}`;
    const receipt = this.#receipts.get(edit.mutationId);
    if (receipt) {
      if (receipt.input !== input)
        throw new Error("Edit identity was already used.");
      return this.getSnapshot();
    }
    const next = applyContentEdit(
      this.#state,
      edit,
      this.#createCurrentReference(),
      this.#createId,
    );
    const accepted: MutationReceipt = {
      mutationId: edit.mutationId,
      input,
      ok: true,
      kind: "accepted",
    };
    // Publish and replace memory only after the durable checkpoint succeeds.
    this.#repository?.save(next, [...this.#receipts.values(), accepted]);
    this.#receipts.set(edit.mutationId, accepted);
    this.#state = next;
    this.#publish();
    return this.getSnapshot();
  }

  saveCurrentContent(value: unknown): SessionState {
    const expected = z
      .strictObject({
        sessionId: z.string(),
        revision: z.number().int().nonnegative(),
      })
      .parse(value);
    if (this.#workspaceMoving)
      throw new Error("Workspace move recovery must finish before saving.");
    if (
      expected.sessionId !== this.#state.sessionId ||
      expected.revision !== (this.#state.contentRevision ?? 0)
    )
      throw new Error("Content changed before saving. Your draft was kept.");
    if (this.#state.lifecycle.finalization.state === "complete")
      return this.getSnapshot();
    const capture = this.#state.capture;
    if (capture.mode === "recall" && capture.status === "creating")
      throw new Error("Capture is starting. Retry Save when it finishes.");
    if (!isPreparation(this.#state)) {
      this.#persist();
      return this.getSnapshot();
    }
    let binding = this.#repository?.getWorkspaceBinding?.();
    if (
      !binding ||
      !this.#repository?.setWorkspaceBinding ||
      /^TEMPLATE\./i.test(binding.prepSourceFile)
    )
      throw new Error(
        "Choose a writable prep file before saving preparation. Your draft was kept.",
      );
    for (const directory of [
      binding.workspaceRoot,
      path.join(binding.workspaceRoot, "prep"),
      path.join(binding.workspaceRoot, "prep/current"),
    ]) {
      if (!lstatSync(directory).isDirectory())
        throw new Error(
          "The selected prep location changed. Your draft was kept; restore the workspace and retry Save.",
        );
    }
    const working = path.join(
      realpathSync(path.join(binding.workspaceRoot, "prep/current")),
      binding.prepSourceFile,
    );
    const target = binding.prepWriteTarget ?? working;
    // The durable intent is saved BEFORE either file changes. On retry, only
    // our exact before/after bytes are acceptable; arbitrary later writes are not.
    if (!binding.pendingPrepWrite) {
      const bytes = renderUpdatedPrep(
        binding.prepSourceBytes,
        binding.prepSourceFile,
        this.#state,
      );
      const pending = { ...binding, pendingPrepWrite: { bytes } };
      this.#repository.setWorkspaceBinding(pending);
      try {
        this.#persist();
      } catch (error) {
        this.#repository.setWorkspaceBinding(binding);
        throw error;
      }
      binding = pending;
    }
    const bytes = binding.pendingPrepWrite!.bytes;
    for (const file of new Set([target, working])) {
      const actual = readPrepText(file);
      if (actual !== bytes)
        replaceSelectedPrep(file, binding.prepSourceBytes, bytes);
    }
    const next = {
      ...binding,
      prep: parsePrep(bytes, binding.prepSourceFile),
      prepSourceBytes: bytes,
    };
    delete next.pendingPrepWrite;
    this.#repository.setWorkspaceBinding(next);
    try {
      this.#persist();
    } catch (error) {
      this.#repository.setWorkspaceBinding(binding);
      throw new Error(
        "Prep was written, but the session checkpoint failed. Retry Save; your draft was kept.",
        { cause: error },
      );
    }
    // A recovered older intent must not claim that later checkpointed edits are saved.
    const latest = renderUpdatedPrep(
      bytes,
      binding.prepSourceFile,
      this.#state,
    );
    if (
      parsePrep(latest, binding.prepSourceFile).savedContent &&
      !isDeepStrictEqual(parsePrep(latest, binding.prepSourceFile), next.prep)
    )
      return this.saveCurrentContent(value);
    return this.getSnapshot();
  }

  saveWorkspacePrep(
    basename: string,
    prep: InterviewPrep,
    expectedSourceBytes: string | null,
  ) {
    if (!this.#userWorkspaceRoot)
      throw new Error("User workspace is unavailable.");
    return savePrep(
      this.#userWorkspaceRoot,
      basename,
      prep,
      expectedSourceBytes,
    );
  }

  #recoverFinalization(): void {
    if (!this.#userWorkspaceRoot) return;
    const finalization = this.#state.lifecycle.finalization;
    if (finalization.state === "complete") {
      this.#repository?.clear?.();
      return;
    }
    this.#maybeFinalize();
  }

  #maybeFinalize(): void {
    if (
      !this.#userWorkspaceRoot ||
      !this.#repository ||
      this.#state.capture.mode !== "recall"
    ) {
      return;
    }
    const currentFinalization = this.#state.lifecycle.finalization;
    if (currentFinalization.state === "complete") {
      this.#repository.clear?.();
      return;
    }
    const milestones = this.#state.lifecycle.providerMilestones;
    if (Object.values(milestones).every((value) => value === null)) {
      return;
    }
    const missing = missingRequiredProviderMilestones(milestones);
    if (missing.length > 0) {
      const waiting = { state: "waiting_for_provider" as const, missing };
      if (!isDeepStrictEqual(currentFinalization, waiting)) {
        this.#dispatch({
          type: "lifecycle.set",
          lifecycle: { ...this.#state.lifecycle, finalization: waiting },
        });
      }
      return;
    }

    // An editable page must acknowledge its durable draft flush before export,
    // including after restart. Provider completion alone cannot clear this barrier.
    if (this.#state.contentFlushRequired) return;

    const attemptedAt = this.#clock.now().toISOString();
    const binding = this.#repository.getWorkspaceBinding?.();
    if (!binding || binding.workspaceRoot !== this.#userWorkspaceRoot)
      throw new Error(
        "The active interview's originating workspace is unavailable.",
      );
    const suffix = this.#state.sessionId.replaceAll("-", "").slice(-12);
    const prepName =
      binding.prepSourceFile
        .replace(/\.json$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48)
        .replace(/-$/g, "") || "interview";
    const stamp = new Date(this.#state.startedAt)
      .toISOString()
      .replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*$/,
        "$1-$2-$3-$4$5$6Z",
      );
    const directory = `finished-conversations/${stamp}-${prepName}-${suffix}`;
    const startedAt =
      currentFinalization.state === "finalizing"
        ? currentFinalization.startedAt
        : currentFinalization.state === "needs_attention"
          ? currentFinalization.startedAt
          : attemptedAt;
    const completedAt =
      currentFinalization.state === "finalizing" ||
      currentFinalization.state === "needs_attention"
        ? currentFinalization.completedAt
        : attemptedAt;
    const completedStamp = new Date(completedAt)
      .toISOString()
      .replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*$/,
        "$1-$2-$3-$4$5$6Z",
      );
    const directoryName = path.basename(directory);
    const archiveFileName = `${completedStamp}-${prepName}-${suffix}.json`;
    this.#repository.setWorkspaceBinding?.({
      ...binding,
      finalization: { completedAt, directoryName, archiveFileName },
    });
    const finalizing = {
      state: "finalizing" as const,
      startedAt,
      completedAt,
      directory,
    };
    if (!isDeepStrictEqual(currentFinalization, finalizing)) {
      this.#dispatch({
        type: "lifecycle.set",
        lifecycle: { ...this.#state.lifecycle, finalization: finalizing },
      });
    }

    try {
      const result = publishFinishedConversation({
        root: binding.workspaceRoot,
        state: this.getSnapshot(),
        prepSourceFile: binding.prepSourceFile,
        prepSourceBytes: binding.prepSourceBytes,
        completedAt,
      });
      this.#workspaceWarning = result.warning;
      this.#dispatch({
        type: "lifecycle.set",
        lifecycle: {
          ...this.#state.lifecycle,
          finalization: {
            state: "complete",
            startedAt,
            completedAt,
            directory: path.relative(binding.workspaceRoot, result.directory),
          },
        },
      });
    } catch (error) {
      const failure = {
        state: "needs_attention" as const,
        startedAt,
        completedAt,
        attemptedAt,
        directory,
        error:
          "Convo Caddy could not finish saving this interview. Restart the app to retry safely.",
      };
      try {
        this.#dispatch({
          type: "lifecycle.set",
          lifecycle: { ...this.#state.lifecycle, finalization: failure },
        });
      } catch (persistenceError) {
        throw new AggregateError(
          [error, persistenceError],
          "Session finalization failed and its recovery state could not be saved.",
        );
      }
      throw error;
    }
    this.#repository.clear?.();
  }

  #scheduleRecordingNoticeClear(): void {
    if (
      this.#closed ||
      this.#readOnlyRecallReconciliation ||
      !this.#recordingNoticeMutationEnabled ||
      this.#reconciledActiveNotice
    ) {
      this.#clearRecordingNoticeTimer();
      return;
    }
    const capture = this.#state.capture;
    if (
      capture.mode !== "recall" ||
      capture.notice.state !== "displaying" ||
      capture.provider.botId === null ||
      !this.#captureProvider
    ) {
      this.#clearRecordingNoticeTimer();
      return;
    }
    if (
      this.#noticeTimer !== undefined &&
      this.#noticeTimerBotId === capture.provider.botId
    ) {
      return;
    }

    this.#clearRecordingNoticeTimer();
    const elapsedMs = Math.max(
      0,
      this.#clock.now().getTime() - Date.parse(capture.notice.displayedAt),
    );
    const delayMs = Math.max(0, capture.notice.displayDurationMs - elapsedMs);
    const botId = capture.provider.botId;
    this.#noticeTimerBotId = botId;
    this.#noticeTimer = this.#noticeTimers.setTimeout(() => {
      this.#noticeTimer = undefined;
      this.#noticeTimerBotId = null;
      void this.#stopRecordingNotice(botId);
    }, delayMs);
  }

  #clearRecordingNoticeTimer(): void {
    if (this.#noticeTimer !== undefined) {
      this.#noticeTimers.clearTimeout(this.#noticeTimer);
      this.#noticeTimer = undefined;
    }
    this.#noticeTimerBotId = null;
  }

  async #stopRecordingNotice(botId: string): Promise<void> {
    const provider = this.#captureProvider;
    if (
      !provider ||
      !this.#recordingNoticeMutationEnabled ||
      this.#reconciledActiveNotice
    ) {
      return;
    }

    let error: string | null = null;
    try {
      await provider.stopRecordingNotice(botId);
    } catch {
      error =
        "The ten-second recording notice could not be cleared. Remove the bot and end the call.";
    }

    if (this.#closed) {
      return;
    }

    const previousState = this.#state;
    const capture = this.#state.capture;
    if (
      capture.mode !== "recall" ||
      capture.provider.botId !== botId ||
      capture.notice.state !== "displaying"
    ) {
      return;
    }
    const notice =
      error === null
        ? {
            ...capture.notice,
            state: "cleared" as const,
            clearedAt: this.#clock.now().toISOString(),
          }
        : {
            ...capture.notice,
            state: "failed" as const,
            error,
          };
    try {
      this.#dispatch({
        type: "capture.set",
        capture: { ...capture, notice },
      });
    } catch {
      const reconciliationError =
        error === null
          ? "The recording notice cleared remotely, but that result could not be saved. Restart recovery will reconcile it again."
          : "The recording notice could not be cleared, and that failure could not be saved. Remove the bot and end the call.";
      this.#state = reduceSession(previousState, {
        type: "capture.set",
        capture: {
          ...capture,
          notice,
          error: reconciliationError,
        },
      });
      this.#publish();
    }
  }

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#generation += 1;
    this.#clearRecordingNoticeTimer();
    this.#simulator.close();
    this.#listeners.clear();
  }

  submitInput(submission: InputSubmission): Promise<InputResult> {
    const finalization = this.#state.lifecycle.finalization;
    if (
      finalization.state === "complete" ||
      finalization.state === "finalizing" ||
      finalization.state === "needs_attention"
    ) {
      return Promise.resolve(this.#immutableMutation(submission.mutationId));
    }
    const existing = this.#mutations.get(submission.mutationId);
    if (existing) {
      return existing.input === submission.input
        ? existing.result
        : Promise.resolve(this.#mutationConflict(submission.mutationId));
    }

    const receipt = this.#receipts.get(submission.mutationId);
    if (receipt) {
      if (!receipt.input) {
        this.#receipts.delete(submission.mutationId);
        this.#persist();
      } else if (receipt.input !== submission.input) {
        return Promise.resolve(this.#mutationConflict(submission.mutationId));
      } else {
        const { input: _input, ...receiptResult } = receipt;
        const replay = Promise.resolve({
          ...receiptResult,
          state: this.getSnapshot(),
        });
        this.#mutations.set(submission.mutationId, {
          input: submission.input,
          result: replay,
        });
        return replay;
      }
    }

    this.#pendingInputs++;
    const execution = this.#executeAndPersistInput(submission).finally(() => {
      this.#pendingInputs--;
    });
    this.#mutations.set(submission.mutationId, {
      input: submission.input,
      result: execution,
    });
    return execution;
  }

  #isImmutable(): boolean {
    const state = this.#state.lifecycle.finalization.state;
    return (
      state === "complete" ||
      state === "finalizing" ||
      state === "needs_attention"
    );
  }

  setTopicChecked(topicId: string, checked: boolean): boolean {
    if (this.#isImmutable()) {
      return false;
    }
    if (!this.#state.topics.some((topic) => topic.id === topicId)) {
      return false;
    }

    this.#dispatch({ type: "topic.setChecked", topicId, checked });
    return true;
  }

  setRevisitChecked(itemId: string, checked: boolean): boolean {
    if (this.#isImmutable()) {
      return false;
    }
    if (!this.#state.revisit.some((item) => item.id === itemId)) {
      return false;
    }

    this.#dispatch({ type: "revisit.setChecked", itemId, checked });
    return true;
  }

  setQuestionChecked(itemId: string, checked: boolean): boolean {
    if (this.#isImmutable()) {
      return false;
    }
    if (!this.#state.questions.some((item) => item.id === itemId)) {
      return false;
    }

    this.#dispatch({ type: "question.setChecked", itemId, checked });
    return true;
  }

  controlSimulation(action: SimulationAction, speed?: number): SessionState {
    if (this.#state.capture.mode !== "simulation") {
      throw new Error(
        "Simulation controls are unavailable during live capture.",
      );
    }
    if (speed !== undefined) {
      this.#simulator.setSpeed(speed);
    }

    if (action === "reset") {
      const { sessionId, startedAt } = this.#state;
      this.#generation += 1;
      this.#mutations.clear();
      this.#suppressSimulatorState = true;
      this.#simulator.reset();
      this.#suppressSimulatorState = false;
      this.#state = this.#createInitialState(
        sessionId,
        startedAt,
        this.#simulator.snapshot().speed,
      );
      this.#receipts.clear();
      this.#persist();
      this.#publish();
      return this.getSnapshot();
    }

    this.#simulator[action]();
    return this.getSnapshot();
  }

  failNextFakeProvider(message?: string): boolean {
    if (!(this.#provider instanceof FakeMartyProvider)) {
      return false;
    }

    this.#provider.failNext(message);
    return true;
  }

  async #executeInput(submission: InputSubmission): Promise<InputResult> {
    const generation = this.#generation;
    const parsed = parseInput(submission.input);
    if (parsed.kind === "invalid") {
      return {
        ok: false,
        mutationId: submission.mutationId,
        kind: "invalid_input",
        error: parsed.message,
        state: this.getSnapshot(),
      };
    }

    const reference = this.#createCurrentReference();

    if (parsed.kind === "note") {
      this.#dispatch(
        {
          type: "note.add",
          note: this.#createNote(parsed.text, reference),
        },
        false,
      );
    } else if (parsed.kind === "question" || parsed.kind === "revisit") {
      try {
        const context = this.#createMartyContext();
        const request = { idempotencyKey: submission.mutationId };
        const response =
          parsed.kind === "question"
            ? await this.#provider.requestQuestion(
                parsed.text,
                context,
                request,
              )
            : await this.#provider.requestRevisit(
                context,
                request,
                parsed.hint,
              );
        const validated = this.#validateMartyResponse(
          response,
          context.transcript,
        );
        if (generation !== this.#generation || this.#isImmutable()) {
          return this.#staleMutation(submission.mutationId);
        }
        this.#dispatch(
          {
            type: parsed.kind === "question" ? "question.add" : "revisit.add",
            item: this.#createCheckable(
              validated.text,
              this.#referenceForCitations(reference, validated.citationTurnIds),
            ),
          },
          false,
        );
      } catch (error) {
        return this.#providerFailure(submission.mutationId, error);
      }
    } else {
      try {
        const context = this.#createMartyContext();
        const response = await this.#provider.ask(parsed.text, context, {
          idempotencyKey: submission.mutationId,
        });
        const validated = this.#validateMartyResponse(
          response,
          context.transcript,
        );
        if (generation !== this.#generation) {
          return this.#staleMutation(submission.mutationId);
        }
        this.#dispatch(
          {
            type: "chat.add",
            entry: this.#createChatEntry(parsed.text, validated, reference),
          },
          false,
        );
      } catch (error) {
        if (generation !== this.#generation) {
          return this.#staleMutation(submission.mutationId);
        }
        const message =
          error instanceof Error ? error.message : "Assistant request failed.";
        this.#dispatch(
          {
            type: "chat.add",
            entry: {
              id: this.#createId(),
              question: parsed.text,
              response: null,
              error: message,
              citationTurnIds: [],
              createdAt: reference.capturedAt,
              relativeMs: reference.relativeMs,
            },
          },
          false,
        );
        return this.#providerFailure(submission.mutationId, error);
      }
    }

    return {
      ok: true,
      mutationId: submission.mutationId,
      kind: "accepted",
      state: this.getSnapshot(),
    };
  }

  #providerFailure(mutationId: string, error: unknown): InputResult {
    return {
      ok: false,
      mutationId,
      kind: "provider_failure",
      error:
        error instanceof Error ? error.message : "Assistant request failed.",
      state: this.getSnapshot(),
    };
  }

  #captureStartFailure(
    kind: "invalid" | "conflict" | "provider_failure",
    error: string,
  ): StartRecallCaptureResult {
    return { ok: false, kind, error, state: this.getSnapshot() };
  }

  #isPristineForLiveCapture(): boolean {
    if (this.#state.capture.mode === "live_ready")
      return this.#state.transcript.length === 0;
    return (
      this.#state.transcript.length === 0 &&
      this.#state.revisit.length === 0 &&
      this.#state.questions.length === 0 &&
      this.#state.notes.length === 0 &&
      this.#state.chat.length === 0 &&
      this.#state.topics.every((topic) => !topic.checked) &&
      this.#state.simulation.status === "idle" &&
      this.#state.simulation.cursor === 0
    );
  }

  #immutableMutation(mutationId: string): InputResult {
    return {
      ok: false,
      mutationId,
      kind: "invalid_input",
      error: "This interview is finalizing or complete and cannot be changed.",
      state: this.getSnapshot(),
    };
  }

  #mutationConflict(mutationId: string): InputResult {
    return {
      ok: false,
      mutationId,
      kind: "invalid_input",
      error: "Mutation ID was already used for different input.",
      state: this.getSnapshot(),
    };
  }

  #staleMutation(mutationId: string): InputResult {
    const reason = this.#closed
      ? "Convo Caddy shut down before the assistant finished."
      : this.#isImmutable()
        ? "The interview finished before the assistant finished."
        : "Session reset before the assistant finished.";
    return {
      ok: false,
      mutationId,
      kind: "provider_failure",
      error: reason,
      state: this.getSnapshot(),
    };
  }

  async #executeAndPersistInput(
    submission: InputSubmission,
  ): Promise<InputResult> {
    const generation = this.#generation;
    const result = await this.#executeInput(submission);
    if (generation !== this.#generation) {
      return result;
    }
    if (this.#isImmutable()) {
      return this.#immutableMutation(submission.mutationId);
    }
    const receipt: MutationReceipt = {
      mutationId: result.mutationId,
      input: submission.input,
      ok: result.ok,
      kind: result.kind,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    this.#receipts.set(receipt.mutationId, receipt);
    this.#persist();
    return result;
  }

  #createInitialState(
    sessionId: string,
    startedAt: string,
    speed: number,
    captureMode: "simulation" | "live_ready" = "simulation",
  ): SessionState {
    return {
      sessionId,
      startedAt,
      elapsedMs: 0,
      topics: this.#topicTemplate.map((topic) => ({
        ...topic,
        checked: false,
      })),
      revisit: [],
      questions: [],
      notes: [],
      transcript: [],
      chat: [],
      capture:
        captureMode === "live_ready"
          ? {
              mode: "live_ready",
              meetingPlatform: "microsoft_teams_personal",
              recording: { location: null, retention: null },
            }
          : {
              mode: "simulation",
              authorization: {
                method: "not_required_synthetic",
                state: "not_required",
                admittedAt: null,
              },
              recording: { location: null, retention: null },
            },
      lifecycle: createInitialSessionLifecycle(captureMode),
      simulation: { status: "idle", cursor: 0, speed },
    };
  }

  #createCurrentReference(): TranscriptRef {
    const now = this.#clock.now();
    const relativeMs =
      this.#state.capture.mode === "recall"
        ? Math.max(
            this.#state.elapsedMs,
            now.getTime() - new Date(this.#state.startedAt).getTime(),
          )
        : this.#simulator.currentRelativeMs();
    return createTranscriptRef(
      this.#state.transcript,
      relativeMs,
      now.toISOString(),
    );
  }

  #referenceForCitations(
    receiptReference: TranscriptRef,
    citationTurnIds: string[],
  ): TranscriptRef {
    if (citationTurnIds.length === 0) {
      return receiptReference;
    }

    return {
      ...receiptReference,
      anchorTurnId: citationTurnIds.at(-1) ?? null,
      windowTurnIds: [...citationTurnIds],
    };
  }

  #createCheckable(text: string, reference: TranscriptRef): CheckableItem {
    return {
      id: this.#createId(),
      text,
      checked: false,
      createdAt: reference.capturedAt,
      relativeMs: reference.relativeMs,
      transcriptRef: reference,
    };
  }

  #createNote(text: string, reference: TranscriptRef): NoteItem {
    const { checked: _checked, ...note } = this.#createCheckable(
      text,
      reference,
    );
    return note;
  }

  #createChatEntry(
    question: string,
    response: MartyResponse,
    reference: TranscriptRef,
  ): ChatEntry {
    return {
      id: this.#createId(),
      question,
      response: response.text,
      error: null,
      citationTurnIds: response.citationTurnIds,
      createdAt: reference.capturedAt,
      relativeMs: reference.relativeMs,
    };
  }

  #createMartyContext(): MartyContext {
    return buildMartyContext(this.getSnapshot());
  }

  #validateMartyResponse(
    response: MartyResponse,
    transcript: MartyContext["transcript"],
  ): MartyResponse {
    return parseMartyResponse(
      response,
      transcript.map((turn) => turn.id),
    );
  }

  #appendTranscriptTurn(turn: TranscriptTurn): boolean {
    const matchingTurn = this.#state.transcript.find(
      (existing) => existing.id === turn.id,
    );
    const matchingProviderEvent =
      turn.providerEventId === undefined
        ? undefined
        : this.#state.transcript.find(
            (existing) => existing.providerEventId === turn.providerEventId,
          );
    const existing = matchingTurn ?? matchingProviderEvent;
    if (existing) {
      if (isDeepStrictEqual(existing, turn)) {
        return false;
      }
      throw new Error("Transcript IDs must not identify different turns.");
    }

    this.#state = reduceSession(this.#state, {
      type: "transcript.append",
      turn,
    });
    this.#state = reduceSession(this.#state, {
      type: "elapsed.set",
      elapsedMs: Math.max(this.#state.elapsedMs, turn.endedAtMs),
    });
    return true;
  }

  #setSimulationState(simulation: SessionState["simulation"]): void {
    this.#state = reduceSession(this.#state, {
      type: "elapsed.set",
      elapsedMs: Math.floor(this.#simulator.currentRelativeMs()),
    });
    this.#dispatch({ type: "simulation.set", simulation });
  }

  #validatePersistedSession(transcriptFixture: TranscriptTurn[]): void {
    const expectedTopics = this.#topicTemplate;
    const persistedTopics = this.#state.topics.map((topic) => ({
      ...topic,
      checked: false,
    }));
    if (
      !this.#state.contentEdited &&
      !isDeepStrictEqual(persistedTopics, expectedTopics)
    ) {
      throw new Error(
        "Persisted topics do not match the active interview plan.",
      );
    }

    if (this.#state.capture.mode === "recall") {
      return;
    }

    const expectedTurns = transcriptFixture.slice(
      0,
      this.#state.simulation.cursor,
    );
    if (!isDeepStrictEqual(this.#state.transcript, expectedTurns)) {
      throw new Error(
        "Persisted transcript does not match the active fixture.",
      );
    }
  }

  #dispatch(action: SessionAction, persist = true): void {
    this.#state = reduceSession(this.#state, action);
    if (persist) {
      this.#persist();
    }
    this.#publish();
  }

  #persist(): void {
    this.#repository?.save(this.#state, [...this.#receipts.values()]);
  }

  #publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}

export type DevelopmentSessionServiceOptions = {
  provider?: MartyProvider;
  captureProvider?: CaptureProvider;
  repository: SessionRepository;
};

export type LiveSessionServiceOptions = {
  provider?: MartyProvider;
  captureProvider?: CaptureProvider;
  repository: SessionRepository;
  createId?: () => string;
  now?: () => Date;
  userWorkspaceRoot?: string;
  recallCaptureAvailable?: boolean;
};

export function createLiveSessionService(
  options: LiveSessionServiceOptions,
): SessionService {
  return new SessionService({
    topics: templateTopics(),
    transcript: [],
    provider: options.provider ?? new UnavailableMartyProvider(),
    captureProvider: options.captureProvider,
    repository: options.repository,
    userWorkspaceRoot: options.userWorkspaceRoot,
    recallCaptureAvailable: options.recallCaptureAvailable,
    createId: options.createId,
    clock: options.now ? { now: options.now } : undefined,
    initialCaptureMode: "live_ready",
  });
}

function topicsFromPrep(prep: InterviewPrep): PreparedTopic[] {
  if (prep.savedContent) return structuredClone(prep.savedContent.topics);
  return prep.topics.map((topic, index) => ({
    id: `prep-${index + 1}`,
    tier: topic.tier,
    text: topic.text,
    checked: false,
  }));
}

export function createDevelopmentSessionService(
  options: DevelopmentSessionServiceOptions,
): SessionService {
  const transcriptPath = new URL(
    "../../fixtures/simulated-interview.jsonl",
    import.meta.url,
  );
  const transcript = transcriptFixtureSchema.parse(
    readFileSync(transcriptPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );

  return new SessionService({
    topics: templateTopics(),
    transcript,
    provider: options.provider ?? new UnavailableMartyProvider(),
    captureProvider: options.captureProvider,
    repository: options.repository,
  });
}

function contextFromPrep(
  prep: InterviewPrep,
): NonNullable<SessionState["humanContext"]> {
  if (prep.savedContent) return structuredClone(prep.savedContent.humanContext);
  return {
    title: prep.title,
    plannedDurationMinutes: prep.plannedDurationMinutes,
    personSummary: (prep.personSummary ?? []).map((text, index) => ({
      id: `summary-${index + 1}`,
      text,
    })),
  };
}
