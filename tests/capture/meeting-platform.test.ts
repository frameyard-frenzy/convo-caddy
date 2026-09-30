import { describe, expect, it } from "vitest";
import {
  isMeetingUrlForPlatform,
  isGoogleMeetMeetingUrl,
  isPersonalTeamsMeetingUrl,
} from "../../src/server/capture/capture-provider.js";

describe("meeting platform URLs", () => {
  it("accepts the bounded personal Teams forms", () => {
    expect(
      isPersonalTeamsMeetingUrl("https://teams.live.com/meet/123456789"),
    ).toBe(true);
    expect(
      isPersonalTeamsMeetingUrl(
        "https://teams.live.com/meet/123456789/?p=fixture",
      ),
    ).toBe(true);
  });

  it("accepts ordinary Google Meet links", () => {
    expect(isGoogleMeetMeetingUrl("https://meet.google.com/abc-defg-hij")).toBe(
      true,
    );
    expect(
      isGoogleMeetMeetingUrl("https://meet.google.com/abc-defg-hij?authuser=0"),
    ).toBe(true);
  });

  it.each([
    "http://meet.google.com/abc-defg-hij",
    "https://user:secret@meet.google.com/abc-defg-hij",
    "https://meet.google.com.evil.test/abc-defg-hij",
    "https://meet.google.com/abc-defg-hij/extra",
    "https://meet.google.com/abcdefghijk",
    "https://meet.google.com/lookup/team-nickname",
  ])("rejects an unsafe or unsupported Meet URL: %s", (meetingUrl) => {
    expect(isGoogleMeetMeetingUrl(meetingUrl)).toBe(false);
  });

  it("rejects platform and link mismatches", () => {
    expect(
      isMeetingUrlForPlatform(
        "google_meet",
        "https://teams.live.com/meet/123456789",
      ),
    ).toBe(false);
    expect(
      isMeetingUrlForPlatform(
        "microsoft_teams_personal",
        "https://meet.google.com/abc-defg-hij",
      ),
    ).toBe(false);
  });
});
