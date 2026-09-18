import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveDesktopPaths } from "../../src/server/desktop/paths.js";
import {
  createDesktopPreferences,
  loadDesktopPreferences,
  selectWorkspaceRoot,
} from "../../src/server/desktop/preferences.js";
import { initializeUserWorkspace } from "../../src/server/workspace/user-workspace.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "workspace-correction-")),
  );
  roots.push(root);
  const support = path.join(root, "Library", "Application Support");
  const parent = path.join(root, "Documents");
  mkdirSync(parent);
  const paths = resolveDesktopPaths({
    applicationSupportDirectory: support,
    logsDirectory: path.join(root, "Library", "Logs"),
  });
  createDesktopPreferences(paths);
  writeFileSync(path.join(parent, "outside.txt"), "outside");
  return { root, parent, support, paths };
}
it("parent Documents creates a dedicated child and never scatters prep or changes siblings", () => {
  const f = fixture();
  const selected = selectWorkspaceRoot(f.paths, f.parent);
  expect(selected.workspaceRoot).toBe(
    path.join(f.parent, "Convo Caddy Workspace"),
  );
  initializeUserWorkspace(selected.workspaceRoot!);
  expect(readdirSync(f.parent).sort()).toEqual([
    "Convo Caddy Workspace",
    "outside.txt",
  ]);
  expect(readFileSync(path.join(f.parent, "outside.txt"), "utf8")).toBe(
    "outside",
  );
  expect(loadDesktopPreferences(f.paths)).toEqual(selected);
  expect(
    existsSync(path.join(selected.workspaceRoot!, "prep", "TEMPLATE.md")),
  ).toBe(true);
});
it("reinstall reuses an app-created workspace selected directly or through its parent", () => {
  const f = fixture();
  const selected = selectWorkspaceRoot(f.paths, f.parent);
  expect(selectWorkspaceRoot(f.paths, f.parent)).toEqual(selected);
  expect(selectWorkspaceRoot(f.paths, selected.workspaceRoot!)).toEqual(
    selected,
  );
  expect(
    existsSync(path.join(selected.workspaceRoot!, "Convo Caddy Workspace")),
  ).toBe(false);
});
it.each([false, true])(
  "existing child never grants ownership even if empty: %s",
  (nonempty) => {
    const f = fixture();
    const child = path.join(f.parent, "Convo Caddy Workspace");
    mkdirSync(child);
    if (nonempty) writeFileSync(path.join(child, "mine"), "mine");
    expect(() => selectWorkspaceRoot(f.paths, f.parent)).toThrow(
      /already exists|collision/i,
    );
    expect(loadDesktopPreferences(f.paths).workspaceRoot).toBeNull();
    expect(readdirSync(child)).toEqual(nonempty ? ["mine"] : []);
  },
);
it("copied ownership marker cannot adopt another folder", () => {
  const f = fixture();
  const selected = selectWorkspaceRoot(f.paths, f.parent);
  const other = path.join(f.root, "Other");
  mkdirSync(other);
  cpSync(selected.workspaceRoot!, path.join(other, "Convo Caddy Workspace"), {
    recursive: true,
  });
  expect(() => selectWorkspaceRoot(f.paths, other)).toThrow(
    /already exists|collision/i,
  );
});
it("Application Support and aliases are rejected before any content or preference mutation", () => {
  const f = fixture();
  const alias = path.join(f.root, "support-alias");
  symlinkSync(f.support, alias);
  const caseAlias = path.join(f.root, "library", "application support");
  const candidates = [
    f.support,
    f.paths.applicationRoot,
    path.join(f.support, "Convo Caddy Control"),
    alias,
  ];
  mkdirSync(candidates[2]!);
  if (existsSync(caseAlias)) candidates.push(caseAlias);
  for (const candidate of candidates) {
    const before = readdirSync(candidate);
    expect(() => selectWorkspaceRoot(f.paths, candidate)).toThrow(
      /outside.*Application Support/i,
    );
    expect(readdirSync(candidate)).toEqual(before);
    expect(loadDesktopPreferences(f.paths).workspaceRoot).toBeNull();
  }
});
it("old selected Documents remains ambiguous and is never automatically adopted", () => {
  const f = fixture();
  writeFileSync(
    f.paths.preferencesFile,
    JSON.stringify({ schemaVersion: 2, workspaceRoot: f.parent }),
  );
  expect(loadDesktopPreferences(f.paths).workspaceRoot).toBe(f.parent);
  expect(readdirSync(f.parent)).toEqual(["outside.txt"]);
});

it("rejects a private cache or saved-state parent before mutation", () => {
  const f = fixture();
  for (const relative of [
    "Caches/com.frameyard.convocaddy",
    "Saved Application State/com.frameyard.convocaddy.savedState",
  ]) {
    const parent = path.join(f.root, "Library", relative);
    mkdirSync(parent, { recursive: true });
    expect(() => selectWorkspaceRoot(f.paths, parent)).toThrow(
      /outside.*Application Support/i,
    );
    expect(readdirSync(parent)).toEqual([]);
  }
});
