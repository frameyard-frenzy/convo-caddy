import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  parsePrep,
  renderPrepMarkdown,
} from "../../src/server/workspace/prep-format.js";
import {
  initializeUserWorkspace,
  publishFinishedConversation,
  scanFinishedConversations,
} from "../../src/server/workspace/user-workspace.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { createLiveSessionService } from "../../src/server/session-service.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import { buildMartyContext } from "../../src/server/marty/context-builder.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const bytes =
  "# Synthetic interview\nDuration: 20 minutes\n## Person summary\n- Leads a fictional team\n- Uses <paper>\n## Must\n- [ ] What happened?\n";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "caddy-edit-"));
  roots.push(root);
  initializeUserWorkspace(root);
  writeFileSync(path.join(root, "prep/current/example.md"), bytes);
  const repository = new FileSessionRepository(path.join(root, "private"));
  const provider = new FakeMartyProvider();
  const service = createLiveSessionService({
    repository,
    provider,
    userWorkspaceRoot: root,
  });
  return { root, repository, provider, service };
}
it("round trips person summary bullets and checkbox prep while reading old prep", () => {
  const prep = parsePrep(bytes, "example.md");
  expect(prep.personSummary).toEqual([
    "Leads a fictional team",
    "Uses <paper>",
  ]);
  expect(renderPrepMarkdown(prep)).toContain("- [ ] What happened?");
  expect(parsePrep(renderPrepMarkdown(prep), "example.md")).toEqual(prep);
  expect(
    parsePrep("# Old\n## Must\n- Why?", "old.md").personSummary,
  ).toBeUndefined();
});
it("edits and creates human content without inference, retaining identity, checks, source bytes, restart and export", () => {
  const { root, service, provider } = fixture();
  service.selectPrep("example.md");
  const edit = (value: object) =>
    service.editContent({
      sessionId: service.getSnapshot().sessionId,
      mutationId: crypto.randomUUID(),
      revision: service.getSnapshot().contentRevision ?? 0,
      ...value,
    });
  edit({ section: "notes", text: "- First observation\nSecond observation" });
  edit({ section: "questions", text: "[ ] Why now?\n- [x] Who helped?" });
  const item = service.getSnapshot().questions[0]!;
  service.setQuestionChecked(item.id, true);
  edit({ section: "questions", id: item.id, text: "Why that day?" });
  expect(service.getSnapshot().questions[0]).toEqual({
    ...item,
    checked: true,
    text: "Why that day?",
    humanEdited: true,
  });
  edit({
    section: "topics",
    id: service.getSnapshot().topics[0]!.id,
    text: "What changed?",
  });
  edit({
    section: "metadata",
    text: JSON.stringify({
      title: "Revised interview",
      plannedDurationMinutes: 35,
    }),
  });
  expect(service.getSnapshot().notes.map((n) => n.text)).toEqual([
    "First observation",
    "Second observation",
  ]);
  expect(provider.invocationCount).toBe(0);
  expect(readFileSync(path.join(root, "prep/current/example.md"), "utf8")).toBe(
    bytes,
  );
  expect(
    buildMartyContext(service.getSnapshot()).humanContext?.personSummary,
  ).toEqual(["Leads a fictional team", "Uses <paper>"]);
  const snapshot = service.getSnapshot();
  service.close();
  const restored = createLiveSessionService({
    repository: new FileSessionRepository(path.join(root, "private")),
    userWorkspaceRoot: root,
  });
  expect(restored.getSnapshot()).toEqual(snapshot);
  const published = publishFinishedConversation({
    root,
    state: snapshot,
    prepSourceFile: "example.md",
    prepSourceBytes: bytes,
    completedAt: new Date().toISOString(),
  });
  expect(
    readFileSync(path.join(published.directory, "conversation.md"), "utf8"),
  ).toContain("## Person summary");
  expect(
    scanFinishedConversations(root).valid[0]?.conversation.session,
  ).toMatchObject({ contentRevision: snapshot.contentRevision });
  restored.close();
});
it("rejects stale, empty and forged edits; failed durable writes retain prior state; retries are idempotent", () => {
  const { service, repository } = fixture();
  service.selectPrep("example.md");
  const input = {
    sessionId: service.getSnapshot().sessionId,
    mutationId: "edit-one",
    revision: 0,
    section: "notes",
    text: "Observation",
  };
  service.editContent(input);
  service.editContent(input);
  expect(service.getSnapshot().notes).toHaveLength(1);
  expect(() => service.editContent({ ...input, mutationId: "stale" })).toThrow(
    /changed/,
  );
  const before = service.getSnapshot();
  expect(() =>
    service.editContent({
      ...input,
      revision: 1,
      mutationId: "blank",
      text: "",
    }),
  ).toThrow();
  expect(() =>
    service.editContent({
      ...input,
      revision: 1,
      mutationId: "forged",
      section: "transcript",
    }),
  ).toThrow();
  const failure = vi.spyOn(repository, "save").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  expect(() =>
    service.editContent({
      ...input,
      revision: 1,
      mutationId: "retry",
      text: "Next",
    }),
  ).toThrow("disk full");
  expect(service.getSnapshot()).toEqual(before);
  failure.mockRestore();
  service.editContent({
    ...input,
    revision: 1,
    mutationId: "retry",
    text: "Next",
  });
  const item = service.getSnapshot().notes[0]!;
  service.editContent({
    ...input,
    revision: 2,
    mutationId: "remove",
    id: item.id,
    remove: true,
    text: "",
  });
  expect(service.getSnapshot().notes.map((n) => n.text)).toEqual(["Next"]);
  service.close();
});

