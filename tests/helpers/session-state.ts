import type { CaptureState, SessionState } from "../../src/domain/types.js";
import { createInitialSessionLifecycle } from "../../src/domain/session-lifecycle.js";

export function createSessionState(options: {
  sessionId: string;
  startedAt: string;
  capture?: CaptureState;
}): SessionState {
  const capture =
    options.capture ??
    ({
      mode: "simulation",
      authorization: {
        method: "not_required_synthetic",
        state: "not_required",
        admittedAt: null,
      },
      recording: { location: null, retention: null },
    } satisfies CaptureState);
  return {
    sessionId: options.sessionId,
    startedAt: options.startedAt,
    elapsedMs: 0,
    topics: [
      {
        id: "case",
        tier: "must",
        text: "Select one case.",
        checked: false,
      },
    ],
    revisit: [],
    questions: [],
    notes: [],
    transcript: [],
    chat: [],
    capture,
    lifecycle: createInitialSessionLifecycle(capture.mode),
    simulation: { status: "idle", cursor: 0, speed: 20 },
  };
}
