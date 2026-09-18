import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeUserWorkspace } from "../../src/server/workspace/user-workspace.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { createLiveSessionService } from "../../src/server/session-service.js";
import { parsePrep } from "../../src/server/workspace/prep-format.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const original =
  "---\nowner: fictional\n---\n# Synthetic\n\nDuration: 30 minutes\n\n## Background\nUnrelated **formatting**.\n\n## Must\n* [x] Original question?\n\n## References\n[Example](https://example.invalid)\n";
function fixture(bytes = original) {
  const root = mkdtempSync(path.join(tmpdir(), "caddy-writeback-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  initializeUserWorkspace(workspace);
  const file = path.join(root, "selected.md");
  writeFileSync(file, bytes);
  const repository = new FileSessionRepository(path.join(root, "private"));
  const options = {
    repository,
    userWorkspaceRoot: workspace,
    captureProvider: {
      region: "us-west-2" as const,
      createBot: vi.fn(async () => ({ botId: "synthetic" })),
      stopRecordingNotice: async () => {},
    },
  };
  const service = createLiveSessionService(options);
  return { root, workspace, file, repository, options, service };
}
function edit(
  service: ReturnType<typeof createLiveSessionService>,
  section: string,
  text: string,
  id?: string,
) {
  const s = service.getSnapshot();
  return service.editContent({
    sessionId: s.sessionId,
    revision: s.contentRevision ?? 0,
    mutationId: crypto.randomUUID(),
    section,
    text,
    ...(id ? { id } : {}),
  });
}
function save(service: ReturnType<typeof createLiveSessionService>) {
  const s = service.getSnapshot();
  return service.saveCurrentContent({
    sessionId: s.sessionId,
    revision: s.contentRevision ?? 0,
  });
}
it("writes the native-selected original, preserves unrelated Markdown and all editable identities through reselection/restart", () => {
  const { service, file, repository, options } = fixture();
  service.selectNativePrep(file);
  expect(service.getSnapshot().topics[0]?.checked).toBe(true);
  edit(service, "notes", "Observation");
  edit(service, "questions", "Question?");
  edit(service, "revisit", "Return here");
  edit(service, "summary", "Person summary");
  edit(
    service,
    "metadata",
    JSON.stringify({ title: "Revised", displayName: "Synthetic name" }),
  );
  service.setQuestionChecked(service.getSnapshot().questions[0]!.id, true);
  const state = service.getSnapshot();
  save(service);
  const saved = readFileSync(file, "utf8");
  expect(saved).toContain("---\nowner: fictional\n---\n");
  expect(saved).toContain("## Background\nUnrelated **formatting**.");
  expect(saved).toContain("* [x] Original question?");
  expect(saved).toContain("## References\n[Example](https://example.invalid)");
  expect(parsePrep(saved, "selected.md").title).toBe("Revised");
  expect(saved).toContain("Observation");
  expect(service.getProviderCallCount()).toBe(0);
  service.selectNativePrep(file);
  for (const key of [
    "topics",
    "notes",
    "questions",
    "revisit",
    "humanContext",
  ] as const)
    expect(service.getSnapshot()[key]).toEqual(state[key]);
  service.close();
  const restarted = createLiveSessionService({
    ...options,
    repository: new FileSessionRepository(repository.dataRoot),
  });
  expect(restarted.getSnapshot().notes).toEqual(state.notes);
  restarted.close();
});
it("keeps external conflicts and missing originals intact, then retries without losing the draft", () => {
  const { service, file } = fixture("# Synthetic\n## Must\n- Question?\n");
  service.selectNativePrep(file);
  edit(service, "notes", "Draft");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, before + "\nExternal\n");
  expect(() => save(service)).toThrow(/changed/);
  expect(readFileSync(file, "utf8")).toBe(before + "\nExternal\n");
  expect(service.getSnapshot().notes[0]?.text).toBe("Draft");
  rmSync(file);
  expect(() => save(service)).toThrow();
  writeFileSync(file, before);
  save(service);
  expect(readFileSync(file, "utf8")).toContain("Draft");
  service.close();
});
it("recovers a successful prep replacement followed by checkpoint failure across restart", () => {
  const { service, file, repository, options } = fixture(
    "# Synthetic\n## Must\n- Question?\n",
  );
  service.selectNativePrep(file);
  edit(service, "notes", "Durable draft");
  const real = repository.save.bind(repository);
  let calls = 0;
  vi.spyOn(repository, "save").mockImplementation((...args) => {
    if (++calls === 2) throw new Error("synthetic checkpoint failure");
    real(...args);
  });
  expect(() => save(service)).toThrow(/checkpoint/);
  expect(readFileSync(file, "utf8")).toContain("Durable draft");
  service.close();
  const restarted = createLiveSessionService({
    ...options,
    repository: new FileSessionRepository(repository.dataRoot),
  });
  save(restarted);
  expect(restarted.getSnapshot().notes[0]?.text).toBe("Durable draft");
  expect(readFileSync(file, "utf8")).toContain("Durable draft");
  restarted.close();
});
it("isolates active capture saves; failed provider creation leaves preparation writable", async () => {
  const { service, file } = fixture("# Synthetic\n## Must\n- Question?\n");
  service.selectNativePrep(file);
  edit(service, "notes", "Before");
  save(service);
  const before = readFileSync(file, "utf8");
  expect(
    await service.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789",
    }),
  ).toMatchObject({ ok: true });
  edit(service, "notes", "During");
  save(service);
  expect(readFileSync(file, "utf8")).toBe(before);
  service.close();
  const other = fixture("# Other\n## Must\n- Why?\n");
  other.service.selectNativePrep(other.file);
  other.options.captureProvider.createBot.mockRejectedValueOnce(
    new Error("synthetic"),
  );
  await other.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  edit(other.service, "notes", "After failed start");
  save(other.service);
  expect(readFileSync(other.file, "utf8")).toContain("After failed start");
  expect(() => other.service.selectNativePrep(other.file)).not.toThrow();
  other.service.close();
});
it("preserves manual Markdown changes after a saved prep is chosen again, including notes and checks", () => {
  const { service, file } = fixture("# Synthetic\n## Must\n- Question?\n");
  service.selectNativePrep(file);
  edit(service, "notes", "Original note");
  save(service);
  const old = service.getSnapshot();
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replace("- Original note", "- Manual note")
      .replace("- Question?", "- [x] Changed question?"),
  );
  service.selectNativePrep(file);
  expect(service.getSnapshot().notes[0]).toMatchObject({
    ...old.notes[0],
    text: "Manual note",
  });
  expect(service.getSnapshot().topics[0]).toMatchObject({
    text: "Changed question?",
    checked: true,
  });
  save(service);
  expect(readFileSync(file, "utf8")).toContain("Manual note");
  service.close();
});
it("keeps untouched list formatting when one adjacent item changes and saving twice is byte-idempotent", () => {
  const input =
    "# Synthetic\n## Must\n* [ ] Unchanged **emphasis**?\n+ [ ] Change me?\n";
  const { service, file } = fixture(input);
  service.selectNativePrep(file);
  edit(service, "topics", "Changed?", service.getSnapshot().topics[1]!.id);
  save(service);
  const once = readFileSync(file, "utf8");
  expect(once).toContain("* [ ] Unchanged **emphasis**?\n");
  save(service);
  expect(readFileSync(file, "utf8")).toBe(once);
  service.close();
});
it("rejects a concurrent atomic-write conflict without altering external bytes or directory permissions", async () => {
  const { replaceSelectedPrep } = await import(
    "../../src/server/workspace/prep-writeback.js"
  );
  const { realpathSync, statSync } = await import("node:fs");
  const { file, service } = fixture("# Original\n## Must\n- Why?\n");
  const resolved = realpathSync(file);
  const original = readFileSync(file, "utf8");
  const mode = statSync(path.dirname(file)).mode;
  expect(() =>
    replaceSelectedPrep(resolved, original, "replacement", () =>
      writeFileSync(file, "external"),
    ),
  ).toThrow(/changed/);
  expect(readFileSync(file, "utf8")).toBe("external");
  expect(statSync(path.dirname(file)).mode).toBe(mode);
  service.close();
});
it("keeps legacy JSON metadata above Markdown limits without truncation on Save and reload", () => {
  const { service, root } = fixture();
  const json = path.join(root, "legacy.json");
  writeFileSync(
    json,
    JSON.stringify({
      schemaVersion: 1,
      title: "T".repeat(150000),
      plannedDurationMinutes: 481,
      topics: [{ tier: "must", text: "Why?" }],
    }),
  );
  service.selectNativePrep(json);
  edit(service, "notes", "Small note");
  save(service);
  expect(parsePrep(readFileSync(json, "utf8"), json).title).toHaveLength(
    150000,
  );
  service.selectNativePrep(json);
  expect(service.getSnapshot().humanContext?.plannedDurationMinutes).toBe(481);
  expect(service.getSnapshot().notes[0]?.text).toBe("Small note");
  service.close();
});
it("blocks relocation and capture until a pending prep save is resolved", async () => {
  const { service, file } = fixture("# Synthetic\n## Must\n- Why?\n");
  service.selectNativePrep(file);
  edit(service, "notes", "Pending");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original + "external");
  expect(() => save(service)).toThrow();
  expect(() => service.beginWorkspaceMove()).toThrow(/Retry Save/);
  expect(
    await service.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789",
    }),
  ).toMatchObject({ ok: false, error: expect.stringMatching(/Retry Save/) });
  writeFileSync(file, original);
  save(service);
  const release = service.beginWorkspaceMove();
  expect(() => save(service)).toThrow(/move/);
  release();
  expect(() => save(service)).not.toThrow();
  service.close();
});
it("does not write an unwritable file, symlink leaf, or application resource; reports no writable selection", async () => {
  const { chmodSync, symlinkSync, mkdirSync } = await import("node:fs");
  const { service, file, root } = fixture("# Synthetic\n## Must\n- Why?\n");
  expect(() => save(service)).toThrow(/Choose a writable/);
  service.selectNativePrep(file);
  edit(service, "notes", "Draft");
  chmodSync(file, 0o400);
  expect(() => save(service)).toThrow(/not writable/);
  chmodSync(file, 0o600);
  const original = readFileSync(file, "utf8");
  rmSync(file);
  const other = path.join(root, "other.md");
  writeFileSync(other, original);
  symlinkSync(other, file);
  expect(() => save(service)).toThrow();
  expect(readFileSync(other, "utf8")).toBe(original);
  rmSync(file);
  writeFileSync(file, original);
  save(service);
  const app = path.join(root, "Synthetic.app");
  mkdirSync(app);
  const bundled = path.join(app, "prep.md");
  writeFileSync(bundled, original);
  service.selectNativePrep(bundled);
  edit(service, "notes", "More");
  expect(() => save(service)).toThrow(/outside the application/);
  expect(readFileSync(bundled, "utf8")).toBe(original);
  service.close();
});
it("preserves frontmatter and fenced examples that contain lookalike editor headings", () => {
  const prefix = "---\ndescription: |\n  # Not the title\n---\n";
  const unknown =
    "## Examples\n```md\n## Must\n- Not a prepared question\n```\n\n";
  const { service, file } = fixture(
    `${prefix}# Actual\nDuration: 30 minutes\n${unknown}## Must\n- Actual question\n`,
  );
  service.selectNativePrep(file);
  expect(service.getSnapshot().topics.map((x) => x.text)).toEqual([
    "Actual question",
  ]);
  edit(service, "metadata", JSON.stringify({ title: "Revised actual" }));
  edit(
    service,
    "topics",
    "Revised question",
    service.getSnapshot().topics[0]!.id,
  );
  save(service);
  const bytes = readFileSync(file, "utf8");
  expect(bytes.startsWith(prefix)).toBe(true);
  expect(bytes).toContain(unknown);
  expect(parsePrep(bytes, file).title).toBe("Revised actual");
  service.close();
});
it("imports existing Notes, Questions and Revisit without dropping their author text on save", () => {
  const { service, file } = fixture(
    "# Existing\n## Must\n- Why?\n## Notes\n* Existing observation\n## Questions\n- [x] Existing question\n## Revisit\n- [ ] Existing thread\n",
  );
  service.selectNativePrep(file);
  expect(service.getSnapshot().notes[0]?.text).toBe("Existing observation");
  expect(service.getSnapshot().questions[0]?.checked).toBe(true);
  edit(service, "notes", "New observation");
  save(service);
  expect(readFileSync(file, "utf8")).toContain("* Existing observation");
  service.selectNativePrep(file);
  expect(service.getSnapshot().notes.map((x) => x.text)).toEqual([
    "Existing observation",
    "New observation",
  ]);
  service.close();
});
it("serializes Save against capture creation without rewriting the prep after a known bot exists", async () => {
  const { service, file, options } = fixture("# Synthetic\n## Must\n- Why?\n");
  service.selectNativePrep(file);
  let complete!: (value: { botId: string }) => void;
  options.captureProvider.createBot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const starting = service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  edit(service, "notes", "While starting");
  expect(() => save(service)).toThrow(/Capture is starting/);
  const original = readFileSync(file, "utf8");
  complete({ botId: "synthetic" });
  expect(await starting).toMatchObject({ ok: true });
  save(service);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(service.getSnapshot().notes[0]?.text).toBe("While starting");
  service.close();
});
it("saves every later edit after retrying an older durable prep-write intent", () => {
  const { service, file } = fixture("# Synthetic\n## Must\n- Why?\n");
  service.selectNativePrep(file);
  edit(service, "notes", "First draft");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original + "external");
  expect(() => save(service)).toThrow();
  edit(service, "notes", "Later draft");
  writeFileSync(file, original);
  save(service);
  const bytes = readFileSync(file, "utf8");
  expect(bytes).toContain("First draft");
  expect(bytes).toContain("Later draft");
  service.selectNativePrep(file);
  expect(service.getSnapshot().notes.map((x) => x.text)).toEqual([
    "First draft",
    "Later draft",
  ]);
  service.close();
});