it("keeps direct prep edits and checked state when capture starts", async () => {
  const { root, repository, service } = fixture();
  service.selectPrep("example.md");
  service.editContent({
    sessionId: service.getSnapshot().sessionId,
    revision: 0,
    mutationId: "edit-prep",
    section: "topics",
    id: "prep-1",
    text: "Human revision",
  });
  service.setTopicChecked("prep-1", true);
  service.close();
  const capture = createLiveSessionService({
    repository,
    userWorkspaceRoot: root,
    captureProvider: {
      region: "us-west-2",
      createBot: async () => ({ botId: "synthetic" }),
      stopRecordingNotice: async () => {},
    },
  });
  expect(
    await capture.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789",
    }),
  ).toMatchObject({ ok: true });
  expect(capture.getSnapshot().topics[0]).toMatchObject({
    id: "prep-1",
    text: "Human revision",
    checked: true,
  });
  expect(() => capture.beginWorkspaceMove()).toThrow(/Finish capture/);
  capture.close();
});

it("changing selected prep invalidates an older inline draft even within the same session", () => {
  const { root, service } = fixture();
  service.selectPrep("example.md");
  const draft = {
    sessionId: service.getSnapshot().sessionId,
    mutationId: "old-prep-draft",
    revision: service.getSnapshot().contentRevision ?? 0,
    section: "topics",
    id: "prep-1",
    text: "Old draft",
  };
  writeFileSync(
    path.join(root, "prep/current/second.md"),
    "# Second\n## Must\n- New question",
  );
  service.selectPrep("second.md");
  expect(() => service.editContent(draft)).toThrow(/changed/);
  expect(service.getSnapshot().topics[0]?.text).toBe("New question");
  service.close();
});

it("keeps the prep title independent of the shorter optional interview name", () => {
  const { service } = fixture();
  service.selectPrep("example.md");
  expect(() =>
    service.editContent({
      sessionId: service.getSnapshot().sessionId,
      revision: 0,
      mutationId: "long-title",
      section: "metadata",
      text: JSON.stringify({
        title: "A".repeat(150),
        plannedDurationMinutes: 40,
      }),
    }),
  ).not.toThrow();
  expect(service.getSnapshot().humanContext?.title).toHaveLength(150);
  service.close();
});

