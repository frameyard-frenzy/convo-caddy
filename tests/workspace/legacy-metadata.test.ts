import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { createLiveSessionService } from "../../src/server/session-service.js";
import { parsePrep } from "../../src/server/workspace/prep-format.js";
import {
  initializeUserWorkspace,
  publishFinishedConversation,
  scanFinishedConversations,
} from "../../src/server/workspace/user-workspace.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it.each([
  [239, 45],
  [20, 481],
  [110000, 481],
])(
  "preserves legacy title length %i / duration %i through hydration, direct edits, checkpoint, restart and export",
  (length, duration) => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-legacy-boundary-"));
    roots.push(root);
    initializeUserWorkspace(root);
    const checkpoint = JSON.parse(
      readFileSync(
        "tests/fixtures/workspace/legacy-active-session.json",
        "utf8",
      ),
    );
    expect(checkpoint.state).not.toHaveProperty("humanContext");
    const title = "T".repeat(length);
    // JSON also historically accepts >200 topics and >4000-character questions.
    const bytes = JSON.stringify({
      schemaVersion: 1,
      title,
      plannedDurationMinutes: duration,
      topics: Array.from({ length: 201 }, (_, i) => ({
        tier: "must",
        text: i === 0 ? "Q".repeat(4001) : `Question ${i}`,
      })),
    });
    const prep = parsePrep(bytes, "legacy.json");
    checkpoint.workspace = {
      workspaceRoot: root,
      prep,
      prepSourceFile: "legacy.json",
      prepSourceBytes: bytes,
    };
    checkpoint.state.topics = prep.topics.map((topic, i) => ({
      ...topic,
      id: `prep-${i + 1}`,
      checked: i === 0,
    }));
    writeFileSync(path.join(root, "prep/current/legacy.json"), bytes);
    const repository = new FileSessionRepository(root);
    writeFileSync(
      path.join(root, "active-session.json"),
      JSON.stringify(checkpoint),
    );
    const service = createLiveSessionService({
      repository,
      userWorkspaceRoot: root,
    });
    const edit = (section: string, text: string) =>
      service.editContent({
        sessionId: service.getSnapshot().sessionId,
        mutationId: crypto.randomUUID(),
        revision: service.getSnapshot().contentRevision ?? 0,
        section,
        text,
      });
    expect(service.getSnapshot().humanContext).toMatchObject({
      title,
      plannedDurationMinutes: duration,
    });
    edit("notes", "Ordinary direct note");
    expect(
      new FileSessionRepository(root).load()!.state.humanContext,
    ).toMatchObject({ title, plannedDurationMinutes: duration });
    // Full unchanged fields remain accepted, and the UI may omit them for bounded requests.
    if (length < 1000)
      edit(
        "metadata",
        JSON.stringify({
          title,
          plannedDurationMinutes: duration,
          displayName: "Named legacy interview",
        }),
      );
    edit("metadata", JSON.stringify({ displayName: "Changed name only" }));
    expect(() =>
      edit("metadata", JSON.stringify({ title: "X".repeat(201) })),
    ).toThrow(/200/);
    expect(() =>
      edit("metadata", JSON.stringify({ plannedDurationMinutes: 482 })),
    ).toThrow(/480/);
    const before = service.getSnapshot();
    service.close();
    const restarted = createLiveSessionService({
      repository: new FileSessionRepository(root),
      userWorkspaceRoot: root,
    });
    expect(restarted.getSnapshot()).toEqual(before);
    expect(before.topics).toEqual(checkpoint.state.topics);
    expect(before.humanContext).toMatchObject({
      title,
      plannedDurationMinutes: duration,
    });
    const published = publishFinishedConversation({
      root,
      state: before,
      prepSourceFile: "legacy.json",
      prepSourceBytes: bytes,
      completedAt: new Date().toISOString(),
    });
    const records = scanFinishedConversations(root);
    expect(records.errors).toEqual([]);
    expect(records.valid[0]!.conversation.session.humanContext).toEqual(
      before.humanContext,
    );
    expect(
      readFileSync(path.join(published.directory, "conversation.md"), "utf8"),
    ).toContain(title);
    expect(
      readFileSync(path.join(published.directory, "prep.json"), "utf8"),
    ).toBe(bytes);
    restarted.close();
  },
);
