import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sessionStateSchema } from "../../domain/session-state-schema.js";
import type { SessionState } from "../../domain/types.js";
import {
  parsePrep,
  prepSchema,
  MAX_PREP_BYTES,
  type InterviewPrep,
} from "../workspace/prep-format.js";
import { atomicWriteText } from "./atomic-write.js";

export type MutationReceipt = {
  mutationId: string;
  input: string;
  ok: boolean;
  kind: "accepted" | "invalid_input" | "provider_failure";
  error?: string;
};
export type ActiveWorkspaceBinding = {
  workspaceRoot: string;
  prep: InterviewPrep;
  prepSourceFile: string;
  prepSourceBytes: string;
  prepWriteTarget?: string;
  pendingPrepWrite?: { bytes: string };
  finalization?: {
    completedAt: string;
    directoryName: string;
    archiveFileName: string;
    namingVersion?: 1;
  };
};
export type PersistedSession = {
  state: SessionState;
  mutations: MutationReceipt[];
  workspace?: ActiveWorkspaceBinding | null;
};
export interface SessionRepository {
  readonly dataRoot: string;
  load(): PersistedSession | null;
  save(state: SessionState, mutations: MutationReceipt[]): void;
  getWorkspaceBinding?(): ActiveWorkspaceBinding | null;
  setWorkspaceBinding?(binding: ActiveWorkspaceBinding): void;
  clear?(): void;
}

const receiptSchema = z.strictObject({
  mutationId: z.string().min(1),
  input: z.string(),
  ok: z.boolean(),
  kind: z.enum(["accepted", "invalid_input", "provider_failure"]),
  error: z.string().min(1).optional(),
});
const bindingSchema = z.strictObject({
  workspaceRoot: z.string().refine(path.isAbsolute),
  prep: prepSchema,
  prepSourceFile: z.string().min(1),
  prepSourceBytes: z.string(),
  prepWriteTarget: z.string().refine(path.isAbsolute).optional(),
  pendingPrepWrite: z
    .strictObject({
      bytes: z
        .string()
        .refine((bytes) => Buffer.byteLength(bytes, "utf8") <= MAX_PREP_BYTES),
    })
    .optional(),
  finalization: z
    .strictObject({
      completedAt: z.iso.datetime(),
      directoryName: z.string().min(1),
      archiveFileName: z.string().min(1),
      namingVersion: z.literal(1).optional(),
    })
    .optional(),
});
const persistedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: sessionStateSchema,
  mutations: z.array(receiptSchema),
  workspace: bindingSchema.nullable(),
});

export class FileSessionRepository implements SessionRepository {
  readonly #dataRoot: string;
  readonly #sessionFile: string;
  #binding: ActiveWorkspaceBinding | null = null;
  constructor(dataRoot: string) {
    this.#dataRoot = path.resolve(dataRoot);
    this.#sessionFile = path.join(this.#dataRoot, "active-session.json");
  }
  get dataRoot(): string {
    return this.#dataRoot;
  }
  load(): PersistedSession | null {
    if (!existsSync(this.#sessionFile)) return null;
    try {
      const persisted = parsePersistedSession(
        readFileSync(this.#sessionFile, "utf8"),
      );
      this.#binding = persisted.workspace ?? null;
      return persisted;
    } catch (error) {
      throw new Error("Active session data is corrupted.", { cause: error });
    }
  }
  save(state: SessionState, mutations: MutationReceipt[]): void {
    atomicWriteText(
      this.#sessionFile,
      serializePersistedSession(state, mutations, this.#binding),
    );
  }
  getWorkspaceBinding(): ActiveWorkspaceBinding | null {
    return this.#binding ? structuredClone(this.#binding) : null;
  }
  setWorkspaceBinding(binding: ActiveWorkspaceBinding): void {
    this.#binding = structuredClone(binding);
  }
  clear(): void {
    if (existsSync(this.#sessionFile)) unlinkSync(this.#sessionFile);
    this.#binding = null;
  }
}

export function parsePersistedSession(contents: string): PersistedSession {
  const parsed = persistedSchema.parse(JSON.parse(contents));
  if (parsed.workspace) {
    if (
      path.basename(parsed.workspace.prepSourceFile) !==
        parsed.workspace.prepSourceFile ||
      ![".md", ".json"].includes(
        path.extname(parsed.workspace.prepSourceFile).toLowerCase(),
      )
    )
      throw new Error(
        "Prep source filename must be a direct Markdown or legacy JSON child.",
      );
    if (parsed.workspace.pendingPrepWrite)
      parsePrep(
        parsed.workspace.pendingPrepWrite.bytes,
        parsed.workspace.prepSourceFile,
      );
    let sourcePrep: InterviewPrep;
    try {
      sourcePrep = parsePrep(
        parsed.workspace.prepSourceBytes,
        parsed.workspace.prepSourceFile,
      );
    } catch (error) {
      throw new Error("Prep source bytes are malformed.", { cause: error });
    }
    if (JSON.stringify(sourcePrep) !== JSON.stringify(parsed.workspace.prep))
      throw new Error(
        "Prep source bytes do not match the parsed prep snapshot.",
      );
  }
  const ids = new Set<string>();
  for (const receipt of parsed.mutations) {
    if (ids.has(receipt.mutationId))
      throw new Error("Mutation IDs must be unique.");
    ids.add(receipt.mutationId);
    if ((receipt.kind === "accepted") !== receipt.ok)
      throw new Error("Mutation receipt outcome is inconsistent.");
  }
  return {
    state: parsed.state,
    mutations: parsed.mutations,
    workspace: parsed.workspace,
  };
}
export function serializePersistedSession(
  state: SessionState,
  mutations: MutationReceipt[],
  workspace: ActiveWorkspaceBinding | null = null,
): string {
  return `${JSON.stringify(persistedSchema.parse({ schemaVersion: 1, state, mutations, workspace }), null, 2)}\n`;
}

export function rebaseWorkspaceBinding(
  binding: ActiveWorkspaceBinding,
  source: string,
  destination: string,
): ActiveWorkspaceBinding {
  const relative = binding.prepWriteTarget
    ? path.relative(source, binding.prepWriteTarget)
    : null;
  return {
    ...binding,
    workspaceRoot: destination,
    ...(relative !== null &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
      ? { prepWriteTarget: path.join(destination, relative) }
      : {}),
  };
}
