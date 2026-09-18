import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  writeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DesktopPaths } from "./paths.js";
import {
  isDedicatedWorkspace,
  loadDesktopPreferences,
  requireSupportedWorkspace,
  WORKSPACE_MARKER,
} from "./preferences.js";
import {
  atomicWriteText,
  assertManagedPathHasNoSymlinks,
  syncDirectory,
} from "../persistence/atomic-write.js";
import {
  FileSessionRepository,
  rebaseWorkspaceBinding,
} from "../persistence/file-session-repository.js";

const entrySchema = z.strictObject({
  name: z
    .string()
    .refine(
      (name) =>
        name !== "" &&
        !path.isAbsolute(name) &&
        name
          .split(path.sep)
          .every((part) => part !== "." && part !== ".." && part !== ""),
    ),
  kind: z.enum(["file", "directory", "link"]),
  mode: z.number().int(),
  value: z.string(),
  attributes: z.record(z.string(), z.string()).optional(),
});
const journalSchema = z.strictObject({
  version: z.literal(1),
  source: z.string().refine(path.isAbsolute),
  destination: z.string().refine(path.isAbsolute),
  rootAttributes: z.record(z.string(), z.string()).optional(),
  sourceIdentity: z.string(),
  destinationIdentity: z.string(),
  phase: z.enum(["copy", "verified", "switched", "retiring"]),
  entries: z.array(entrySchema),
});
type Entry = z.infer<typeof entrySchema>;
type Journal = z.infer<typeof journalSchema>;
export type MoveHooks = {
  retiredEntry?: () => void;
  checkpoint?: (phase: "copy" | "verify" | "switch" | "retire") => void;
  copyFile?: (source: string, destination: string) => void;
};
const journalFile = (paths: DesktopPaths) =>
  path.join(paths.configDirectory, "workspace-move.json");
const inside = (root: string, file: string) =>
  file === root || file.startsWith(`${root}${path.sep}`);
const identity = (root: string) => {
  const s = statSync(root, { bigint: true });
  return `${s.dev}:${s.ino}`;
};

export function workspaceMoveDestination(
  paths: DesktopPaths,
  source: string,
  parent: string,
): string {
  if (!path.isAbsolute(parent))
    throw new Error("Choose an absolute workspace parent.");
  const canonical = realpathSync(parent);
  requireSupportedWorkspace(paths, canonical);
  const destination = path.join(canonical, "Convo Caddy Workspace");
  if (
    inside(source, destination) ||
    inside(destination, source) ||
    inside(source, canonical)
  )
    throw new Error("Choose a different parent outside the current workspace.");
  if (existsSync(destination) || safeLstat(destination))
    throw new Error(
      "The destination already exists. Choose another parent; folders are never merged or overwritten.",
    );
  if (!isDedicatedWorkspace(source))
    throw new Error("The source workspace ownership could not be verified.");
  return destination;
}
export function moveWorkspace(
  paths: DesktopPaths,
  parent: string,
  hooks: MoveHooks = {},
): string {
  if (existsSync(journalFile(paths)))
    throw new Error(
      "An interrupted workspace move needs recovery. Restart Caddy before moving again.",
    );
  const source = loadDesktopPreferences(paths).workspaceRoot;
  if (!source) throw new Error("Choose a workspace before moving it.");
  assertManagedPathHasNoSymlinks(source, path.parse(source).root);
  const destination = workspaceMoveDestination(paths, source, parent);
  const entries = inventory(source);
  mkdirSync(destination, { mode: 0o700 });
  writeMarker(destination);
  const journal: Journal = {
    version: 1,
    source,
    destination,
    rootAttributes: readAttributes(source),
    sourceIdentity: identity(source),
    destinationIdentity: identity(destination),
    phase: "copy",
    entries,
  };
  saveJournal(paths, journal);
  return completeMove(paths, journal, hooks);
}
export const WORKSPACE_MOVE_RECOVERY_MESSAGE =
  "Workspace move is incomplete. Writes are paused to preserve recovery. Keep your draft and both workspace folders. Restart Caddy to attempt recovery; if it still fails, keep the error for reviewed recovery.";
