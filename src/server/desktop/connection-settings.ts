import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { hermesSshTargetSchema } from "../connectivity/hermes-ssh-target.js";
import {
  assertManagedPathHasNoSymlinks,
  atomicWriteText,
  ensurePrivateDirectory,
} from "../persistence/atomic-write.js";
import {
  assertOwnerPrivateDirectory,
  assertOwnerPrivateRegularFile,
} from "../persistence/private-path.js";
import type { DesktopPaths } from "./paths.js";
import { SECRET_ROLES } from "./secret-store.js";

export const CONNECTION_SETTINGS_SCHEMA_VERSION = 4;

const generationIdSchema = z
  .uuidv4()
  .refine(
    (value) => value.toLowerCase() === value,
    "Generation IDs must use canonical lowercase UUIDs.",
  );

const portSchema = z.number().int().min(1).max(65_535);

export const ngrokDomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "ngrok domain must be a lowercase hostname.",
  );

const profileSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 31 && code !== 127;
      }),
    "Profile contains control characters.",
  );

const endpointPathSchema = z.union([
  z.literal("/"),
  z.string().regex(/^\/p\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
]);

const hermesSettingsSchema = z
  .strictObject({
    mode: z.enum(["local", "ssh"]).nullable(),
    localPort: portSchema,
    remotePort: portSchema,
    sshTarget: hermesSshTargetSchema.nullable(),
    endpointPath: endpointPathSchema,
    profile: profileSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.mode === "ssh" && value.sshTarget === null) {
      context.addIssue({
        code: "custom",
        path: ["sshTarget"],
        message: "SSH mode requires an SSH target.",
      });
    }
    if (value.mode !== "ssh" && value.sshTarget !== null) {
      context.addIssue({
        code: "custom",
        path: ["sshTarget"],
        message: "Only SSH mode may store an SSH target.",
      });
    }
  });

const secretRoleSchema = z.enum(SECRET_ROLES);

const configuredRolesSchema = z
  .array(secretRoleSchema)
  .superRefine((roles, context) => {
    const canonical = SECRET_ROLES.filter((role) => roles.includes(role));
    if (
      new Set(roles).size !== roles.length ||
      canonical.some((role, index) => role !== roles[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Secret roles must be unique and in canonical order.",
      });
    }
  });

export const connectionConfigurationSchema = z.strictObject({
  recall: z.strictObject({
    region: z.literal("us-west-2"),
    language: z.literal("en"),
  }),
  ngrok: z.strictObject({ domain: ngrokDomainSchema.nullable() }),
  hermes: hermesSettingsSchema,
});

const candidateSecretGenerationSchema = z.strictObject({
  id: generationIdSchema,
  previousActiveGeneration: generationIdSchema.nullable(),
  phase: z.enum(["recorded", "secrets_written"]),
  configuredSecretRoles: configuredRolesSchema,
  connection: connectionConfigurationSchema,
});

// Inert v4 metadata: never drives imports, retirement, or schema conversion.
const legacyMigrationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not_checked") }),
  z.strictObject({ state: z.literal("not_needed") }),
  z.strictObject({ state: z.literal("retiring_plaintext") }),
  z.strictObject({ state: z.literal("complete") }),
  z.strictObject({
    state: z.literal("needs_attention"),
    code: z.enum([
      "legacy_invalid",
      "keychain_access_denied",
      "keychain_unavailable",
      "keychain_write_failed",
      "plaintext_retirement_failed",
      "candidate_cleanup_failed",
    ]),
  }),
]);

function addConnectionSettingsIssues(
  value: {
    activeSecretGeneration: string | null;
    configuredSecretRoles: readonly string[];
    candidateSecretGeneration: {
      id: string;
      previousActiveGeneration: string | null;
    } | null;
    secretGenerationsPendingCleanup: readonly string[];
  },
  context: z.RefinementCtx,
): void {
  if (
    value.activeSecretGeneration === null &&
    value.configuredSecretRoles.length > 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["configuredSecretRoles"],
      message: "Configured roles require an active secret generation.",
    });
  }
  if (
    value.candidateSecretGeneration !== null &&
    (value.candidateSecretGeneration.id === value.activeSecretGeneration ||
      value.secretGenerationsPendingCleanup.includes(
        value.candidateSecretGeneration.id,
      ))
  ) {
    context.addIssue({
      code: "custom",
      path: ["candidateSecretGeneration", "id"],
      message:
        "Candidate generation must differ from active and cleanup generations.",
    });
  }
  if (
    value.candidateSecretGeneration !== null &&
    value.candidateSecretGeneration.previousActiveGeneration !==
      value.activeSecretGeneration
  ) {
    context.addIssue({
      code: "custom",
      path: ["candidateSecretGeneration", "previousActiveGeneration"],
      message: "Candidate generation must point to the active generation.",
    });
  }
  if (
    new Set(value.secretGenerationsPendingCleanup).size !==
    value.secretGenerationsPendingCleanup.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["secretGenerationsPendingCleanup"],
      message: "Cleanup generations must be unique.",
    });
  }
}

