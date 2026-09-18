import {
  mkdirSync,
  realpathSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceDialogPort } from "../../src/desktop/workspace-dialog.js";
import { createApp } from "../../src/server/app.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { SessionService } from "../../src/server/session-service.js";
import { initializeUserWorkspace } from "../../src/server/workspace/user-workspace.js";

const roots: string[] = [];
const services: SessionService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "clarity-prep-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  initializeUserWorkspace(workspace);
  const provider = new FakeMartyProvider();
  const service = new SessionService({
    topics: [],
    transcript: [],
    provider,
    repository: new FileSessionRepository(path.join(root, "private")),
    userWorkspaceRoot: workspace,
    initialCaptureMode: "live_ready",
    captureProvider: {
      region: "us-west-2",
      createBot: async () => ({ botId: "synthetic-bot" }),
      stopRecordingNotice: async () => {},
    },
  });
  services.push(service);
  const write = (name: string) => {
    const file = path.join(workspace, "prep/current", name);
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        title: name,
        plannedDurationMinutes: 25,
        topics: [
          { tier: "must", text: "What changed?" },
          { tier: "more", text: "Who decided?" },
        ],
      }),
    );
    return file;
  };
  return { root, workspace, service, write };
}
it("opens the native picker at workspace prep and selects authoritative contents", async () => {
  const f = fixture();
  const owner = {};
  const showOpenDialog = vi.fn(async () => ({
    canceled: false,
    filePaths: [f.write("fresh.json")],
  }));
  const dialog = createWorkspaceDialogPort(owner, { showOpenDialog });
  const app = createApp({ service: f.service, choosePrep: dialog.choosePrep });
  const result = await request(app)
    .post("/api/workspace/prep/choose")
    .send({})
    .expect(200);
  expect(showOpenDialog).toHaveBeenCalledWith(
    owner,
    expect.objectContaining({
      defaultPath: path.join(f.workspace, "prep"),
      properties: ["openFile"],
      buttonLabel: "Open",
      message:
        "Choose a Markdown prep file. Before the interview starts, Save updates this file and Caddy’s working copy.",
    }),
  );
  expect(result.body.kind).toBe("selected");
  expect(result.body.workspace.selectedPrep).toMatch(
    /^fresh-[a-f0-9-]+\.json$/,
  );
  expect(result.body.state.topics.map((t: { text: string }) => t.text)).toEqual(
    ["What changed?", "Who decided?"],
  );
});
it("browser chooser discovers files added since the last overview without selecting them", async () => {
  const f = fixture();
  const app = createApp({ service: f.service });
  await request(app).get("/api/workspace");
  f.write("fresh.json");
  const before = f.service.getSnapshot();
  const result = await request(app)
    .post("/api/workspace/prep/choose")
    .send({})
    .expect(200);
  expect(result.body.kind).toBe("browser");
  expect(result.body.workspace.prep.valid[0].basename).toBe("fresh.json");
  expect(f.service.getSnapshot()).toEqual(before);
});
it.each(["cancel", "malformed", "deleted", "outside", "symlink", "extension"])(
  "preserves selected prep and session on %s",
  async (kind) => {
    const f = fixture();
    f.write("old.json");
    f.service.selectPrep("old.json");
    const before = f.service.getSnapshot();
    const choosePrep = async () => {
      if (kind === "cancel") return null;
      if (kind === "outside") return path.join(f.root, "old.json");
      const file = f.write(kind === "extension" ? "bad.txt" : "bad.json");
      if (kind === "malformed") writeFileSync(file, "{");
      if (kind === "deleted") rmSync(file);
      if (kind === "symlink") {
        rmSync(file);
        symlinkSync(path.join(f.workspace, "prep/current/old.json"), file);
      }
      return file;
    };
    await request(createApp({ service: f.service, choosePrep }))
      .post("/api/workspace/prep/choose")
      .send({})
      .expect(kind === "cancel" ? 200 : 409);
    expect(f.service.getSnapshot()).toEqual(before);
    expect(f.service.getWorkspaceOverview()?.selectedPrep).toBe("old.json");
  },
);
it("rejects stale browser session selection without mutation", async () => {
  const f = fixture();
  f.write("fresh.json");
  const before = f.service.getSnapshot();
  await request(createApp({ service: f.service }))
    .post("/api/workspace/prep/select")
    .send({ basename: "fresh.json", sessionId: "stale-session" })
    .expect(409);
  expect(f.service.getSnapshot()).toEqual(before);
});