const fakeCapture = () => ({
  region: "us-west-2" as const,
  createBot: vi.fn(async () => ({ botId: "synthetic" })),
  stopRecordingNotice: async () => {},
});
const meeting = { meetingUrl: "https://teams.live.com/meet/123456789" };
it("hydrates actual pre-editing checkpoint metadata before display, direct edit, fake capture, restart and export", async () => {
  const { root, service } = fixture();
  service.close();
  const legacy = JSON.parse(
    readFileSync("tests/fixtures/workspace/legacy-active-session.json", "utf8"),
  );
  expect(legacy.state).not.toHaveProperty("humanContext");
  expect(legacy.state).not.toHaveProperty("contentRevision");
  legacy.workspace.workspaceRoot = root;
  writeFileSync(
    path.join(root, "private/active-session.json"),
    JSON.stringify(legacy),
  );
  // Disk prep has changed: legacy hydration must use the saved binding, not reread it.
  writeFileSync(
    path.join(root, "prep/current/legacy.md"),
    "# Changed outside\n## Must\n- Different?",
  );
  const capture = createLiveSessionService({
    repository: new FileSessionRepository(path.join(root, "private")),
    userWorkspaceRoot: root,
    captureProvider: fakeCapture(),
  });
  const metadata = {
    title: "Original interview title",
    plannedDurationMinutes: 45,
    personSummary: [],
  };
  expect(capture.getSnapshot().humanContext).toEqual(metadata);
  capture.editContent({
    sessionId: capture.getSnapshot().sessionId,
    revision: 0,
    mutationId: "legacy-note",
    section: "notes",
    text: "Human observation",
  });
  expect(await capture.startRecallCapture(meeting)).toMatchObject({ ok: true });
  expect(capture.getSnapshot().humanContext).toEqual(metadata);
  expect(capture.getSnapshot().topics).toEqual(legacy.state.topics);
  capture.close();
  const repository = new FileSessionRepository(path.join(root, "private"));
  const restarted = createLiveSessionService({
    repository,
    userWorkspaceRoot: root,
  });
  expect(restarted.getSnapshot().humanContext).toEqual(metadata);
  const binding = repository.getWorkspaceBinding()!;
  const published = publishFinishedConversation({
    root,
    state: restarted.getSnapshot(),
    prepSourceFile: binding.prepSourceFile,
    prepSourceBytes: binding.prepSourceBytes,
    completedAt: new Date().toISOString(),
  });
  expect(scanFinishedConversations(root).errors).toEqual([]);
  expect(
    scanFinishedConversations(root).valid[0]?.conversation.session.humanContext,
  ).toEqual(metadata);
  expect(
    readFileSync(path.join(published.directory, "conversation.md"), "utf8"),
  ).toContain("Original interview title");
  restarted.close();
});
it.each([
  "changed",
  "unchanged",
  "format-only",
  "provider-failure",
  "save-failure",
] as const)(
  "capture refresh %s keeps revisions, state and checkpoint coherent",
  async (scenario) => {
    const { root, repository, service } = fixture();
    service.selectPrep("example.md");
    service.setTopicChecked("prep-1", true);
    service.close();
    const provider = fakeCapture();
    if (scenario === "provider-failure")
      provider.createBot.mockRejectedValueOnce(
        new Error("synthetic provider failure"),
      );
    const capture = createLiveSessionService({
      repository,
      userWorkspaceRoot: root,
      captureProvider: provider,
    });
    const before = capture.getSnapshot();
    const oldBinding = repository.getWorkspaceBinding();
    const draft = {
      sessionId: before.sessionId,
      revision: before.contentRevision ?? 0,
      mutationId: "stale-refresh",
      section: "topics",
      id: "prep-1",
      text: "Old unsaved draft",
    };
    if (scenario === "format-only")
      writeFileSync(path.join(root, "prep/current/example.md"), `${bytes}\n`);
    else if (scenario !== "unchanged")
      writeFileSync(
        path.join(root, "prep/current/example.md"),
        "# Refreshed\nDuration: 50 minutes\n## Person summary\n- New summary\n## Must\n- New question?",
      );
    if (scenario === "save-failure")
      vi.spyOn(repository, "save").mockImplementationOnce(() => {
        throw new Error("synthetic disk full");
      });
    const result = await capture.startRecallCapture(meeting);
    if (scenario === "save-failure") {
      expect(result).toMatchObject({ ok: false });
      expect(provider.createBot).not.toHaveBeenCalled();
      expect(capture.getSnapshot()).toEqual(before);
      expect(repository.getWorkspaceBinding()).toEqual(oldBinding);
      expect(
        new FileSessionRepository(path.join(root, "private")).load()!.state,
      ).toEqual(before);
    } else if (scenario === "unchanged" || scenario === "format-only") {
      expect(result).toMatchObject({ ok: true });
      expect(capture.getSnapshot().contentRevision).toBe(
        before.contentRevision,
      );
      expect(capture.getSnapshot().topics).toEqual(before.topics);
      expect(() => capture.editContent(draft)).not.toThrow();
    } else {
      expect(result.ok).toBe(scenario === "changed");
      expect(capture.getSnapshot().contentRevision).toBe(
        (before.contentRevision ?? 0) + 1,
      );
      expect(() => capture.editContent(draft)).toThrow(
        /changed.*Keep your draft/,
      );
      expect(capture.getSnapshot().topics[0]?.text).toBe("New question?");
      expect(
        new FileSessionRepository(path.join(root, "private")).load()!.state,
      ).toEqual(capture.getSnapshot());
    }
    const expected = capture.getSnapshot();
    capture.close();
    const restarted = createLiveSessionService({
      repository: new FileSessionRepository(path.join(root, "private")),
      userWorkspaceRoot: root,
    });
    expect(restarted.getSnapshot()).toEqual(expected);
    restarted.close();
  },
);

