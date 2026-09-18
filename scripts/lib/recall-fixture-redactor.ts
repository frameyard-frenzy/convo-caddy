import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PARTICIPANT_RECORDING_NOTICE } from "../../src/domain/types.js";
import {
  atomicWriteText,
  ensurePrivateDirectory,
} from "../../src/server/persistence/atomic-write.js";

export type RedactRecallFixturesOptions = {
  inputDirectory: string;
  outputDirectory: string;
};

export type RedactRecallFixturesResult = {
  files: string[];
};

const SAFE_KEY = /^[a-z][a-z0-9_]*$/;
const SAFE_EVENT = /^[a-z][a-z0-9_.-]*$/;
const SAFE_TOKEN = /^[a-z][a-z0-9_.-]*$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REDACTED_TEAMS_URL =
  "https://teams.live.com/meet/1000000000000?p=redacted";

type FixtureCandidate = {
  filename: string;
  value: unknown;
};

type RedactionState = {
  stringIds: Map<string, string>;
  numericIds: Map<number, number>;
  timestamps: Map<string, string>;
  names: Map<string, string>;
  emails: Map<string, string>;
  genericStrings: Map<string, string>;
  textCount: number;
};

export function redactRecallFixtures(
  options: RedactRecallFixturesOptions,
): RedactRecallFixturesResult {
  const inputDirectory = path.resolve(options.inputDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);
  assertOutputIsEmpty(outputDirectory);
  const inputStat = lstatSync(inputDirectory);
  if (!inputStat.isDirectory() || inputStat.isSymbolicLink()) {
    throw new Error("Raw Recall fixture input must be a real directory.");
  }

  const sourceFiles = readdirSync(inputDirectory)
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  if (sourceFiles.length === 0) {
    throw new Error("No raw Recall JSON fixtures were found.");
  }

  const state = createRedactionState();
  const candidates = sourceFiles.map((filename, index) => {
    const sourcePath = path.join(inputDirectory, filename);
    const sourceStat = lstatSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error("Raw Recall fixtures must be regular files.");
    }
    const rawValue: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
    const redacted = redactValue(rawValue, [], state);
    return {
      filename: outputFilename(redacted, index),
      value: redacted,
    } satisfies FixtureCandidate;
  });

  ensurePrivateDirectory(outputDirectory);
  for (const candidate of candidates) {
    atomicWriteText(
      path.join(outputDirectory, candidate.filename),
      `${JSON.stringify(candidate.value, null, 2)}\n`,
    );
  }

  return { files: candidates.map((candidate) => candidate.filename) };
}

function createRedactionState(): RedactionState {
  return {
    stringIds: new Map(),
    numericIds: new Map(),
    timestamps: new Map(),
    names: new Map(),
    emails: new Map(),
    genericStrings: new Map(),
    textCount: 0,
  };
}

function redactValue(
  value: unknown,
  pathParts: string[],
  state: RedactionState,
): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  const key = pathParts.at(-1) ?? "";

  if (typeof value === "string") {
    return redactString(value, key, state);
  }
  if (typeof value === "number") {
    return isIdKey(key) ? mapNumericId(value, state) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, pathParts, state));
  }
  if (typeof value !== "object") {
    throw new Error(
      `Unsupported Recall fixture value at ${formatPath(pathParts)}.`,
    );
  }
  if (key === "metadata" || key === "extra_data") {
    return {};
  }

  const redacted: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (!SAFE_KEY.test(entryKey)) {
      throw new Error(
        `Unsafe provider object key beneath ${formatPath(pathParts)}.`,
      );
    }
    redacted[entryKey] = redactValue(
      entryValue,
      [...pathParts, entryKey],
      state,
    );
  }
  return redacted;
}

function redactString(
  value: string,
  key: string,
  state: RedactionState,
): string {
  if (key === "event") {
    if (!SAFE_EVENT.test(value)) {
      throw new Error("Unsafe Recall event name.");
    }
    return value;
  }
  if (key === "bot_name") {
    return "Convo Caddy";
  }
  if (value === PARTICIPANT_RECORDING_NOTICE) {
    return value;
  }
  if (key === "meeting_url") {
    return REDACTED_TEAMS_URL;
  }
  if (key === "url" || key.endsWith("_url")) {
    return "https://example.invalid/redacted";
  }
  if (isIdKey(key)) {
    return mapStringId(value, state);
  }
  if (key === "name") {
    return mapValue(value, state.names, "Speaker ");
  }
  if (key === "email") {
    const speaker = mapValue(value, state.emails, "");
    return `speaker-${speaker}@example.invalid`;
  }
  if (key === "text" || key === "message") {
    state.textCount += 1;
    return `synthetic fixture utterance ${state.textCount}`;
  }
  if (ISO_TIMESTAMP.test(value)) {
    return mapTimestamp(value, state);
  }
  if (
    [
      "code",
      "sub_code",
      "status",
      "platform",
      "language_code",
      "mode",
      "type",
      "kind",
      "variant",
    ].includes(key)
  ) {
    if (!SAFE_TOKEN.test(value)) {
      throw new Error(`Unsafe provider token at ${key}.`);
    }
    return value;
  }
  return mapValue(value, state.genericStrings, "redacted-string-");
}

function mapStringId(value: string, state: RedactionState): string {
  const existing = state.stringIds.get(value);
  if (existing) {
    return existing;
  }
  const suffix = String(state.stringIds.size + 1).padStart(12, "0");
  const redacted = `00000000-0000-4000-8000-${suffix}`;
  state.stringIds.set(value, redacted);
  return redacted;
}

function mapNumericId(value: number, state: RedactionState): number {
  const existing = state.numericIds.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const redacted = 1001 + state.numericIds.size;
  state.numericIds.set(value, redacted);
  return redacted;
}

function mapTimestamp(value: string, state: RedactionState): string {
  const existing = state.timestamps.get(value);
  if (existing) {
    return existing;
  }
  const epoch = Date.UTC(2026, 0, 1, 0, 0, state.timestamps.size);
  const redacted = new Date(epoch).toISOString();
  state.timestamps.set(value, redacted);
  return redacted;
}

function mapValue(
  value: string,
  values: Map<string, string>,
  prefix: string,
): string {
  const existing = values.get(value);
  if (existing) {
    return existing;
  }
  const redacted = `${prefix}${values.size + 1}`;
  values.set(value, redacted);
  return redacted;
}

function isIdKey(key: string): boolean {
  return key === "id" || key.endsWith("_id");
}

function outputFilename(value: unknown, index: number): string {
  const event = eventName(value);
  const label = event ? event.replaceAll(/[._]/g, "-") : "create-bot-response";
  return `${String(index).padStart(3, "0")}-${label}.json`;
}

function eventName(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "event" in value &&
    typeof value.event === "string"
  ) {
    return value.event;
  }
  return null;
}

function assertOutputIsEmpty(outputDirectory: string): void {
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
    throw new Error("Redacted fixture output directory must be empty.");
  }
}

function formatPath(pathParts: string[]): string {
  return pathParts.length === 0 ? "<root>" : pathParts.join(".");
}