it("serializes native dialogs and refuses selection if capture starts while the chooser is open", async () => {
  const f = fixture();
  f.write("old.json");
  f.service.selectPrep("old.json");
  const file = f.write("next.json");
  let release!: (file: string | null) => void;
  const pending = new Promise<string | null>((resolve) => {
    release = resolve;
  });
  const choosePrep = vi.fn(() => pending);
  const app = createApp({ service: f.service, choosePrep });
  const choosing = request(app)
    .post("/api/workspace/prep/choose")
    .send({})
    .then((result) => result);
  await vi.waitFor(() => expect(choosePrep).toHaveBeenCalledOnce());
  await request(app).post("/api/workspace/prep/choose").send({}).expect(409);
  const capture = await f.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  expect(capture.ok).toBe(true);
  const before = f.service.getSnapshot();
  release(file);
  expect((await choosing).status).toBe(409);
  expect(f.service.getSnapshot()).toEqual(before);
  expect(f.service.getWorkspaceOverview()?.selectedPrep).toBe("old.json");
  await request(app).post("/api/workspace/prep/choose").send({}).expect(409);
  expect(choosePrep).toHaveBeenCalledOnce();
});

it.each(["external", "template", "archive"])(
  "native %s Markdown selection snapshots exact bytes without consuming the original",
  async (location) => {
    const f = fixture();
    const original =
      location === "external"
        ? path.join(f.root, "interview.md")
        : path.join(
            f.workspace,
            "prep",
            location === "template" ? "TEMPLATE.md" : "archive/interview.md",
          );
    const bytes =
      "# Décision\r\n\r\n## Must\r\n- What changed?\r\n  Why now?\r\n\r\n## More Avenues\r\n- Who decided?\r\n";
    writeFileSync(original, bytes);
    const app = createApp({
      service: f.service,
      choosePrep: async () => original,
    });
    const first = await request(app)
      .post("/api/workspace/prep/choose")
      .send({ path: "/untrusted/body.md" })
      .expect(200);
    const selected = first.body.workspace.selectedPrep;
    expect(selected).toMatch(/-[a-f0-9-]+\.md$/);
    expect(
      readFileSync(path.join(f.workspace, "prep/current", selected), "utf8"),
    ).toBe(bytes);
    expect(
      first.body.state.topics.map((t: { text: string }) => t.text),
    ).toEqual(["What changed?\nWhy now?", "Who decided?"]);
    const second = await request(app)
      .post("/api/workspace/prep/choose")
      .send({})
      .expect(200);
    expect(second.body.workspace.selectedPrep).not.toBe(selected);
    expect(
      await f.service.startRecallCapture({
        meetingUrl: "https://teams.live.com/meet/123456789",
      }),
    ).toMatchObject({ ok: true });
    for (const milestone of [
      "call_ended",
      "transcript_done",
      "bot_done",
    ] as const) {
      expect(
        f.service.ingestRecallLifecycle({
          botId: "synthetic-bot",
          recordingId: "synthetic-recording",
          status: "ended",
          milestone,
          occurredAt: "2026-09-13T00:00:00.000Z",
        }),
      ).toBe("accepted");
    }
    expect(f.service.getSnapshot().lifecycle.finalization.state).toBe(
      "complete",
    );
    const record = f.service.getWorkspaceOverview()?.finished.valid[0];
    if (!record) throw Error("Missing finished record");
    expect(record.files).toContain("prep.md");
    expect(readFileSync(path.join(record.directory, "prep.md"), "utf8")).toBe(
      bytes,
    );
    expect(
      existsSync(
        path.join(
          f.workspace,
          "prep/current",
          second.body.workspace.selectedPrep,
        ),
      ),
    ).toBe(false);
    const archived = readdirSync(path.join(f.workspace, "prep/archive")).find(
      (name) => name !== "interview.md",
    );
    if (!archived) throw Error("Missing prep archive");
    expect(
      readFileSync(path.join(f.workspace, "prep/archive", archived), "utf8"),
    ).toBe(bytes);

    expect(readFileSync(original, "utf8")).toBe(bytes);
    expect(
      readFileSync(path.join(f.workspace, "prep/current", selected), "utf8"),
    ).toBe(bytes);
  },
);
it("browser requests cannot grant external file authority, and invalid native Markdown creates no copy", async () => {
  const f = fixture();
  f.write("old.json");
  f.service.selectPrep("old.json");
  const original = path.join(f.root, "external.md");
  writeFileSync(original, "# External\n## Must\n- Who?\n");
  const before = f.service.getSnapshot();
  const app = createApp({ service: f.service });
  await request(app)
    .post("/api/workspace/prep/choose")
    .send({ path: original })
    .expect(200);
  for (const basename of [original, "../../external.md"])
    await request(app)
      .post("/api/workspace/prep/select")
      .send({ basename })
      .expect(409);
  for (const bytes of ["# Missing questions", "x".repeat(300000)]) {
    writeFileSync(original, bytes);
    await request(
      createApp({ service: f.service, choosePrep: async () => original }),
    )
      .post("/api/workspace/prep/choose")
      .send({})
      .expect(409);
  }
  expect(f.service.getSnapshot()).toEqual(before);
  expect(readdirSync(path.join(f.workspace, "prep/current"))).toEqual([
    "old.json",
  ]);
});
it("refuses a replaced working directory before copying a native selection", async () => {
  const f = fixture();
  const original = path.join(f.root, "outside.md");
  writeFileSync(original, "# Safe original\n## Must\n- Why?\n");
  const elsewhere = path.join(f.root, "elsewhere");
  mkdirSync(elsewhere);
  const current = path.join(f.workspace, "prep/current");
  rmSync(current, { recursive: true });
  symlinkSync(elsewhere, current);
  const before = f.service.getSnapshot();
  await request(
    createApp({ service: f.service, choosePrep: async () => original }),
  )
    .post("/api/workspace/prep/choose")
    .send({})
    .expect(409);
  expect(readdirSync(elsewhere)).toEqual([]);
  expect(f.service.getSnapshot()).toEqual(before);
});

