import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveDesktopPaths } from "../../src/server/desktop/paths.js";
import {
  createDesktopPreferences,
  selectWorkspaceRoot,
  loadDesktopPreferences,
  isDedicatedWorkspace,
} from "../../src/server/desktop/preferences.js";
import {
  moveWorkspace,
  recoverWorkspaceMove,
  workspaceMoveDestination,
} from "../../src/server/desktop/workspace-move.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { initializeUserWorkspace } from "../../src/server/workspace/user-workspace.js";
import { createLiveSessionService } from "../../src/server/session-service.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "caddy-move-")));
  roots.push(base);
  const paths = resolveDesktopPaths({
    applicationSupportDirectory: path.join(base, "Library/Application Support"),
    logsDirectory: path.join(base, "Library/Logs"),
  });
  createDesktopPreferences(paths);
  const from = path.join(base, "from"),
    to = path.join(base, "to");
  mkdirSync(from);
  mkdirSync(to);
  const source = selectWorkspaceRoot(paths, from).workspaceRoot!;
  initializeUserWorkspace(source);
  writeFileSync(path.join(source, ".unknown"), "arbitrary\0bytes");
  mkdirSync(path.join(source, "user folder"));
  writeFileSync(path.join(source, "user folder/file"), "preserve");
  writeFileSync(path.join(base, "outside"), "external");
  symlinkSync(path.join(base, "outside"), path.join(source, "external-link"));
  symlinkSync(
    path.join(source, "user folder/file"),
    path.join(source, "internal-link"),
  );
  writeFileSync(
    path.join(source, "prep/current/case.md"),
    "# Synthetic\n## Must\n- Why?",
  );
  const service = createLiveSessionService({
    repository: new FileSessionRepository(paths.applicationRoot),
    userWorkspaceRoot: source,
  });
  service.selectPrep("case.md");
  service.close();
  return { base, paths, source, to };
}
it("copies all contents and rebases checkpoint, preferences, ownership and internal links before source retirement", () => {
  const f = fixture();
  const destination = workspaceMoveDestination(f.paths, f.source, f.to);
  moveWorkspace(f.paths, f.to);
  expect(existsSync(f.source)).toBe(false);
  expect(isDedicatedWorkspace(destination)).toBe(true);
  expect(readFileSync(path.join(destination, ".unknown"), "utf8")).toBe(
    "arbitrary\0bytes",
  );
  expect(readFileSync(path.join(destination, "user folder/file"), "utf8")).toBe(
    "preserve",
  );
  expect(readlinkSync(path.join(destination, "internal-link"))).toBe(
    path.join(destination, "user folder/file"),
  );
  expect(readFileSync(path.join(f.base, "outside"), "utf8")).toBe("external");
  expect(loadDesktopPreferences(f.paths).workspaceRoot).toBe(destination);
  expect(
    new FileSessionRepository(f.paths.applicationRoot).load()?.workspace
      ?.workspaceRoot,
  ).toBe(destination);
  const restored = createLiveSessionService({
    repository: new FileSessionRepository(f.paths.applicationRoot),
    userWorkspaceRoot: destination,
  });
  expect(restored.getWorkspaceOverview()?.selectedPrep).toBe("case.md");
  restored.close();
});
it.each(["copy", "verify", "switch", "retire"] as const)(
  "recovers interruption at %s with one verified authoritative root",
  (phase) => {
    const f = fixture();
    let interrupted = false;
    expect(() =>
      moveWorkspace(f.paths, f.to, {
        checkpoint: (point) => {
          if (point === phase && !interrupted) {
            interrupted = true;
            throw new Error("interrupted");
          }
        },
      }),
    ).toThrow("interrupted");
    if (phase === "copy" || phase === "verify")
      expect(readFileSync(path.join(f.source, ".unknown"), "utf8")).toBe(
        "arbitrary\0bytes",
      );
    const destination = recoverWorkspaceMove(f.paths)!;
    expect(destination).toBe(path.join(f.to, "Convo Caddy Workspace"));
    expect(readFileSync(path.join(destination, ".unknown"), "utf8")).toBe(
      "arbitrary\0bytes",
    );
    expect(loadDesktopPreferences(f.paths).workspaceRoot).toBe(destination);
    expect(existsSync(f.source)).toBe(false);
  },
);
it("rejects same/nested/conflicting/unsafe/unavailable destinations before mutation", () => {
  for (const mode of ["same", "nested", "conflict", "unsafe", "missing"]) {
    const f = fixture();
    let parent = f.to;
    if (mode === "same") parent = path.dirname(f.source);
    if (mode === "nested") {
      parent = path.join(f.source, "nested");
      mkdirSync(parent);
    }
    if (mode === "conflict") {
      mkdirSync(path.join(parent, "Convo Caddy Workspace"));
      writeFileSync(path.join(parent, "Convo Caddy Workspace/mine"), "mine");
    }
    if (mode === "unsafe") parent = f.paths.applicationRoot;
    if (mode === "missing") parent = path.join(f.base, "missing");
    expect(() => moveWorkspace(f.paths, parent)).toThrow();
    expect(loadDesktopPreferences(f.paths).workspaceRoot).toBe(f.source);
    expect(isDedicatedWorkspace(f.source)).toBe(true);
  }
});
it("partial write and source changes never retire the original", () => {
  const f = fixture();
  expect(() =>
    moveWorkspace(f.paths, f.to, {
      checkpoint: (point) => {
        if (point === "verify") {
          writeFileSync(path.join(f.source, ".unknown"), "new source bytes");
          throw new Error("disk unavailable");
        }
      },
    }),
  ).toThrow();
  expect(() => recoverWorkspaceMove(f.paths)).toThrow(/changed|verify/i);
  expect(readFileSync(path.join(f.source, ".unknown"), "utf8")).toBe(
    "new source bytes",
  );
  expect(loadDesktopPreferences(f.paths).workspaceRoot).toBe(f.source);
});

