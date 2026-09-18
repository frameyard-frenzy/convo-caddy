import type { RecallCaptureStatus, RecallRegion } from "../../domain/types.js";
import type { RecallLifecycleMilestone } from "../../domain/session-lifecycle.js";

export type CreateCaptureBotInput = {
  meetingUrl: string;
  operationId: string;
};

export type RetrieveCaptureBotInput = {
  botId: string;
  operationId: string;
};

export type CaptureBotObservation = {
  botId: string;
  operationId: string;
  recordingId: string | null;
  milestone: RecallLifecycleMilestone | null;
  status: RecallCaptureStatus;
  occurredAt: string;
  error?: string;
};

export type RetrieveCaptureBotResult = {
  botId: string;
  operationId: string;
  observations: CaptureBotObservation[];
};

export interface CaptureProvider {
  readonly region: RecallRegion;
  createBot(input: CreateCaptureBotInput): Promise<{ botId: string }>;
  retrieveBot?(
    input: RetrieveCaptureBotInput,
  ): Promise<RetrieveCaptureBotResult>;
  stopRecordingNotice(botId: string): Promise<void>;
}

export function isPersonalTeamsMeetingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "teams.live.com" &&
      /^\/meet\/[0-9]+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
