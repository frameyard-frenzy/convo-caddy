import { describe, expect, it, vi } from "vitest";
import { createTranscriptRef } from "../../src/domain/transcript-reference.js";
import type { TranscriptTurn } from "../../src/domain/types.js";
import { TranscriptSimulator } from "../../src/server/transcript/simulator.js";

function turn(index: number, endedAtMs = index * 1_000): TranscriptTurn {
  return {
    id: `turn-${index}`,
    providerEventId: `fixture-${index}`,
    speakerId: index % 2 === 0 ? "mo" : "participant",
    speakerLabel: index % 2 === 0 ? "Moritz" : "Participant",
    text: `Synthetic turn ${index}`,
    startedAtMs: endedAtMs - 500,
    endedAtMs,
    receivedAt: new Date(Date.UTC(2026, 7, 18, 16, 0, index)).toISOString(),
    final: true,
  };
}

describe("createTranscriptRef", () => {
  it("anchors to the latest finalized turn at command receipt time", () => {
    const reference = createTranscriptRef(
      [turn(1), turn(2), turn(3)],
      2_500,
      "2026-08-18T16:00:02.500Z",
    );

    expect(reference).toEqual({
      anchorTurnId: "turn-2",
      windowTurnIds: ["turn-1", "turn-2"],
      capturedAt: "2026-08-18T16:00:02.500Z",
      relativeMs: 2_500,
    });
  });

  it("uses an explicit null anchor before the first finalized turn", () => {
    const reference = createTranscriptRef(
      [turn(1)],
      999,
      "2026-08-18T16:00:00.999Z",
    );

    expect(reference.anchorTurnId).toBeNull();
    expect(reference.windowTurnIds).toEqual([]);
  });

  it("includes the anchor and at most five preceding finalized turns", () => {
    const turns = Array.from({ length: 8 }, (_, index) => turn(index + 1));
    const reference = createTranscriptRef(
      turns,
      8_000,
      "2026-08-18T16:00:08.000Z",
    );

    expect(reference.windowTurnIds).toEqual([
      "turn-3",
      "turn-4",
      "turn-5",
      "turn-6",
      "turn-7",
      "turn-8",
    ]);
  });

  it("never captures a future turn retroactively", () => {
    const reference = createTranscriptRef(
      [turn(1), turn(2), turn(3)],
      1_500,
      "2026-08-18T16:00:01.500Z",
    );

    expect(reference.anchorTurnId).toBe("turn-1");
    expect(reference.windowTurnIds).not.toContain("turn-2");
    expect(reference.windowTurnIds).not.toContain("turn-3");
  });
});

describe("TranscriptSimulator", () => {
  it("replays stable fixture IDs from the beginning after reset", () => {
    const emitted: string[] = [];
    const simulator = new TranscriptSimulator(
      [turn(1), turn(2), turn(3)],
      (value) => emitted.push(value.id),
      { setTimeout: vi.fn(), clearTimeout: vi.fn() },
    );

    simulator.step();
    simulator.step();
    simulator.reset();
    simulator.step();

    expect(emitted).toEqual(["turn-1", "turn-2", "turn-1"]);
    expect(simulator.snapshot()).toEqual({
      status: "paused",
      cursor: 1,
      speed: 20,
    });
  });

  it("reports command receipt time between finalized transcript turns", () => {
    let nowMs = 0;
    const callbacks: Array<() => void> = [];
    const simulator = new TranscriptSimulator(
      [turn(1, 4_000), turn(2, 8_000)],
      vi.fn(),
      {
        setTimeout: (callback) => {
          callbacks.push(callback);
          return callback;
        },
        clearTimeout: vi.fn(),
        now: () => nowMs,
      },
      undefined,
      20,
    );

    simulator.start();
    nowMs = 100;
    expect(simulator.currentRelativeMs()).toBe(2_000);

    nowMs = 200;
    callbacks.shift()?.();
    nowMs = 250;
    expect(simulator.currentRelativeMs()).toBe(5_000);
  });

  it("resumes with only the remaining delay after a between-turn pause", () => {
    let nowMs = 0;
    const scheduledDelays: number[] = [];
    const simulator = new TranscriptSimulator(
      [turn(1, 4_000), turn(2, 8_000)],
      vi.fn(),
      {
        setTimeout: (_callback, delayMs) => {
          scheduledDelays.push(delayMs);
          return delayMs;
        },
        clearTimeout: vi.fn(),
        now: () => nowMs,
      },
      undefined,
      20,
    );

    simulator.start();
    expect(scheduledDelays.at(-1)).toBe(200);
    nowMs = 100;
    simulator.pause();
    simulator.resume();

    expect(scheduledDelays.at(-1)).toBe(100);
  });

  it("cancels its pending timer on close without rewriting session state", () => {
    const timerHandle = Symbol("simulation-timer");
    const clearTimeout = vi.fn();
    const simulator = new TranscriptSimulator([turn(1, 4_000)], vi.fn(), {
      setTimeout: () => timerHandle,
      clearTimeout,
      now: () => 0,
    });
    simulator.start();
    const running = simulator.snapshot();

    simulator.close();
    simulator.close();

    expect(clearTimeout).toHaveBeenCalledOnce();
    expect(clearTimeout).toHaveBeenCalledWith(timerHandle);
    expect(simulator.snapshot()).toEqual(running);
  });
});