it("native chooser authority writes the selected original through Save, then isolates active session edits", async () => {
  const f = fixture();
  const selected = path.join(f.root, "selected-original.md");
  writeFileSync(selected, "# Selected original\n## Must\n- Why?\n");
  const app = createApp({
    service: f.service,
    choosePrep: async () => selected,
  });
  const chosen = await request(app)
    .post("/api/workspace/prep/choose")
    .send({})
    .expect(200);
  const copy = path.join(
    f.workspace,
    "prep/current",
    chosen.body.workspace.selectedPrep,
  );
  const edit = async (text: string) => {
    const state = f.service.getSnapshot();
    await request(app)
      .post("/api/session/content")
      .send({
        sessionId: state.sessionId,
        revision: state.contentRevision ?? 0,
        mutationId: crypto.randomUUID(),
        section: "notes",
        text,
      })
      .expect(200);
  };
  const save = async () => {
    const state = f.service.getSnapshot();
    await request(app)
      .post("/api/session/save")
      .send({
        sessionId: state.sessionId,
        revision: state.contentRevision ?? 0,
      })
      .expect(200);
  };
  await edit("Before capture");
  await save();
  const before = readFileSync(selected, "utf8");
  expect(before).toContain("Before capture");
  expect(readFileSync(copy, "utf8")).toBe(before);
  expect(
    await f.service.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789",
    }),
  ).toMatchObject({ ok: true });
  await edit("During capture");
  await save();
  expect(readFileSync(selected, "utf8")).toBe(before);
  expect(readFileSync(copy, "utf8")).toBe(before);
  expect(f.service.getSnapshot().notes.map((x) => x.text)).toEqual([
    "Before capture",
    "During capture",
  ]);
  expect(f.service.getProviderCallCount()).toBe(0);
});

it.each([false, true])(
  "native preparation selection isolates A from B (saved B: %s)",
  async (savedB) => {
    const f = fixture();
    const a = path.join(f.root, "A.md");
    const b = path.join(f.root, "B.md");
    writeFileSync(a, "# A\n## Must\n- A question\n");
    writeFileSync(b, "# B\n## Must\n- B question\n");
    let selected = b;
    const app = createApp({
      service: f.service,
      choosePrep: async () => selected,
    });
    const choose = () =>
      request(app).post("/api/workspace/prep/choose").send({}).expect(200);
    const edit = async (section: string, text: string) => {
      const s = f.service.getSnapshot();
      await request(app)
        .post("/api/session/content")
        .send({
          sessionId: s.sessionId,
          revision: s.contentRevision,
          mutationId: crypto.randomUUID(),
          section,
          text,
        })
        .expect(200);
    };
    const save = async () => {
      const s = f.service.getSnapshot();
      await request(app)
        .post("/api/session/save")
        .send({ sessionId: s.sessionId, revision: s.contentRevision })
        .expect(200);
    };
    const populate = async (label: string) => {
      for (const section of ["notes", "questions", "revisit"])
        await edit(section, label + " " + section);
      await edit("metadata", JSON.stringify({ displayName: label }));
    };
    await choose();
    if (savedB) {
      await populate("B");
      await save();
    }
    const expected = f.service.getSnapshot();
    selected = a;
    await choose();
    await populate("A");
    await save();
    const originalA = readFileSync(a, "utf8");
    selected = b;
    const chosen = await choose();
    for (const key of ["notes", "questions", "revisit"] as const)
      expect(f.service.getSnapshot()[key]).toEqual(expected[key]);
    expect(f.service.getSnapshot().lifecycle.displayName).toEqual(
      expected.lifecycle.displayName,
    );
    await edit("notes", "B addition");
    await save();
    expect(readFileSync(a, "utf8")).toBe(originalA);
    const bytes = readFileSync(b, "utf8");
    expect(bytes).not.toContain("A notes");
    expect(bytes).toContain("B addition");
    expect(
      readFileSync(
        path.join(
          f.workspace,
          "prep/current",
          chosen.body.workspace.selectedPrep,
        ),
        "utf8",
      ),
    ).toBe(bytes);
    const final = f.service.getSnapshot();
    f.service.close();
    const restarted = new SessionService({
      topics: [],
      transcript: [],
      provider: new FakeMartyProvider(),
      repository: new FileSessionRepository(path.join(f.root, "private")),
      userWorkspaceRoot: f.workspace,
      initialCaptureMode: "live_ready",
    });
    services.push(restarted);
    for (const key of [
      "notes",
      "questions",
      "revisit",
      "humanContext",
      "topics",
      "lifecycle",
    ] as const)
      expect(restarted.getSnapshot()[key]).toEqual(final[key]);
  },
);

