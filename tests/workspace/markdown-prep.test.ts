import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  initializeUserWorkspace,
  readPrep,
  savePrep,
  scanPrep,
  publishFinishedConversation,
  scanFinishedConversations,
} from "../../src/server/workspace/user-workspace.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import {
  SessionService,
  createLiveSessionService,
} from "../../src/server/session-service.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import { createSessionState } from "../helpers/session-state.js";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "caddy-markdown-"));
  roots.push(root);
  initializeUserWorkspace(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const bytes =
  "\uFEFF# Décision — inspection\r\n\r\nDuration: 25 minutes\r\n\r\n## MUST\r\n- [x] What changed?\r\n  Which evidence mattered?\r\n\r\n## More avenues\r\n1. Who decided?\r\n* Why then?\r\n";
it("creates an ordinary Markdown template without overwriting authored or legacy files", () => {
  const root = fixture();
  const file = path.join(root, "prep/TEMPLATE.md");
  expect(readFileSync(file, "utf8")).toContain("## Must\n");
  expect(existsSync(path.join(root, "prep/TEMPLATE.json"))).toBe(false);
  writeFileSync(file, bytes);
  writeFileSync(path.join(root, "prep/TEMPLATE.json"), "legacy original");
  initializeUserWorkspace(root);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(readFileSync(path.join(root, "prep/TEMPLATE.json"), "utf8")).toBe(
    "legacy original",
  );
});
it("parses headings, Unicode, ordinary/check lists and multiline questions preserving checked topics", () => {
  const root = fixture();
  writeFileSync(path.join(root, "prep/current/case.md"), bytes);
  const opened = readPrep(root, "case.md");
  expect(opened.sourceBytes).toBe(bytes);
  expect(opened.prep).toMatchObject({
    schemaVersion: 1,
    title: "Décision — inspection",
    plannedDurationMinutes: 25,
    topics: [
      { tier: "must", text: "What changed?\nWhich evidence mattered?" },
      { tier: "more", text: "Who decided?" },
      { tier: "more", text: "Why then?" },
    ],
  });
  expect(scanPrep(root).valid.map((p) => p.basename)).toEqual(["case.md"]);
});
it("reports malformed Markdown locally beside legacy JSON and preserves stale edits", () => {
  const root = fixture();
  writeFileSync(path.join(root, "prep/current/case.md"), bytes);
  const opened = readPrep(root, "case.md");
  savePrep(root, "legacy.json", opened.prep, null);
  for (const [name, body] of Object.entries({
    "empty.md": "# Empty\n## Must\n",
    "duration.md": "# Case\nDuration: soon\n## Must\n- Why?",
    "large.md": `# Case\n## Must\n- ${"x".repeat(300000)}`,
  }))
    writeFileSync(path.join(root, "prep/current", name), body);
  const scan = scanPrep(root);
  expect(scan.valid.map((p) => p.basename)).toEqual(["case.md", "legacy.json"]);
  expect(scan.errors).toHaveLength(3);
  writeFileSync(path.join(root, "prep/current/case.md"), `${bytes}\n`);
  expect(() =>
    savePrep(root, "case.md", opened.prep, opened.sourceBytes),
  ).toThrow(/changed since/i);
  expect(readFileSync(path.join(root, "prep/current/case.md"), "utf8")).toBe(
    `${bytes}\n`,
  );
});
it("keeps Markdown exact through selected checkpoint restart, publication, archive and reopening beside legacy records", () => {
  const root = fixture();
  writeFileSync(path.join(root, "prep/current/case.md"), bytes);
  const repository = new FileSessionRepository(path.join(root, "private"));
  const service = new SessionService({
    topics: [],
    transcript: [],
    provider: new FakeMartyProvider(),
    repository,
    userWorkspaceRoot: root,
    initialCaptureMode: "live_ready",
  });
  try {
    service.selectPrep("case.md");
    expect(service.getSnapshot().topics.map((t) => t.checked)).toEqual([
      true,
      false,
      false,
    ]);
  } finally {
    service.close();
  }
  const restored = new FileSessionRepository(path.join(root, "private")).load();
  expect(restored?.workspace?.prepSourceBytes).toBe(bytes);
  expect(restored?.workspace?.prep.plannedDurationMinutes).toBe(25);
  const state = createSessionState({
    sessionId: "11111111-2222-4333-8444-555555555555",
    startedAt: "2026-09-12T00:00:00.000Z",
  });
  const input = {
    root,
    state,
    prepSourceFile: "case.md",
    prepSourceBytes: bytes,
    completedAt: "2026-09-12T01:00:00.000Z",
  };
  const first = publishFinishedConversation(input);
  expect(publishFinishedConversation(input)).toEqual(first);
  expect(readdirSync(first.directory).sort()).toEqual([
    "conversation.json",
    "conversation.md",
    "manifest.json",
    "prep.md",
  ]);
  expect(readFileSync(path.join(first.directory, "prep.md"), "utf8")).toBe(
    bytes,
  );
  expect(readFileSync(first.archiveFile, "utf8")).toBe(bytes);
  expect(first.archiveFileName).toMatch(/\.md$/);
  writeFileSync(
    path.join(root, "prep/current/reopen.md"),
    readFileSync(first.archiveFile),
  );
  expect(readPrep(root, "reopen.md").prep.title).toBe("Décision — inspection");
  expect(scanFinishedConversations(root).valid[0]?.files).toContain("prep.md");
  const legacy = savePrep(
    root,
    "legacy.json",
    readPrep(root, "reopen.md").prep,
    null,
  );
  publishFinishedConversation({
    ...input,
    state: { ...state, sessionId: "11111111-2222-4333-8444-666666666666" },
    legacyNames: true,
    prepSourceFile: legacy.basename,
    prepSourceBytes: legacy.sourceBytes,
  });
  expect(scanFinishedConversations(root).valid).toHaveLength(2);
});
it("saving multiline Markdown retains indented list text within its question", () => {
  const root = fixture();
  const prep = {
    schemaVersion: 1 as const,
    title: "Nested evidence",
    plannedDurationMinutes: 30,
    topics: [
      {
        tier: "must" as const,
        text: "What mattered?\n- The timing?\n- The source?",
      },
    ],
  };
  const saved = savePrep(root, "nested.md", prep, null);
  expect(saved.prep).toEqual(prep);
  expect(saved.sourceBytes).toContain("\n  - The timing?");
});

it("recovers Markdown through the production session factory and snapshots edits to the working copy at start", async () => {
  const root = fixture();
  const privateRoot = path.join(root, "private");
  writeFileSync(path.join(root, "prep/current/case.md"), bytes);
  const first = createLiveSessionService({
    repository: new FileSessionRepository(privateRoot),
    userWorkspaceRoot: root,
  });
  first.selectPrep("case.md");
  first.close();
  const repository = new FileSessionRepository(privateRoot);
  const restored = createLiveSessionService({
    repository,
    userWorkspaceRoot: root,
    captureProvider: {
      region: "us-west-2",
      createBot: async () => ({ botId: "synthetic" }),
      stopRecordingNotice: async () => {},
    },
  });
  try {
    expect(restored.getSnapshot().topics[0]?.text).toBe(
      "What changed?\nWhich evidence mattered?",
    );
    const latest =
      "# Revised interview\nDuration: 45 minutes\n## More Avenues\n- What changed later?\n";
    writeFileSync(path.join(root, "prep/current/case.md"), latest);
    expect(
      await restored.startRecallCapture({
        meetingUrl: "https://teams.live.com/meet/123456789",
      }),
    ).toMatchObject({ ok: true });
    expect(restored.getSnapshot().topics[0]).toMatchObject({
      tier: "more",
      text: "What changed later?",
      checked: false,
    });
    expect(repository.getWorkspaceBinding()).toMatchObject({
      prepSourceBytes: latest,
      prep: { title: "Revised interview", plannedDurationMinutes: 45 },
    });
  } finally {
    restored.close();
  }
});
it.each([
  ["duplicate sections", "# Case\n## Must\n- Why?\n## MUST\n- Who?"],
  ["no title", "## Must\n- Why?"],
  ["too many questions", `# Case\n## Must\n${"- Why?\n".repeat(201)}`],
  ["long question", `# Case\n## Must\n- ${"x".repeat(4001)}`],
  ["null", "# Case\n## Must\n- Why?\0"],
  ["invalid UTF-8", Buffer.from([0xff, 0xfe])],
])("rejects %s without changing the selected session", (_name, body) => {
  const root = fixture();
  writeFileSync(path.join(root, "prep/current/good.md"), bytes);
  const service = new SessionService({
    topics: [],
    transcript: [],
    provider: new FakeMartyProvider(),
    repository: new FileSessionRepository(path.join(root, "private")),
    userWorkspaceRoot: root,
  });
  try {
    service.selectPrep("good.md");
    const before = service.getSnapshot();
    writeFileSync(path.join(root, "prep/current/bad.md"), body);
    expect(() => service.selectPrep("bad.md")).toThrow();
    expect(service.getSnapshot()).toEqual(before);
    expect(service.getWorkspaceOverview()?.selectedPrep).toBe("good.md");
  } finally {
    service.close();
  }
});
it("preserves literal checkbox text now that serialized questions have their own checkbox", () => {
  const root = fixture();
  writeFileSync(path.join(root, "prep/current/case.md"), bytes);
  const original = readPrep(root, "case.md");
  const saved = savePrep(
    root,
    "case.md",
    {
      ...original.prep,
      topics: [{ tier: "must", text: "[x] Is this literal?" }],
    },
    bytes,
  );
  expect(saved.prep.topics[0]?.text).toBe("[x] Is this literal?");
  expect(saved.sourceBytes).toContain("- [ ] [x] Is this literal?");
});

it("retains an unknown section while selecting its prepared questions", () => {
  const root = fixture();
  const source = "# Case\n## Must\n- Why?\n## Other\n- Who?";
  writeFileSync(path.join(root, "prep/current/unknown.md"), source);
  const prep = readPrep(root, "unknown.md");
  expect(prep.sourceBytes).toBe(source);
  expect(prep.prep.topics).toEqual([{ tier: "must", text: "Why?" }]);
});
