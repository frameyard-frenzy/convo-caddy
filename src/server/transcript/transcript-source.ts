import type { SimulationState, TranscriptTurn } from "../../domain/types.js";

export interface TranscriptSource {
  snapshot(): SimulationState;
  start(): void;
  pause(): void;
  resume(): void;
  step(): void;
  reset(): void;
  restore(state: SimulationState, relativeMs?: number): void;
  setSpeed(speed: number): void;
  close(): void;
}

export type TranscriptTurnHandler = (turn: TranscriptTurn) => void;
export type SimulationStateHandler = (state: SimulationState) => void;
