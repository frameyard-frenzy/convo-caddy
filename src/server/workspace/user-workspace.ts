import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  lstatSync,
  fstatSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sessionStateSchema } from "../../domain/session-state-schema.js";
import type { PreparedTopic, SessionState } from "../../domain/types.js";
import { atomicWriteText } from "../persistence/atomic-write.js";
import {
  prepSchema,
  parsePrep,
  prepExtension,
  renderPrepMarkdown,
  MAX_PREP_BYTES,
  type InterviewPrep,
} from "./prep-format.js";
export { prepSchema, type InterviewPrep } from "./prep-format.js";
import { renderInterview } from "../export/render-interview.js";

export const PREP_TEMPLATE = {
  schemaVersion: 1 as const,
  title: "Interview prep",
  personSummary: ["Add human-supplied background about the person here."],
  plannedDurationMinutes: 30,
  topics: [
    {
      tier: "must" as const,
      text: "Tell me about the last time this happened.",
    },
    { tier: "more" as const, text: "What made that difficult?" },
  ],
};

export function templateTopics(): PreparedTopic[] {
  return PREP_TEMPLATE.topics.map((topic, index) => ({
    id: `prep-${index + 1}`,
    tier: topic.tier,
    text: topic.text,
    checked: false,
  }));
}

export type PrepFile = {
  basename: string;
  prep: InterviewPrep;
  sourceBytes: string;
};
export type ScanError = { basename: string; error: string };
export type FinishedRecord = {
  name: string;
  directory: string;
  manifest: FinishedManifest;
  conversation: {
    schemaVersion: 1;
    completedAt: string;
    session: SessionState;
  };
  markdown: string;
  files: string[];
};

const BASE_FILES = [
  "manifest.json",
  "conversation.json",
  "conversation.md",
] as const;
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  prepSourceFile: z.string().min(1),
  files: z.tuple([
    z.literal("manifest.json"),
    z.literal("conversation.json"),
    z.literal("conversation.md"),
    z.enum(["prep.md", "prep.json"]),
  ]),
});
type FinishedManifest = z.infer<typeof manifestSchema>;
const conversationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  completedAt: z.iso.datetime(),
  session: sessionStateSchema,
});

export function initializeUserWorkspace(selectedRoot: string): {
  root: string;
} {
  if (!path.isAbsolute(selectedRoot))
    throw new Error("Workspace path must be absolute.");
  const root = path.resolve(selectedRoot);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(
      "The selected workspace is missing or unavailable. Make it available and try again.",
    );
  accessSync(root, constants.R_OK | constants.W_OK);
  mkdirSync(path.join(root, "prep", "current"), { recursive: true });
  mkdirSync(path.join(root, "prep", "archive"), { recursive: true });
  mkdirSync(path.join(root, "finished-conversations"), { recursive: true });
  const template = path.join(root, "prep", "TEMPLATE.md");
  try {
    writeFileSync(template, renderPrepMarkdown(PREP_TEMPLATE), { flag: "wx" });
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      )
    )
      throw error;
  }
  return { root };
}

export function scanPrep(root: string): {
  valid: PrepFile[];
  errors: ScanError[];
} {
  const current = path.join(root, "prep", "current");
  const valid: PrepFile[] = [];
  const errors: ScanError[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (
      !entry.isFile() ||
      ![".md", ".json"].includes(path.extname(entry.name).toLowerCase())
    )
      continue;
    try {
      valid.push(readPrep(root, entry.name));
    } catch (error) {
      errors.push({ basename: entry.name, error: prepError(error) });
    }
  }
  return { valid, errors };
}