it("holds automatic provider export durably until the editor flush is acknowledged", async () => {
  const { root, repository, service } = fixture();
  service.selectPrep("example.md");
  service.close();
  const capture = createLiveSessionService({
    repository,
    userWorkspaceRoot: root,
    captureProvider: fakeCapture(),
  });
  capture.openContentEditing();
  await capture.startRecallCapture(meeting);
  for (const milestone of [
    "call_ended",
    "transcript_done",
    "bot_done",
  ] as const)
    capture.ingestRecallLifecycle({
      botId: "synthetic",
      recordingId: "synthetic-recording",
      status: "ended",
      milestone,
      occurredAt: "2026-09-16T00:00:00.000Z",
    });
  expect(capture.getSnapshot().contentFlushRequired).toBe(true);
  expect(scanFinishedConversations(root).valid).toHaveLength(0);
  capture.close();
  const recovered = createLiveSessionService({
    repository: new FileSessionRepository(path.join(root, "private")),
    userWorkspaceRoot: root,
  });
  expect(scanFinishedConversations(root).valid).toHaveLength(0);
  recovered.editContent({
    sessionId: recovered.getSnapshot().sessionId,
    revision: recovered.getSnapshot().contentRevision ?? 0,
    mutationId: "final-note",
    section: "notes",
    text: "Latest inline observation",
  });
  expect(() =>
    recovered.retryFinalization({
      sessionId: recovered.getSnapshot().sessionId,
      revision: 999,
    }),
  ).toThrow(/Current edits/);
  expect(recovered.getSnapshot().contentFlushRequired).toBe(true);
  expect(scanFinishedConversations(root).valid).toHaveLength(0);
  recovered.retryFinalization({
    sessionId: recovered.getSnapshot().sessionId,
    revision: recovered.getSnapshot().contentRevision ?? 0,
  });
  expect(
    scanFinishedConversations(root).valid[0]?.conversation.session.notes[0]
      ?.text,
  ).toBe("Latest inline observation");
  expect(existsSync(path.join(root, "private/active-session.json"))).toBe(
    false,
  );
  recovered.saveCurrentContent({
    sessionId: recovered.getSnapshot().sessionId,
    revision: recovered.getSnapshot().contentRevision ?? 0,
  });
  expect(existsSync(path.join(root, "private/active-session.json"))).toBe(
    false,
  );
  recovered.close();
});
it("inserts an inline row at its actual position with a stable client identity and rejects duplicate identities", () => {
  const { service } = fixture();
  service.selectPrep("example.md");
  const id = crypto.randomUUID();
  const edit = {
    sessionId: service.getSnapshot().sessionId,
    mutationId: "insert",
    revision: 0,
    section: "topics",
    text: "Second",
    newId: id,
    afterId: "prep-1",
    tier: "must",
  };
  service.editContent(edit);
  expect(service.getSnapshot().topics.map((x) => x.id)).toEqual(["prep-1", id]);
  expect(() =>
    service.editContent({ ...edit, mutationId: "duplicate", revision: 1 }),
  ).toThrow(/identity/);
  service.close();
});