export const connectionSettingsSchema = z
  .strictObject({
    schemaVersion: z.literal(CONNECTION_SETTINGS_SCHEMA_VERSION),
    recall: connectionConfigurationSchema.shape.recall,
    ngrok: connectionConfigurationSchema.shape.ngrok,
    hermes: connectionConfigurationSchema.shape.hermes,
    activeSecretGeneration: generationIdSchema.nullable(),
    configuredSecretRoles: configuredRolesSchema,
    candidateSecretGeneration: candidateSecretGenerationSchema.nullable(),
    secretGenerationsPendingCleanup: z.array(generationIdSchema),
    legacyMigration: legacyMigrationSchema,
  })
  .superRefine(addConnectionSettingsIssues);

export type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;
export type CandidateSecretGeneration = NonNullable<
  ConnectionSettings["candidateSecretGeneration"]
>;
export type ConnectionConfiguration = z.infer<
  typeof connectionConfigurationSchema
>;

export function defaultConnectionSettings(): ConnectionSettings {
  return {
    schemaVersion: CONNECTION_SETTINGS_SCHEMA_VERSION,
    recall: { region: "us-west-2", language: "en" },
    ngrok: { domain: null },
    hermes: {
      mode: null,
      localPort: 8642,
      remotePort: 8642,
      sshTarget: null,
      endpointPath: "/",
      profile: null,
    },
    activeSecretGeneration: null,
    configuredSecretRoles: [],
    candidateSecretGeneration: null,
    secretGenerationsPendingCleanup: [],
    legacyMigration: { state: "not_checked" },
  };
}

export function connectionConfigurationFromSettings(
  settings: ConnectionSettings,
): ConnectionConfiguration {
  return connectionConfigurationSchema.parse({
    recall: settings.recall,
    ngrok: settings.ngrok,
    hermes: settings.hermes,
  });
}

export function createConnectionSettings(
  paths: DesktopPaths,
): "created" | "existing" {
  ensureOrValidatePrivateDirectory(paths.applicationRoot);
  assertOwnerPrivateDirectory(paths.applicationRoot);
  assertManagedPathHasNoSymlinks(paths.configDirectory, paths.applicationRoot);
  ensureOrValidatePrivateDirectory(paths.configDirectory);
  assertOwnerPrivateDirectory(paths.configDirectory);

  if (existsSync(paths.connectionSettingsFile)) {
    loadConnectionSettings(paths);
    return "existing";
  }

  writeConnectionSettings(paths, defaultConnectionSettings());
  return "created";
}

export function loadConnectionSettings(
  paths: DesktopPaths,
): ConnectionSettings {
  assertOwnerPrivateDirectory(paths.applicationRoot);
  assertManagedPathHasNoSymlinks(paths.configDirectory, paths.applicationRoot);
  assertOwnerPrivateDirectory(paths.configDirectory);
  assertManagedPathHasNoSymlinks(
    paths.connectionSettingsFile,
    paths.applicationRoot,
  );
  assertOwnerPrivateRegularFile(paths.connectionSettingsFile);

  try {
    const input = JSON.parse(
      readFileSync(paths.connectionSettingsFile, "utf8"),
    ) as unknown;
    return connectionSettingsSchema.parse(input);
  } catch (error) {
    throw new Error("Desktop connection settings are invalid.", {
      cause: error,
    });
  }
}

export function writeConnectionSettings(
  paths: DesktopPaths,
  settings: ConnectionSettings,
): void {
  const parsed = connectionSettingsSchema.parse(settings);
  assertManagedPathHasNoSymlinks(paths.configDirectory, paths.applicationRoot);
  ensureOrValidatePrivateDirectory(paths.configDirectory);
  assertOwnerPrivateDirectory(paths.configDirectory);
  assertManagedPathHasNoSymlinks(
    paths.connectionSettingsFile,
    paths.applicationRoot,
  );
  atomicWriteText(
    paths.connectionSettingsFile,
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
  assertOwnerPrivateRegularFile(paths.connectionSettingsFile);
}

function ensureOrValidatePrivateDirectory(directory: string): void {
  if (existsSync(directory)) {
    assertOwnerPrivateDirectory(directory);
  } else {
    ensurePrivateDirectory(directory);
  }
}