export function hasPendingWorkspaceMove(paths: DesktopPaths): boolean {
  return existsSync(journalFile(paths));
}
export function recoverWorkspaceMove(paths: DesktopPaths): string | null {
  if (!hasPendingWorkspaceMove(paths)) return null;
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(journalFile(paths), "utf8")),
  );
  return completeMove(paths, journal, {});
}
function completeMove(
  paths: DesktopPaths,
  journal: Journal,
  hooks: MoveHooks,
): string {
  const { source, destination, entries } = journal;
  if (inside(source, destination) || inside(destination, source))
    throw new Error("Unsafe workspace recovery paths.");
  requireSupportedWorkspace(paths, destination);
  assertManagedPathHasNoSymlinks(destination, path.parse(destination).root);
  if (
    identity(destination) !== journal.destinationIdentity ||
    !isDedicatedWorkspace(destination)
  )
    throw new Error(
      "The move destination changed. Original contents were preserved.",
    );
  const selected = loadDesktopPreferences(paths).workspaceRoot;
  if (selected !== source && selected !== destination)
    throw new Error("Workspace preferences changed during recovery.");
  if (journal.phase === "copy" || journal.phase === "verified") {
    verifySource(journal, false);
    if (journal.phase === "copy") {
      hooks.checkpoint?.("copy");
      for (const entry of entries) {
        const target = path.join(destination, entry.name);
        assertManagedPathHasNoSymlinks(path.dirname(target), destination);
        const existing = safeLstat(target);
        if (existing) {
          if (!matches(destination, entry, source, destination))
            throw new Error(
              "Partial destination differs. Original workspace is preserved; keep both folders for recovery.",
            );
          continue;
        }
        if (entry.kind === "directory")
          mkdirSync(target, { mode: entry.mode | 0o700 });
        else if (entry.kind === "link")
          symlinkSync(rebaseLink(entry.value, source, destination), target);
        else {
          (hooks.copyFile ?? copyRegularFile)(
            path.join(source, entry.name),
            target,
          );
          chmodSync(target, entry.mode);
          const fd = openSync(
            target,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      }
      for (const entry of [...entries].reverse()) {
        if (entry.kind === "directory")
          chmodSync(path.join(destination, entry.name), entry.mode);
        copyAttributes(
          path.join(source, entry.name),
          path.join(destination, entry.name),
        );
      }
      copyAttributes(source, destination);
      hooks.checkpoint?.("verify");
      verifySource(journal, false);
      verifyDestination(journal);
      for (const entry of [...entries].reverse())
        if (entry.kind === "directory")
          syncDirectory(path.join(destination, entry.name));
      syncDirectory(destination);
      syncDirectory(path.dirname(destination));
      journal.phase = "verified";
      saveJournal(paths, journal);
    }
    verifyDestination(journal);
    switchReferences(paths, source, destination);
    journal.phase = "switched";
    saveJournal(paths, journal);
    hooks.checkpoint?.("switch");
  }
  verifyDestination(journal);
  // Once references have switched, the destination is authoritative. A changed
  // source is never deleted; the journal keeps the exact remaining recovery work.
  if (journal.phase === "switched") {
    verifySource(journal, false);
    journal.phase = "retiring";
    saveJournal(paths, journal);
  }
  hooks.checkpoint?.("retire");
  if (existsSync(source)) {
    verifySource(journal, true);
    for (const entry of [...entries].reverse()) {
      const target = path.join(source, entry.name);
      if (!safeLstat(target)) continue;
      assertManagedPathHasNoSymlinks(path.dirname(target), source);
      if (!matches(source, entry, source, source))
        throw new Error(
          "Source changed during retirement; both copies were preserved.",
        );
      if (entry.kind === "directory") rmdirSync(target);
      else unlinkSync(target);
      hooks.retiredEntry?.();
    }
    const marker = path.join(source, WORKSPACE_MARKER);
    if (existsSync(marker)) unlinkSync(marker);
    rmdirSync(source);
    syncDirectory(path.dirname(source));
  }
  unlinkSync(journalFile(paths));
  syncDirectory(paths.configDirectory);
  return destination;
}
function switchReferences(
  paths: DesktopPaths,
  source: string,
  destination: string,
): void {
  const repository = new FileSessionRepository(paths.applicationRoot);
  const checkpoint = repository.load();
  if (checkpoint?.workspace) {
    if (![source, destination].includes(checkpoint.workspace.workspaceRoot))
      throw new Error("Active interview belongs to a different workspace.");
    repository.setWorkspaceBinding(
      rebaseWorkspaceBinding(checkpoint.workspace, source, destination),
    );
    repository.save(checkpoint.state, checkpoint.mutations);
  }
  atomicWriteText(
    paths.preferencesFile,
    JSON.stringify({ schemaVersion: 2, workspaceRoot: destination }) + "\n",
  );
}
function verifySource(journal: Journal, partial: boolean): void {
  assertManagedPathHasNoSymlinks(
    journal.source,
    path.parse(journal.source).root,
  );
  if (identity(journal.source) !== journal.sourceIdentity)
    throw new Error("Source workspace changed.");
  if (
    !isDeepStrictEqual(readAttributes(journal.source), journal.rootAttributes)
  )
    throw new Error("Source folder metadata changed.");
  const current = inventory(journal.source);
  const expected = new Map(journal.entries.map((entry) => [entry.name, entry]));
  if (
    (!partial && current.length !== expected.size) ||
    current.some((entry) => !isDeepStrictEqual(entry, expected.get(entry.name)))
  )
    throw new Error(
      "Source contents changed; cannot verify move. The original was preserved.",
    );
}
function verifyDestination(journal: Journal): void {
  if (
    !isDeepStrictEqual(
      readAttributes(journal.destination),
      journal.rootAttributes,
    )
  )
    throw new Error("Destination folder metadata could not be verified.");
  const current = inventory(journal.destination);
  const expected = journal.entries.map((entry) =>
    entry.kind === "link"
      ? {
          ...entry,
          value: rebaseLink(entry.value, journal.source, journal.destination),
        }
      : entry,
  );
  if (!isDeepStrictEqual(current, expected))
    throw new Error(
      "Destination verification failed. Source retirement was not completed.",
    );
}
function inventory(root: string): Entry[] {
  const entries: Entry[] = [];
  function walk(directory: string): void {
    assertManagedPathHasNoSymlinks(directory, root);
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file);
      if (relative === WORKSPACE_MARKER) continue;
      const s = lstatSync(file);
      const mode = s.mode & 0o777;
      const attributes = readAttributes(file);
      if (s.isSymbolicLink())
        entries.push({
          ...(attributes ? { attributes } : {}),
          name: relative,
          kind: "link",
          mode,
          value: readlinkSync(file),
        });
      else if (s.isDirectory()) {
        entries.push({
          name: relative,
          kind: "directory",
          mode,
          value: "",
          ...(attributes ? { attributes } : {}),
        });
        walk(file);
      } else if (s.isFile())
        entries.push({
          name: relative,
          kind: "file",
          mode,
          value: hash(file),
          ...(attributes ? { attributes } : {}),
        });
      else
        throw new Error(
          "Workspace contains a special filesystem entry; move stopped without retiring the source.",
        );
    }
  }
  walk(root);
  return entries;
}
function matches(
  root: string,
  entry: Entry,
  source: string,
  destination: string,
): boolean {
  const file = path.join(root, entry.name),
    s = lstatSync(file);
  if (entry.kind === "directory") return s.isDirectory();
  if (entry.kind === "link")
    return (
      s.isSymbolicLink() &&
      readlinkSync(file) === rebaseLink(entry.value, source, destination)
    );
  return (
    s.isFile() && (s.mode & 0o777) === entry.mode && hash(file) === entry.value
  );
}
function hash(file: string): string {
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(128 * 1024);
    if (!fstatSync(fd).isFile())
      throw new Error("Workspace file changed type.");
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      digest.update(buffer.subarray(0, count));
    }
    return digest.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function rebaseLink(
  value: string,
  source: string,
  destination: string,
): string {
  return path.isAbsolute(value) && inside(source, value)
    ? path.join(destination, path.relative(source, value))
    : value;
}
function safeLstat(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function writeMarker(root: string): void {
  const s = statSync(root, { bigint: true });
  const fd = openSync(path.join(root, WORKSPACE_MARKER), "wx", 0o600);
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({ schemaVersion: 1, application: "com.frameyard.convocaddy", device: String(s.dev), inode: String(s.ino) })}\n`,
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(root);
}

function saveJournal(paths: DesktopPaths, journal: Journal): void {
  atomicWriteText(journalFile(paths), JSON.stringify(journal) + "\n");
}

function copyRegularFile(source: string, destination: string): void {
  if (process.platform === "darwin") {
    // macOS cp preserves resource forks and extended attributes. -P copies a
    // replaced leaf link as a link, never its target; verification then refuses it.
    execFileSync("/bin/cp", ["-pPn", source, destination], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return;
  }
  const input = openSync(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let output: number | undefined;
  try {
    if (!fstatSync(input).isFile())
      throw new Error("Workspace entry changed while copying.");
    output = openSync(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.alloc(128 * 1024);
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      let written = 0;
      while (written < count) {
        const size = writeSync(output, buffer, written, count - written);
        if (!size) throw new Error("Partial workspace write.");
        written += size;
      }
    }
    fsyncSync(output);
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

function attributeNames(file: string): string[] {
  if (process.platform !== "darwin") return [];
  return execFileSync("/usr/bin/xattr", ["-s", file], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}
function attributeHex(file: string, name: string): string {
  return execFileSync("/usr/bin/xattr", ["-spx", name, file], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).replaceAll(/\s/g, "");
}
function readAttributes(file: string): Record<string, string> | undefined {
  const names = attributeNames(file);
  return names.length
    ? Object.fromEntries(
        names.map((name) => [
          name,
          createHash("sha256").update(attributeHex(file, name)).digest("hex"),
        ]),
      )
    : undefined;
}
function copyAttributes(source: string, destination: string): void {
  if (process.platform !== "darwin" || lstatSync(source).isFile()) return;
  for (const name of attributeNames(source))
    execFileSync(
      "/usr/bin/xattr",
      ["-swx", name, attributeHex(source, name), destination],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
}
