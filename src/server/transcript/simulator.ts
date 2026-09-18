import type { SimulationState, TranscriptTurn } from "../../domain/types.js";
import type {
  SimulationStateHandler,
  TranscriptSource,
  TranscriptTurnHandler,
} from "./transcript-source.js";

export type SimulatorTimers = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  now?(): number;
};

const systemTimers: SimulatorTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

export class TranscriptSimulator implements TranscriptSource {
  readonly #turns: TranscriptTurn[];
  readonly #onTurn: TranscriptTurnHandler;
  readonly #onState?: SimulationStateHandler;
  readonly #timers: SimulatorTimers;
  #state: SimulationState;
  #timer: unknown;
  #runStartedAtMs: number | null = null;
  #runStartedRelativeMs = 0;

  constructor(
    turns: TranscriptTurn[],
    onTurn: TranscriptTurnHandler,
    timers: SimulatorTimers = systemTimers,
    onState?: SimulationStateHandler,
    speed = 20,
  ) {
    this.#turns = [...turns];
    this.#onTurn = onTurn;
    this.#timers = timers;
    this.#onState = onState;
    this.#state = { status: "idle", cursor: 0, speed };
  }

  snapshot(): SimulationState {
    return { ...this.#state };
  }

  currentRelativeMs(): number {
    if (this.#state.status !== "running" || this.#runStartedAtMs === null) {
      return this.#runStartedRelativeMs;
    }

    const now = this.#timers.now?.() ?? performance.now();
    return (
      this.#runStartedRelativeMs +
      Math.max(0, now - this.#runStartedAtMs) * this.#state.speed
    );
  }

  start(): void {
    if (this.#state.status === "complete" || this.#state.status === "running") {
      return;
    }

    if (this.#state.status === "idle") {
      this.#runStartedRelativeMs = this.#lastEmittedRelativeMs();
    }
    this.#runStartedAtMs = this.#timers.now?.() ?? performance.now();
    this.#setState({ ...this.#state, status: "running" });
    this.#scheduleNext();
  }

  pause(): void {
    this.#runStartedRelativeMs = this.currentRelativeMs();
    this.#runStartedAtMs = null;
    this.#clearTimer();
    if (this.#state.status === "running") {
      this.#setState({ ...this.#state, status: "paused" });
    }
  }

  resume(): void {
    if (this.#state.status === "paused") {
      this.start();
    }
  }

  step(): void {
    this.#runStartedAtMs = null;
    this.#clearTimer();
    if (this.#state.status === "complete") {
      return;
    }

    this.#emitNext(false);
  }

  reset(): void {
    this.#clearTimer();
    this.#runStartedAtMs = null;
    this.#runStartedRelativeMs = 0;
    this.#setState({ status: "idle", cursor: 0, speed: this.#state.speed });
  }

  restore(
    state: SimulationState,
    relativeMs = this.#turns[state.cursor - 1]?.endedAtMs ?? 0,
  ): void {
    this.#clearTimer();
    if (state.cursor > this.#turns.length) {
      throw new Error("Simulation cursor exceeds the transcript fixture.");
    }
    if (state.status === "complete" && state.cursor !== this.#turns.length) {
      throw new Error(
        "A complete simulation must be at the end of the fixture.",
      );
    }
    if (state.status === "running" && state.cursor === this.#turns.length) {
      throw new Error(
        "A running simulation cannot be at the end of the fixture.",
      );
    }

    const lastEmittedRelativeMs = this.#turns[state.cursor - 1]?.endedAtMs ?? 0;
    const nextRelativeMs =
      this.#turns[state.cursor]?.endedAtMs ?? lastEmittedRelativeMs;
    if (
      relativeMs < lastEmittedRelativeMs ||
      relativeMs > nextRelativeMs ||
      (state.status === "idle" && relativeMs !== 0) ||
      (state.status === "complete" && relativeMs !== lastEmittedRelativeMs)
    ) {
      throw new Error("Simulation time is inconsistent with its cursor.");
    }

    this.#state = { ...state };
    this.#runStartedRelativeMs = relativeMs;
    this.#runStartedAtMs =
      state.status === "running"
        ? (this.#timers.now?.() ?? performance.now())
        : null;
    if (state.status === "running") {
      this.#scheduleNext();
    }
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new Error("Simulation speed must be greater than zero.");
    }

    const wasRunning = this.#state.status === "running";
    const currentRelativeMs = this.currentRelativeMs();
    this.#clearTimer();
    if (wasRunning) {
      this.#runStartedRelativeMs = currentRelativeMs;
      this.#runStartedAtMs = this.#timers.now?.() ?? performance.now();
    }
    this.#setState({ ...this.#state, speed });
    if (wasRunning) {
      this.#scheduleNext();
    }
  }

  close(): void {
    this.#clearTimer();
    this.#runStartedAtMs = null;
  }

  #scheduleNext(): void {
    const nextTurn = this.#turns[this.#state.cursor];
    if (!nextTurn) {
      this.#setState({ ...this.#state, status: "complete" });
      return;
    }

    const delay = Math.max(
      0,
      (nextTurn.endedAtMs - this.currentRelativeMs()) / this.#state.speed,
    );
    this.#timer = this.#timers.setTimeout(() => this.#emitNext(true), delay);
  }

  #emitNext(continueRunning: boolean): void {
    const turn = this.#turns[this.#state.cursor];
    if (!turn) {
      this.#setState({ ...this.#state, status: "complete" });
      return;
    }

    this.#timer = undefined;
    this.#onTurn(turn);
    const cursor = this.#state.cursor + 1;
    this.#runStartedRelativeMs = turn.endedAtMs;
    const status =
      cursor >= this.#turns.length
        ? "complete"
        : continueRunning
          ? "running"
          : "paused";
    if (status !== "running") {
      this.#runStartedAtMs = null;
    } else {
      this.#runStartedAtMs = this.#timers.now?.() ?? performance.now();
    }
    this.#setState({ ...this.#state, cursor, status });

    if (status === "running") {
      this.#scheduleNext();
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #setState(state: SimulationState): void {
    this.#state = state;
    this.#onState?.(this.snapshot());
  }

  #lastEmittedRelativeMs(): number {
    return this.#turns[this.#state.cursor - 1]?.endedAtMs ?? 0;
  }
}
