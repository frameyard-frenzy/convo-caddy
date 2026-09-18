import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CaptureProvider,
  CreateCaptureBotInput,
} from "../../src/server/capture/capture-provider.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import type {
  MutationReceipt,
  PersistedSession,
  SessionRepository,
} from "../../src/server/persistence/file-session-repository.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { createLiveSessionService } from "../../src/server/session-service.js";
import { initializeUserWorkspace } from "../../src/server/workspace/user-workspace.js";

describe("production live session factory", () => {
  it("starts live-ready with no synthetic transcript and persists immediately", () => {
    const repository = new MemorySessionRepository();
    const service = createLiveSessionService({
      provider: new FakeMartyProvider(),
      repository,
      createId: () => "live-session",
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });

    expect(service.getSnapshot()).toMatchObject({
      sessionId: "live-session",
      startedAt: "2026-08-25T12:00:00.000Z",
      transcript: [],
      capture: { mode: "live_ready" },
      simulation: { status: "idle", cursor: 0 },
    });
    expect(repository.save).toHaveBeenCalledOnce();
    expect(() => service.controlSimulation("step")).toThrow(
      "Simulation controls are unavailable",
    );
  });

  it("restarts an unfinished live session with its workspace prep", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "convo-caddy-live-workspace-"),
    );
    const privateRoot = mkdtempSync(
      path.join(tmpdir(), "convo-caddy-live-private-"),
    );
    initializeUserWorkspace(root);
    writeFileSync(
      path.join(root, "prep/current/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        title: "Custom",
        plannedDurationMinutes: 25,
        topics: [{ tier: "must", text: "Custom workspace question?" }],
      }),
    );
    const repository = new FileSessionRepository(privateRoot);
    const first = createLiveSessionService({
      repository,
      userWorkspaceRoot: root,
    });
    first.selectPrep("custom.json");

    const restarted = createLiveSessionService({
      repository: new FileSessionRepository(privateRoot),
      userWorkspaceRoot: root,
    });

    expect(restarted.getSnapshot().topics).toEqual([
      {
        id: "prep-1",
        tier: "must",
        text: "Custom workspace question?",
        checked: false,
      },
    ]);
  });

  it("snapshots the latest selected prep bytes when live capture starts", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "convo-caddy-live-workspace-"),
    );
    const privateRoot = mkdtempSync(
      path.join(tmpdir(), "convo-caddy-live-private-"),
    );
    initializeUserWorkspace(root);
    const prepFile = path.join(root, "prep/current/custom.json");
    writeFileSync(
      prepFile,
      JSON.stringify({
        schemaVersion: 1,
        title: "Before",
        plannedDurationMinutes: 25,
        topics: [{ tier: "must", text: "Before question?" }],
      }),
    );
    const repository = new FileSessionRepository(privateRoot);
    const service = createLiveSessionService({
      repository,
      userWorkspaceRoot: root,
      captureProvider: new LiveCaptureProvider(),
    });
    service.selectPrep("custom.json");
    const latestBytes = JSON.stringify({
      schemaVersion: 1,
      title: "After",
      plannedDurationMinutes: 30,
      topics: [{ tier: "more", text: "Latest question?" }],
    });
    writeFileSync(prepFile, latestBytes);

    const result = await service.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789?p=fixture",
    });

    expect(result.ok).toBe(true);
    expect(service.getSnapshot().topics[0]).toMatchObject({
      tier: "more",
      text: "Latest question?",
    });
    expect(repository.getWorkspaceBinding()).toMatchObject({
      prepSourceBytes: latestBytes,
      prep: { title: "After" },
    });
  });
});

class LiveCaptureProvider implements CaptureProvider {
  readonly region = "us-west-2" as const;
  async createBot(_input: CreateCaptureBotInput): Promise<{ botId: string }> {
    return { botId: "bot-workspace-prep" };
  }
  async stopRecordingNotice(_botId: string): Promise<void> {}
}

class MemorySessionRepository implements SessionRepository {
  readonly dataRoot = "/private/live-session-test";
  readonly save = vi.fn(
    (_state: PersistedSession["state"], _mutations: MutationReceipt[]) =>
      undefined,
  );

  load(): PersistedSession | null {
    return null;
  }
}