it("rejects a new inline identity already used in another list", () => {
  const { service } = fixture();
  service.selectPrep("example.md");
  const id = crypto.randomUUID();
  service.editContent({
    sessionId: service.getSnapshot().sessionId,
    revision: 0,
    mutationId: "one",
    section: "notes",
    text: "Observation",
    newId: id,
  });
  expect(() =>
    service.editContent({
      sessionId: service.getSnapshot().sessionId,
      revision: 1,
      mutationId: "two",
      section: "questions",
      text: "Question?",
      newId: id,
    }),
  ).toThrow(/identity/);
  service.close();
});

it("rejects duplicate name edits before checkpoint mutation and keeps a unique rename across restart", () => {
  const { root, service, repository } = fixture();
  service.selectPrep("example.md");
  const other = structuredClone(service.getSnapshot());
  other.sessionId = "22222222-2222-4333-8444-555555555555";
  other.lifecycle.displayName = "Taken name";
  publishFinishedConversation({
    root,
    state: other,
    prepSourceFile: "TEMPLATE.md",
    prepSourceBytes: bytes,
    completedAt: "2026-09-20T14:00:00.000Z",
  });
  const before = service.getSnapshot();
  const edit = (displayName: string) =>
    service.editContent({
      sessionId: before.sessionId,
      revision: 0,
      mutationId: displayName,
      section: "metadata",
      text: JSON.stringify({ displayName }),
    });
  expect(() => edit("TAKEN NAME")).toThrow(/different name/i);
  expect(service.getSnapshot()).toEqual(before);
  expect(repository.load()?.state).toEqual(before);
  edit("New Café name");
  service.saveCurrentContent({ sessionId: before.sessionId, revision: 1 });
  service.close();
  const resumed = createLiveSessionService({
    repository: new FileSessionRepository(path.join(root, "private")),
    userWorkspaceRoot: root,
  });
  expect(resumed.getSnapshot().lifecycle.displayName).toBe("New Café name");
  resumed.close();
});

it("rechecks the name before Finish, retains the flush barrier, and publishes an active rename coherently", async () => {
  const { root, repository, service } = fixture();
  service.selectPrep("example.md");
  service.close();
  const capture = createLiveSessionService({
    repository,
    userWorkspaceRoot: root,
    captureProvider: fakeCapture(),
  });
  capture.openContentEditing();
  expect(
    await capture.startRecallCapture({ ...meeting, displayName: "First name" }),
  ).toMatchObject({ ok: true });
  const rename = (displayName: string) =>
    capture.editContent({
      sessionId: capture.getSnapshot().sessionId,
      revision: capture.getSnapshot().contentRevision ?? 0,
      mutationId: displayName,
      section: "metadata",
      text: JSON.stringify({ displayName }),
    });
  rename("Final café");
  const originalPrep = readFileSync(
    path.join(root, "prep/current/example.md"),
    "utf8",
  );
  const other = structuredClone(capture.getSnapshot());
  other.sessionId = "33333333-2222-4333-8444-555555555555";
  publishFinishedConversation({
    root,
    state: other,
    prepSourceFile: "TEMPLATE.md",
    prepSourceBytes: bytes,
    completedAt: "2026-09-20T14:00:00.000Z",
  });
  for (const milestone of [
    "call_ended",
    "transcript_done",
    "bot_done",
  ] as const)
    capture.ingestRecallLifecycle({
      botId: "synthetic",
      recordingId: "synthetic-recording",
      status: "ended",
      milestone,
      occurredAt: "2026-09-20T14:00:00.000Z",
    });
  const flush = () => ({
    sessionId: capture.getSnapshot().sessionId,
    revision: capture.getSnapshot().contentRevision ?? 0,
  });
  expect(() => capture.retryFinalization(flush())).toThrow(/different name/i);
  expect(capture.getSnapshot().contentFlushRequired).toBe(true);
  rename("Available café");
  capture.saveCurrentContent(flush());
  expect(readFileSync(path.join(root, "prep/current/example.md"), "utf8")).toBe(
    originalPrep,
  );
  capture.retryFinalization(flush());
  expect(capture.getSnapshot().lifecycle.finalization).toMatchObject({
    state: "complete",
    directory: "finished-conversations/Available café",
  });
  expect(
    readFileSync(path.join(root, "prep/archive/Available café.md"), "utf8"),
  ).toBe(originalPrep);
  expect(scanFinishedConversations(root).valid.map((r) => r.name)).toEqual([
    "Available café",
    "Final café",
  ]);
  capture.close();
});

