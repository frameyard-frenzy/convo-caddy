import {
  existsSync,
  readdirSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { relocateWorkspace } from "../../src/desktop/workspace-relocation.js";
import { createWorkspaceDialogPort } from "../../src/desktop/workspace-dialog.js";
import { resolveDesktopPaths } from "../../src/server/desktop/paths.js";
import {
  createDesktopPreferences,
  selectWorkspaceRoot,
  loadDesktopPreferences,
} from "../../src/server/desktop/preferences.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { createLiveSessionService } from "../../src/server/session-service.js";
import {
  initializeUserWorkspace,
  publishFinishedConversation,
  scanFinishedConversations,
} from "../../src/server/workspace/user-workspace.js";
import { createApp } from "../../src/server/app.js";
import * as workspaceMove from "../../src/server/desktop/workspace-move.js";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = realpathSync(
    mkdtempSync(path.join(tmpdir(), "caddy-relocation-")),
  );
  roots.push(base);
  const paths = resolveDesktopPaths({
    applicationSupportDirectory: path.join(base, "support"),
    logsDirectory: path.join(base, "logs"),
  });
  createDesktopPreferences(paths);
  const from = path.join(base, "from"),
    to = path.join(base, "to");
  mkdirSync(from);
  mkdirSync(to);
  const root = selectWorkspaceRoot(paths, from).workspaceRoot!;
  initializeUserWorkspace(root);
  const service = createLiveSessionService({
    repository: new FileSessionRepository(paths.applicationRoot),
    userWorkspaceRoot: root,
  });
  writeFileSync(
    path.join(root, "prep/current/example.md"),
    "# Example\n## Must\n- Why?",
  );
  service.selectPrep("example.md");
  return { base, paths, root, to, service };
}
it("native cancel and declined exact destination confirmation are nonmutating", async () => {
  const f = fixture();
  const before = readFileSync(f.paths.preferencesFile, "utf8");
  await relocateWorkspace(f.paths, f.service, {
    chooseWorkspace: async () => null,
  });
  const confirmMove = vi.fn(async () => false);
  await relocateWorkspace(f.paths, f.service, {
    chooseWorkspace: async () => f.to,
    confirmMove,
  });
  expect(confirmMove).toHaveBeenCalledWith(
    f.root,
    path.join(f.to, "Convo Caddy Workspace"),
  );
  expect(readFileSync(f.paths.preferencesFile, "utf8")).toBe(before);
  await request(createApp({ service: f.service }))
    .post("/api/workspace/prep/select")
    .send({ basename: "example.md" })
    .expect(200);
  f.service.close();
});
it("serializes chooser/write operations and updates current UI, future exports and restart", async () => {
  const f = fixture();
  let release!: () => void;
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  const moving = relocateWorkspace(f.paths, f.service, {
    chooseWorkspace: async () => {
      await waiting;
      return f.to;
    },
    confirmMove: async () => true,
  });
  const app = createApp({ service: f.service });
  await request(app)
    .post("/api/workspace/prep/select")
    .send({ basename: "example.md" })
    .expect(409);
  await request(app).post("/api/session/content").send({}).expect(409);
  release();
  await moving;
  expect(() => f.service.beginWriteRequest()()).not.toThrow();
  const destination = loadDesktopPreferences(f.paths).workspaceRoot!;
  expect(f.service.getWorkspaceOverview()?.root).toBe(destination);
  expect(f.service.getWorkspaceOverview()?.selectedPrep).toBe("example.md");
  f.service.editContent({
    sessionId: f.service.getSnapshot().sessionId,
    mutationId: "after-move",
    revision: 0,
    section: "notes",
    text: "After move",
  });
  const selected = new FileSessionRepository(f.paths.applicationRoot).load()!;
  expect(selected.workspace?.workspaceRoot).toBe(destination);
  publishFinishedConversation({
    root: destination,
    state: f.service.getSnapshot(),
    prepSourceFile: "example.md",
    prepSourceBytes: selected.workspace!.prepSourceBytes,
    completedAt: new Date().toISOString(),
  });
  expect(scanFinishedConversations(destination).valid).toHaveLength(1);
  f.service.close();
});
it("blocks a move while a chooser/write is already unresolved", async () => {
  const f = fixture();
  const release = f.service.beginWriteRequest();
  await expect(
    relocateWorkspace(f.paths, f.service, {
      chooseWorkspace: async () => f.to,
    }),
  ).rejects.toThrow(/pending write/);
  release();
  f.service.close();
});
it("native confirmation names both paths, all contents, future exports and defaults to Cancel", async () => {
  const showMessageBox = vi.fn(async () => ({ response: 1 }));
  const dialog = createWorkspaceDialogPort(
    {},
    {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox,
    },
  );
  expect(await dialog.confirmMove?.("/synthetic/old", "/synthetic/new")).toBe(
    true,
  );
  expect(showMessageBox).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      defaultId: 0,
      cancelId: 0,
      detail: expect.stringMatching(
        /From: \/synthetic\/old.*\nTo: \/synthetic\/new[\s\S]*All files[\s\S]*Future finished/,
      ),
    }),
  );
});

