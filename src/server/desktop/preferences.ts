import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  atomicWriteText,
  ensurePrivateDirectory,
} from "../persistence/atomic-write.js";
import type { DesktopPaths } from "./paths.js";

export const DESKTOP_PREFERENCES_SCHEMA_VERSION = 2;
const schema = z.strictObject({
  schemaVersion: z.literal(2),
  workspaceRoot: z.string().refine(path.isAbsolute).nullable(),
});
export type DesktopPreferences = z.infer<typeof schema>;
const DEFAULT: DesktopPreferences = { schemaVersion: 2, workspaceRoot: null };

export function createDesktopPreferences(
  paths: DesktopPaths,
): "created" | "existing" {
  ensurePrivateDirectory(paths.applicationRoot);
  ensurePrivateDirectory(paths.configDirectory);
  if (existsSync(paths.preferencesFile)) {
    loadDesktopPreferences(paths);
    return "existing";
  }
  write(paths, DEFAULT);
  return "created";
}
export function loadDesktopPreferences(
  paths: DesktopPaths,
): DesktopPreferences {
  if (!existsSync(paths.preferencesFile)) {
    createDesktopPreferences(paths);
    return DEFAULT;
  }
  try {
    const raw = JSON.parse(
      readFileSync(paths.preferencesFile, "utf8"),
    ) as unknown;
    const old = z.object({ schemaVersion: z.literal(1) }).safeParse(raw);
    return old.success ? DEFAULT : schema.parse(raw);
  } catch (error) {
    throw new Error("Desktop preferences are corrupted.", { cause: error });
  }
}
export function selectWorkspaceRoot(
  paths: DesktopPaths,
  selectedDirectory: string,
): DesktopPreferences {
  if (!path.isAbsolute(selectedDirectory))
    throw new Error("Workspace directory must be absolute.");
  accessSync(selectedDirectory, constants.R_OK | constants.W_OK);
  const parent = realpathSync(selectedDirectory);
  requireSupportedWorkspace(paths, parent);
  const workspaceRoot = createDedicatedWorkspace(parent);
  if (!statSync(workspaceRoot).isDirectory())
    throw new Error("Workspace destination must be a directory.");
  const preferences = schema.parse({ schemaVersion: 2, workspaceRoot });
  write(paths, preferences);
  return preferences;
}
// A copied marker is not ownership: it must identify this exact directory.
export const WORKSPACE_MARKER = ".convo-caddy-workspace.json";
const ownershipSchema = z.strictObject({
  schemaVersion: z.literal(1),
  application: z.literal("com.frameyard.convocaddy"),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
export function isDedicatedWorkspace(root: string): boolean {
  try {
    if (!lstatSync(root).isDirectory()) return false;
    const marker = path.join(root, WORKSPACE_MARKER);
    if (!lstatSync(marker).isFile()) return false;
    const value = ownershipSchema.parse(
      JSON.parse(readFileSync(marker, "utf8")),
    );
    const identity = statSync(root, { bigint: true });
    return (
      value.device === String(identity.dev) &&
      value.inode === String(identity.ino)
    );
  } catch {
    return false;
  }
}
function createDedicatedWorkspace(parent: string): string {
  if (isDedicatedWorkspace(parent)) return parent;
  const root = path.join(parent, "Convo Caddy Workspace");
  if (isDedicatedWorkspace(root)) return root;
  // Exclusive mkdir: even an empty existing folder belongs to somebody else.
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch {
    throw new Error(
      "Convo Caddy Workspace already exists without matching ownership. Choose another parent folder; existing contents were not adopted or changed.",
    );
  }
  const identity = statSync(root, { bigint: true });
  writeFileSync(
    path.join(root, WORKSPACE_MARKER),
    JSON.stringify({
      schemaVersion: 1,
      application: "com.frameyard.convocaddy",
      device: String(identity.dev),
      inode: String(identity.ino),
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return root;
}
export function requireSupportedWorkspace(
  paths: DesktopPaths,
  root: string,
): void {
  const library = path.dirname(path.dirname(paths.applicationRoot));
  const forbidden = [
    path.dirname(paths.applicationRoot),
    paths.logsDirectory,
    "/Library/Application Support",
    path.join(library, "Caches", "com.frameyard.convocaddy"),
    path.join(
      library,
      "Saved Application State",
      "com.frameyard.convocaddy.savedState",
    ),
  ];
  for (const boundary of forbidden) {
    if (!existsSync(boundary)) continue;
    const expected = statSync(boundary, { bigint: true });
    let current = realpathSync(root);
    for (;;) {
      const identity = statSync(current, { bigint: true });
      if (identity.dev === expected.dev && identity.ino === expected.ino)
        throw new Error(
          "Choose a workspace outside Application Support and Convo Caddy private state. Select a parent such as Documents; Caddy creates its own Convo Caddy Workspace folder there.",
        );
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}
function write(paths: DesktopPaths, value: DesktopPreferences): void {
  atomicWriteText(
    paths.preferencesFile,
    `${JSON.stringify(schema.parse(value), null, 2)}\n`,
  );
}