it.each([
  "  - Nested prompt",
  "  1. Nested prompt",
  "  [context] continuation",
  "ordinary continuation",
])(
  "roundtrips prepared continuation %s without shifting checks or identities",
  (continuation) => {
    const bytes = `# Synthetic\n## Must\n- Parent question\n${continuation}\n- [x] Second question\n## Foreign\nKeep **exactly** this.\n`;
    const parsed = parsePrep(bytes, "nested.md");
    expect(parsed.topics).toHaveLength(2);
    expect(parsed.savedContent?.topics.map((x) => x.checked)).toEqual([
      false,
      true,
    ]);
    const { service, file, options, repository } = fixture(bytes);
    service.selectNativePrep(file);
    const ids = service.getSnapshot().topics.map((x) => x.id);
    service.setTopicChecked(ids[0]!, true);
    edit(service, "topics", "Edited parent\n" + continuation.trim(), ids[0]);
    save(service);
    const written = readFileSync(file, "utf8");
    expect(written).toContain("## Foreign\nKeep **exactly** this.\n");
    expect(
      parsePrep(written, "nested.md").savedContent?.topics.map(
        (x) => x.checked,
      ),
    ).toEqual([true, true]);
    service.selectNativePrep(file);
    const final = service.getSnapshot().topics;
    expect(final.map((x) => x.id)).toEqual(ids);
    service.close();
    const restarted = createLiveSessionService({
      ...options,
      repository: new FileSessionRepository(repository.dataRoot),
    });
    expect(restarted.getSnapshot().topics).toEqual(final);
    restarted.close();
  },
);

