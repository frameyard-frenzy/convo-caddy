import type {
  MeetingPlatform,
  RecallCaptureStatus,
  RecallRegion,
} from "../../domain/types.js";
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
      !url.username &&
      !url.password &&
      url.hostname === "teams.live.com" &&
      /^\/meet\/[0-9]+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isGoogleMeetMeetingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname === "meet.google.com" &&
      /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isMeetingUrlForPlatform(
  platform: MeetingPlatform,
  value: string,
): boolean {
  return platform === "google_meet"
    ? isGoogleMeetMeetingUrl(value)
    : isPersonalTeamsMeetingUrl(value);
}