it("keeps established simulation marks when selecting ordinary prep", () => {
  const f = fixture();
  f.service.close();
  const service = new SessionService({
    topics: [],
    transcript: [
      {
        id: "turn",
        providerEventId: "event",
        speakerId: "participant",
        speakerLabel: "Participant",
        text: "Synthetic turn",
        startedAtMs: 0,
        endedAtMs: 100,
        receivedAt: "2026-09-16T00:00:00.000Z",
        final: true,
      },
    ],
    provider: new FakeMartyProvider(),
    repository: new FileSessionRepository(path.join(f.root, "simulation")),
    userWorkspaceRoot: f.workspace,
  });
  services.push(service);
  service.controlSimulation("step");
  for (const section of ["notes", "questions", "revisit", "metadata"]) {
    const s = service.getSnapshot();
    service.editContent({
      sessionId: s.sessionId,
      revision: s.contentRevision ?? 0,
      mutationId: crypto.randomUUID(),
      section,
      text:
        section === "metadata"
          ? JSON.stringify({ displayName: "Simulation" })
          : "Established " + section,
    });
  }
  const before = service.getSnapshot();
  f.write("ordinary.json");
  service.selectPrep("ordinary.json");
  for (const key of [
    "notes",
    "questions",
    "revisit",
    "transcript",
    "lifecycle",
  ] as const)
    expect(service.getSnapshot()[key]).toEqual(before[key]);
});

it("displays exact original basenames across duplicate selections, restart and legacy bindings", async () => {
  const f = fixture();
  const names = [
    "tempy.md",
    "tempy.md",
    "tempy-0b05e323-59cd-4c44-a6b0-a94e00e38bbc.md",
  ];
  const copies: string[] = [];
  for (const [index, name] of names.entries()) {
    const dir = path.join(f.root, String(index));
    mkdirSync(dir);
    const original = path.join(dir, name);
    writeFileSync(original, `# Person ${index}\n## Must\n- Why?\n`);
    const result = await request(
      createApp({ service: f.service, choosePrep: async () => original }),
    )
      .post("/api/workspace/prep/choose")
      .send({})
      .expect(200);
    expect(result.body.workspace.selectedPrepDisplayName).toBe(name);
    copies.push(result.body.workspace.selectedPrep);
    expect(new Set(copies).size).toBe(copies.length);
    const repository = new FileSessionRepository(path.join(f.root, "private"));
    repository.load();
    expect(repository.getWorkspaceBinding()?.prepWriteTarget).toBe(
      realpathSync(original),
    );
    expect(repository.getWorkspaceBinding()?.prepSourceFile).toBe(
      copies.at(-1),
    );
  }
  f.service.close();
  const restarted = new SessionService({
    topics: [],
    transcript: [],
    provider: new FakeMartyProvider(),
    repository: new FileSessionRepository(path.join(f.root, "private")),
    userWorkspaceRoot: f.workspace,
    initialCaptureMode: "live_ready",
  });
  services.push(restarted);
  expect(restarted.getWorkspaceOverview()?.selectedPrepDisplayName).toBe(
    names.at(-1),
  );
  // Legacy/current-folder selection has no original-path authority. Never strip a suffix.
  restarted.selectPrep(copies[0]);
  expect(restarted.getWorkspaceOverview()?.selectedPrepDisplayName).toBe(
    copies[0],
  );
  expect(restarted.getWorkspaceOverview()?.selectedPrep).toBe(copies[0]);
});