const continuationCases = [
  "ordinary continuation",
  "  indented continuation",
  "  - Nested prompt",
].flatMap((continuation) =>
  [
    "Must",
    "More Avenues",
    "Notes",
    "Questions",
    "Revisit",
    "Person summary",
  ].flatMap((heading) =>
    ["edit", "check"]
      .filter(
        (action) =>
          !(
            action === "check" && ["Notes", "Person summary"].includes(heading)
          ) &&
          // Summary's established grammar treats nested bullets as separate items.
          !(heading === "Person summary" && continuation.includes("Nested")),
      )
      .map((action) => ({ continuation, heading, action })),
  ),
);
it.each(continuationCases)(
  "preserves unchanged $heading parent ($continuation) on neighbor $action",
  ({ continuation, heading, action }) => {
    const parent = `* Parent text\n${continuation}\n`;
    const bytes = `---\nowner: synthetic\n---\n# Synthetic\n${heading === "Must" ? "" : "## Must\n- Required question\n"}## ${heading}\n${parent}- [x] Second text\n## Foreign\nKeep **exactly** this.\n`;
    const { service, file, repository, options } = fixture(bytes);
    service.selectNativePrep(file);
    const section =
      heading === "Must" || heading === "More Avenues"
        ? "topics"
        : heading === "Person summary"
          ? "summary"
          : heading.toLowerCase();
    const snapshot = service.getSnapshot();
    const rows =
      section === "summary"
        ? snapshot.humanContext!.personSummary
        : section === "topics"
          ? snapshot.topics.filter(
              (x) => x.tier === (heading === "Must" ? "must" : "more"),
            )
          : snapshot[section as "notes" | "questions" | "revisit"];
    const neighbor = rows[1]!;
    if (action === "edit")
      edit(service, section, "Edited second text", neighbor.id);
    else if (section === "topics") service.setTopicChecked(neighbor.id, false);
    else if (section === "questions")
      service.setQuestionChecked(neighbor.id, false);
    else service.setRevisitChecked(neighbor.id, false);
    const expected = service.getSnapshot();
    save(service);
    const saved = readFileSync(file, "utf8");
    expect(saved).toContain(parent);
    expect(saved).toContain("---\nowner: synthetic\n---\n");
    expect(saved).toContain("## Foreign\nKeep **exactly** this.\n");
    service.selectNativePrep(file);
    for (const key of [
      "topics",
      "humanContext",
      "notes",
      "questions",
      "revisit",
    ] as const)
      expect(service.getSnapshot()[key]).toEqual(expected[key]);
    service.close();
    const restarted = createLiveSessionService({
      ...options,
      repository: new FileSessionRepository(repository.dataRoot),
    });
    for (const key of [
      "topics",
      "humanContext",
      "notes",
      "questions",
      "revisit",
    ] as const)
      expect(restarted.getSnapshot()[key]).toEqual(expected[key]);
    restarted.close();
  },
);
