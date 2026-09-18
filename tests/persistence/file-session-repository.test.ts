import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionState } from "../helpers/session-state.js";
import {
  FileSessionRepository,
  parsePersistedSession,
} from "../../src/server/persistence/file-session-repository.js";

describe("one private active-session checkpoint", () => {
  it("round-trips a normalized parsed prep with its exact source bytes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "active-session-"));
    const repository = new FileSessionRepository(root);
    repository.setWorkspaceBinding({
      workspaceRoot: "/tmp/workspace",
      prepSourceFile: "case.json",
      prepSourceBytes:
        '{ "schemaVersion": 1, "title": " Case ", "plannedDurationMinutes": 30, "topics": [{ "tier": "must", "text": " Tell me. " }] }\n',
      prep: {
        schemaVersion: 1,
        title: "Case",
        plannedDurationMinutes: 30,
        topics: [{ tier: "must", text: "Tell me." }],
      },
    });
    const state = createSessionState({
      sessionId: "11111111-2222-4333-8444-555555555555",
      startedAt: "2026-09-04T12:00:00.000Z",
    });
    repository.save(state, []);
    expect(new FileSessionRepository(root).load()).toEqual({
      state,
      mutations: [],
      workspace: repository.getWorkspaceBinding(),
    });
  });
  it("blocks replacement when active state is corrupt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "active-session-"));
    writeFileSync(path.join(root, "active-session.json"), "{");
    expect(() => new FileSessionRepository(root).load()).toThrow(
      "Active session data is corrupted.",
    );
  });

  it("rejects structurally valid state with dangling references", () => {
    const state = createSessionState({
      sessionId: "11111111-2222-4333-8444-555555555555",
      startedAt: "2026-09-04T12:00:00.000Z",
    });
    state.notes.push({
      id: "dangling-note",
      text: "Missing source turn",
      createdAt: "2026-09-04T12:00:01.000Z",
      relativeMs: 1_000,
      transcriptRef: {
        anchorTurnId: "missing-turn",
        windowTurnIds: ["missing-turn"],
        capturedAt: "2026-09-04T12:00:01.000Z",
        relativeMs: 1_000,
      },
    });

    expect(() =>
      parsePersistedSession(
        `${JSON.stringify({
          schemaVersion: 1,
          state,
          mutations: [],
          workspace: null,
        })}\n`,
      ),
    ).toThrow("references missing transcript turn");
  });
  it("clears only the active checkpoint", () => {
    const root = mkdtempSync(path.join(tmpdir(), "active-session-"));
    const repository = new FileSessionRepository(root);
    repository.save(
      createSessionState({
        sessionId: "11111111-2222-4333-8444-555555555555",
        startedAt: "2026-09-04T12:00:00.000Z",
      }),
      [],
    );
    repository.clear();
    expect(existsSync(path.join(root, "active-session.json"))).toBe(false);
  });
});