export function readPrep(root: string, basename: string): PrepFile {
  const file = ["TEMPLATE.md", "TEMPLATE.json"].includes(basename)
    ? path.join(root, "prep", basename)
    : prepCurrentFile(root, basename);
  const sourceBytes = readPrepText(file);
  try {
    return {
      basename,
      prep: parsePrep(sourceBytes, basename),
      sourceBytes,
    };
  } catch (error) {
    throw new Error(
      `Prep ${basename} is malformed: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
}

export function savePrep(
  root: string,
  basename: string,
  prep: InterviewPrep,
  expectedSourceBytes: string | null,
): PrepFile {
  const file = prepCurrentFile(root, basename);
  if (expectedSourceBytes !== null) {
    let current: string;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      throw new Error(
        "Prep changed since it was opened. Refresh and try again.",
      );
    }
    if (current !== expectedSourceBytes)
      throw new Error(
        "Prep changed since it was opened. Refresh and try again.",
      );
  } else if (existsSync(file)) {
    throw new Error("A prep with that filename already exists.");
  }
  const parsed = prepSchema.parse(prep);
  atomicWriteText(
    file,
    prepExtension(basename) === ".md"
      ? renderPrepMarkdown(parsed)
      : serializeJson(parsed),
  );
  return readPrep(root, basename);
}

export function scanFinishedConversations(root: string): {
  valid: FinishedRecord[];
  errors: Array<{ name: string; error: string }>;
} {
  const finished = path.join(root, "finished-conversations");
  const valid: FinishedRecord[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  for (const entry of readdirSync(finished, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      valid.push(
        readFinishedRecord(path.join(finished, entry.name), entry.name),
      );
    } catch (error) {
      errors.push({
        name: entry.name,
        error:
          error instanceof Error
            ? error.message
            : "Malformed finished conversation.",
      });
    }
  }
  return { valid, errors };
}

export type PublishInput = {
  root: string;
  state: SessionState;
  prepSourceFile: string;
  prepSourceBytes: string;
  completedAt: string;
};
export type PublishHooks = {
  beforeFinalDirectoryPublished?: (directory: string) => void;
  afterFinalDirectoryPublished?: () => void;
  afterArchiveOpened?: (descriptor: number) => void;
  afterArchivePublished?: () => void;
};

export function publishFinishedConversation(
  input: PublishInput,
  hooks: PublishHooks = {},
) {
  const extension = prepExtension(input.prepSourceFile);
  parsePrep(input.prepSourceBytes, input.prepSourceFile);
  const prepFile = `prep${extension}` as const;
  const files = [...BASE_FILES, prepFile] as const;
  const prepName = safeName(
    path.basename(input.prepSourceFile, path.extname(input.prepSourceFile)),
  );
  const suffix = input.state.sessionId
    .replaceAll("-", "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-12);
  if (suffix.length !== 12)
    throw new Error("Session UUID cannot produce the required suffix.");
  const directoryName = `${compactUtc(input.state.startedAt)}-${prepName}-${suffix}`;
  const archiveFileName = `${compactUtc(input.completedAt)}-${prepName}-${suffix}${extension}`;
  const directory = path.join(
    input.root,
    "finished-conversations",
    directoryName,
  );
  const archiveFile = path.join(input.root, "prep", "archive", archiveFileName);
  const completedSession = completedState(
    input.state,
    input.completedAt,
    path.join("finished-conversations", directoryName),
  );
  const manifest: FinishedManifest = {
    schemaVersion: 1,
    sessionId: input.state.sessionId,
    startedAt: input.state.startedAt,
    completedAt: input.completedAt,
    prepSourceFile: input.prepSourceFile,
    files: [...files],
  };
  const contents: Record<string, string> = {
    "manifest.json": serializeJson(manifest),
    "conversation.json": serializeJson({
      schemaVersion: 1,
      completedAt: input.completedAt,
      session: completedSession,
    }),
    "conversation.md": renderInterview(completedSession),
    [prepFile]: input.prepSourceBytes,
  };
  if (existsSync(directory)) verifyExactDirectory(directory, contents);
  else {
    const staging = path.join(
      input.root,
      "finished-conversations",
      `.${directoryName}.tmp-${randomUUID()}`,
    );
    mkdirSync(staging);
    try {
      for (const name of files)
        writeFileSync(path.join(staging, name), contents[name], { flag: "wx" });
      hooks.beforeFinalDirectoryPublished?.(directory);
      if (existsSync(directory))
        throw new Error("Finished conversation collision.");
      renameSync(staging, directory);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  hooks.afterFinalDirectoryPublished?.();
  writeOrVerifyExclusive(
    archiveFile,
    input.prepSourceBytes,
    "Archived prep collision.",
    hooks.afterArchiveOpened,
  );
  hooks.afterArchivePublished?.();
  const sourceFile = prepCurrentFile(input.root, input.prepSourceFile);
  try {
    if (readFileSync(sourceFile, "utf8") === input.prepSourceBytes)
      unlinkSync(sourceFile);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return {
    directory,
    directoryName,
    archiveFile,
    archiveFileName,
    warning: existsSync(sourceFile)
      ? "The current prep changed and was left in place."
      : null,
  };
}

function readFinishedRecord(directory: string, name: string): FinishedRecord {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")),
  );
  const files = readdirSync(directory).sort();
  if (
    files.length !== 4 ||
    [...manifest.files].sort().some((file, index) => files[index] !== file)
  )
    throw new Error(
      "Finished record must contain exactly the four required files.",
    );
  for (const file of files)
    if (!lstatSync(path.join(directory, file)).isFile())
      throw new Error("Finished record contains a non-file entry.");
  const conversation = conversationSchema.parse(
    JSON.parse(readFileSync(path.join(directory, "conversation.json"), "utf8")),
  );
  if (
    manifest.sessionId !== conversation.session.sessionId ||
    manifest.startedAt !== conversation.session.startedAt ||
    manifest.completedAt !== conversation.completedAt ||
    conversation.session.lifecycle.finalization.state !== "complete" ||
    conversation.session.lifecycle.finalization.completedAt !==
      conversation.completedAt ||
    conversation.session.lifecycle.finalization.directory !==
      path.join("finished-conversations", name)
  )
    throw new Error("Finished record metadata is inconsistent.");
  if (
    readFileSync(path.join(directory, "conversation.md"), "utf8") !==
    renderInterview(conversation.session)
  )
    throw new Error("Finished record contents are inconsistent.");
  const prepBytes = readPrepText(path.join(directory, manifest.files[3]));
  if (`prep${prepExtension(manifest.prepSourceFile)}` !== manifest.files[3])
    throw new Error("Finished prep format is inconsistent.");
  parsePrep(prepBytes, manifest.files[3]);
  return {
    name,
    directory,
    manifest,
    conversation,
    markdown: readFileSync(path.join(directory, "conversation.md"), "utf8"),
    files: [...manifest.files],
  };
}

function verifyExactDirectory(
  directory: string,
  expected: Record<string, string>,
): void {
  const required = Object.keys(expected).sort();
  let files: string[];
  try {
    files = readdirSync(directory).sort();
  } catch {
    throw new Error("Finished conversation collision.");
  }
  if (
    files.length !== required.length ||
    required.some((file, i) => files[i] !== file)
  )
    throw new Error("Finished conversation collision.");
  for (const file of required)
    if (readFileSync(path.join(directory, file), "utf8") !== expected[file])
      throw new Error("Finished conversation collision.");
}

function writeOrVerifyExclusive(
  file: string,
  bytes: string,
  message: string,
  afterOpened?: (descriptor: number) => void,
): void {
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") !== bytes) throw new Error(message);
    return;
  }
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(file, "wx");
    created = true;
    afterOpened?.(descriptor);
    writeFileSync(descriptor, bytes);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(file) && readFileSync(file, "utf8") === bytes) return;
    if (created) {
      try {
        unlinkSync(file);
      } catch (cleanupError) {
        if (!isMissing(cleanupError))
          throw new AggregateError(
            [error, cleanupError],
            "Archived prep write failed and its incomplete file could not be removed.",
          );
      }
    }
    throw error;
  }
}

function completedState(
  state: SessionState,
  completedAt: string,
  directory: string,
): SessionState {
  const current = state.lifecycle.finalization;
  const startedAt =
    current.state === "finalizing" ||
    current.state === "needs_attention" ||
    current.state === "complete"
      ? current.startedAt
      : completedAt;
  return {
    ...state,
    lifecycle: {
      ...state.lifecycle,
      finalization: { state: "complete", startedAt, completedAt, directory },
    },
  };
}
function compactUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf()))
    throw new Error("Timestamp must be ISO-8601.");
  return date
    .toISOString()
    .replace(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*$/,
      "$1-$2-$3-$4$5$6Z",
    );
}
function safeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48)
      .replace(/-$/g, "") || "interview"
  );
}
function prepCurrentFile(root: string, basename: string): string {
  if (
    path.basename(basename) !== basename ||
    ![".md", ".json"].includes(path.extname(basename).toLowerCase())
  )
    throw new Error(
      "Prep filename must be a direct Markdown or legacy JSON child.",
    );
  return path.join(root, "prep", "current", basename);
}
function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function prepError(error: unknown): string {
  return error instanceof Error ? error.message : "Prep is malformed.";
}
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

// Only native dialog results may reach this reader from outside the workspace.
// Browser routes never accept a path. Read one bounded regular file without following a leaf link.
export function readPrepText(file: string): string {
  const before = lstatSync(file);
  if (!before.isFile() || before.size > MAX_PREP_BYTES)
    throw new Error("Choose a regular prep text file smaller than 256 KiB.");
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("Prep changed while opening; choose it again.");
    const buffer = Buffer.alloc(MAX_PREP_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(file);
    if (
      length > MAX_PREP_BYTES ||
      after.size !== length ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      !current.isFile()
    )
      throw new Error("Prep changed while reading; choose it again.");
    const bytes = buffer.subarray(0, length);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes))
      throw new Error("Save prep as UTF-8 text.");
    return text;
  } finally {
    closeSync(fd);
  }
}
export function snapshotNativePrep(root: string, file: string): PrepFile {
  if (!path.isAbsolute(file))
    throw new Error("The Open panel must return an absolute file path.");
  for (const directory of [
    path.join(root, "prep"),
    path.join(root, "prep/current"),
  ]) {
    if (!lstatSync(directory).isDirectory())
      throw new Error(
        "The prep/current folder must be a real workspace directory.",
      );
  }
  const extension = prepExtension(file);
  const sourceBytes = readPrepText(file);
  const prep = parsePrep(sourceBytes, file);
  const basename = `${safeName(path.basename(file, path.extname(file)))}-${randomUUID()}${extension}`;
  writeFileSync(prepCurrentFile(root, basename), sourceBytes, {
    flag: "wx",
    mode: 0o600,
  });
  return { basename, prep, sourceBytes };
}