// Inject faults inside the real filesystem adapter, through the production caller.
it.each(["verify", "retire"] as const)(
  "keeps application writes blocked after a %s failure until restart recovery",
  async (phase) => {
    const f = fixture();
    writeFileSync(
      path.join(f.root, "prep/current/second.md"),
      "# Second\n## Must\n- Next?",
    );
    const realMove = workspaceMove.moveWorkspace;
    vi.spyOn(workspaceMove, "moveWorkspace").mockImplementation(
      (paths, parent) =>
        realMove(paths, parent, {
          retiredEntry: () => {
            if (phase === "retire")
              throw new Error("Synthetic source retirement failure");
          },
          checkpoint: (at) => {
            if (at === phase && phase === "verify")
              throw new Error("Synthetic interrupted move");
          },
        }),
    );
    await expect
      .soft(
        relocateWorkspace(f.paths, f.service, {
          chooseWorkspace: async () => f.to,
          confirmMove: async () => true,
        }),
      )
      .rejects.toThrow(/Restart Caddy.*recovery/);
    const destination = path.join(f.to, "Convo Caddy Workspace");
    const authority = phase === "retire" ? destination : f.root;
    expect(f.service.getWorkspaceRoot()).toBe(authority);
    const before = f.service.getSnapshot();
    const names = readdirSync(path.join(authority, "prep/current"));
    const app = createApp({ service: f.service });
    for (const [route, body] of [
      ["/api/workspace/prep/select", { basename: "second.md" }],
      ["/api/workspace/prep/choose", {}],
      ["/api/session/finish-saving", {}],
      [
        "/api/session/content",
        {
          sessionId: before.sessionId,
          mutationId: "blocked",
          revision: 0,
          section: "notes",
          text: "Retain my draft",
        },
      ],
      ["/api/session/topics/prep-1/check", { checked: true }],
      [
        "/api/capture/recall/start",
        { meetingUrl: "https://teams.live.com/meet/123456789" },
      ],
    ] as const) {
      const response = await request(app).post(route).send(body).expect(409);
      expect(response.body.error).toMatch(/Restart Caddy.*recovery/);
      expect(response.body.error).toContain("Keep your draft");
    }
    expect(f.service.getSnapshot()).toEqual(before);
    expect(readdirSync(path.join(authority, "prep/current"))).toEqual(names);
    expect(scanFinishedConversations(authority).valid).toHaveLength(0);
    f.service.close();
    expect(workspaceMove.recoverWorkspaceMove(f.paths)).toBe(destination);
    expect(existsSync(f.root)).toBe(false);
    expect(
      existsSync(path.join(f.paths.configDirectory, "workspace-move.json")),
    ).toBe(false);
    const restarted = createLiveSessionService({
      repository: new FileSessionRepository(f.paths.applicationRoot),
      userWorkspaceRoot: destination,
    });
    await request(createApp({ service: restarted }))
      .post("/api/workspace/prep/select")
      .send({ basename: "second.md" })
      .expect(200);
    const binding = new FileSessionRepository(f.paths.applicationRoot).load()!
      .workspace!;
    publishFinishedConversation({
      root: destination,
      state: restarted.getSnapshot(),
      prepSourceFile: binding.prepSourceFile,
      prepSourceBytes: binding.prepSourceBytes,
      completedAt: new Date().toISOString(),
    });
    expect(scanFinishedConversations(destination).valid).toHaveLength(1);
    restarted.close();
  },
);

it("a rejected destination without a journal releases writes normally", async () => {
  const f = fixture();
  mkdirSync(path.join(f.to, "Convo Caddy Workspace"));
  await expect(
    relocateWorkspace(f.paths, f.service, {
      chooseWorkspace: async () => f.to,
      confirmMove: async () => true,
    }),
  ).rejects.toThrow(/already exists/);
  await request(createApp({ service: f.service }))
    .post("/api/workspace/prep/select")
    .send({ basename: "example.md" })
    .expect(200);
  f.service.close();
});