it("a failed cross-volume copy retains source, preferences and recoverable partial destination", () => {
  const f = fixture();
  let attempted = false;
  expect(() =>
    moveWorkspace(f.paths, f.to, {
      copyFile: (_source, target) => {
        attempted = true;
        writeFileSync(target, "partial");
        throw Object.assign(new Error("ENOSPC injected at file copy"), {
          code: "ENOSPC",
        });
      },
    }),
  ).toThrow(/ENOSPC/);
  expect(attempted).toBe(true);
  expect(loadDesktopPreferences(f.paths).workspaceRoot).toBe(f.source);
  expect(readFileSync(path.join(f.source, ".unknown"), "utf8")).toBe(
    "arbitrary\0bytes",
  );
  expect(() => recoverWorkspaceMove(f.paths)).toThrow(/Partial destination/);
});

it.runIf(process.platform === "darwin")(
  "preserves macOS extended file contents and Finder metadata",
  async () => {
    const { execFileSync } = await import("node:child_process");
    const f = fixture();
    const file = path.join(f.source, "user folder/file");
    execFileSync("/usr/bin/xattr", [
      "-w",
      "com.frameyard.synthetic",
      "fixture metadata",
      file,
    ]);
    execFileSync("/usr/bin/xattr", [
      "-w",
      "com.frameyard.synthetic",
      "root metadata",
      f.source,
    ]);
    const destination = moveWorkspace(f.paths, f.to);
    expect(
      execFileSync(
        "/usr/bin/xattr",
        ["-p", "com.frameyard.synthetic", destination],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("root metadata");
    expect(
      execFileSync(
        "/usr/bin/xattr",
        [
          "-p",
          "com.frameyard.synthetic",
          path.join(destination, "user folder/file"),
        ],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("fixture metadata");
  },
);

it("resumes retirement after some original entries were already removed", () => {
  const f = fixture();
  expect(() =>
    moveWorkspace(f.paths, f.to, {
      retiredEntry: () => {
        throw new Error("power loss during delete");
      },
    }),
  ).toThrow(/power loss/);
  const destination = recoverWorkspaceMove(f.paths)!;
  expect(readFileSync(path.join(destination, "user folder/file"), "utf8")).toBe(
    "preserve",
  );
  expect(existsSync(f.source)).toBe(false);
});
it.runIf(process.platform === "darwin")(
  "refuses retirement if a copied extended attribute is missing",
  async () => {
    const { execFileSync } = await import("node:child_process");
    const f = fixture();
    execFileSync("/usr/bin/xattr", [
      "-w",
      "com.frameyard.synthetic",
      "keep",
      path.join(f.source, ".unknown"),
    ]);
    expect(() =>
      moveWorkspace(f.paths, f.to, {
        checkpoint: (phase) => {
          if (phase === "verify")
            execFileSync("/usr/bin/xattr", [
              "-d",
              "com.frameyard.synthetic",
              path.join(f.to, "Convo Caddy Workspace/.unknown"),
            ]);
        },
      }),
    ).toThrow(/verification/);
    expect(existsSync(f.source)).toBe(true);
  },
);

it.each(["inside", "outside"] as const)(
  "rebases a native prep write target %s the moved workspace and saves after restart",
  (location) => {
    const f = fixture();
    const target = path.join(
      location === "inside" ? f.source : f.base,
      "selected.md",
    );
    writeFileSync(target, "# Selected\n## Must\n- Why?\n");
    const service = createLiveSessionService({
      repository: new FileSessionRepository(f.paths.applicationRoot),
      userWorkspaceRoot: f.source,
    });
    service.selectNativePrep(target);
    service.close();
    const destination = moveWorkspace(f.paths, f.to);
    const actual =
      location === "inside" ? path.join(destination, "selected.md") : target;
    const restarted = createLiveSessionService({
      repository: new FileSessionRepository(f.paths.applicationRoot),
      userWorkspaceRoot: destination,
    });
    const state = restarted.getSnapshot();
    restarted.editContent({
      sessionId: state.sessionId,
      revision: state.contentRevision ?? 0,
      mutationId: "after-move",
      section: "notes",
      text: "After relocation",
    });
    restarted.saveCurrentContent({
      sessionId: state.sessionId,
      revision: restarted.getSnapshot().contentRevision ?? 0,
    });
    expect(readFileSync(actual, "utf8")).toContain("After relocation");
    if (location === "inside") expect(existsSync(target)).toBe(false);
    restarted.close();
  },
);