it.each([false, true])(
  "recovers a checkpoint after record publication before archive (legacy names: %s)",
  async (legacyNames) => {
    const { root, repository, service } = fixture();
    service.selectPrep("example.md");
    service.close();
    const capture = createLiveSessionService({
      repository,
      userWorkspaceRoot: root,
      captureProvider: fakeCapture(),
    });
    capture.openContentEditing();
    await capture.startRecallCapture({
      ...meeting,
      displayName: "Recovery café",
    });
    for (const milestone of [
      "call_ended",
      "transcript_done",
      "bot_done",
    ] as const)
      capture.ingestRecallLifecycle({
        botId: "synthetic",
        recordingId: "synthetic-recording",
        status: "ended",
        milestone,
        occurredAt: "2026-09-20T14:00:00.000Z",
      });
    const state = capture.getSnapshot();
    capture.close();
    state.contentFlushRequired = false;
    const completedAt = "2026-09-20T14:00:00.000Z";
    // The finalization-start time is part of the deterministic publication bytes.
    state.lifecycle.finalization = {
      state: "finalizing",
      startedAt: completedAt,
      completedAt,
      directory: "pending",
    };
    const binding = repository.getWorkspaceBinding()!;
    const input = {
      root,
      state,
      prepSourceFile: binding.prepSourceFile,
      prepSourceBytes: binding.prepSourceBytes,
      completedAt,
      legacyNames,
    };
    expect(() =>
      publishFinishedConversation(input, {
        afterFinalDirectoryPublished: () => {
          throw new Error("synthetic interruption");
        },
      }),
    ).toThrow("synthetic interruption");
    const record = scanFinishedConversations(root).valid[0]!;
    state.lifecycle.finalization.directory = `finished-conversations/${record.name}`;
    repository.setWorkspaceBinding({
      ...binding,
      finalization: {
        completedAt,
        directoryName: record.name,
        archiveFileName: "old-service-pointer.json",
        ...(legacyNames ? {} : { namingVersion: 1 as const }),
      },
    });
    repository.save(state, []);
    const restarted = createLiveSessionService({
      repository: new FileSessionRepository(path.join(root, "private")),
      userWorkspaceRoot: root,
    });
    expect(restarted.getSnapshot().lifecycle.finalization).toMatchObject({
      state: "complete",
      directory: `finished-conversations/${record.name}`,
    });
    expect(scanFinishedConversations(root).valid).toHaveLength(1);
    if (!legacyNames)
      expect(
        readFileSync(path.join(root, "prep/archive/Recovery café.md"), "utf8"),
      ).toBe(binding.prepSourceBytes);
    expect(existsSync(path.join(root, "private/active-session.json"))).toBe(
      false,
    );
    restarted.close();
  },
);

it("rejects a duplicate capture name without a provider call or state mutation", async () => {
  const { root, repository, service } = fixture();
  service.selectPrep("example.md");
  const other = structuredClone(service.getSnapshot());
  other.sessionId = "44444444-2222-4333-8444-555555555555";
  other.lifecycle.displayName = "Reserved name";
  publishFinishedConversation({
    root,
    state: other,
    prepSourceFile: "TEMPLATE.md",
    prepSourceBytes: bytes,
    completedAt: "2026-09-20T14:00:00.000Z",
  });
  service.close();
  const provider = fakeCapture();
  const capture = createLiveSessionService({
    repository,
    userWorkspaceRoot: root,
    captureProvider: provider,
  });
  const before = capture.getSnapshot();
  expect(
    await capture.startRecallCapture({
      ...meeting,
      displayName: "RESERVED NAME",
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringMatching(/different name/i),
  });
  expect(provider.createBot).not.toHaveBeenCalled();
  expect(capture.getSnapshot()).toEqual(before);
  capture.close();
});
