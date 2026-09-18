import { randomUUID } from "node:crypto";
import {
  type ConnectionConfiguration,
  type ConnectionSettings,
  connectionConfigurationFromSettings,
  connectionConfigurationSchema,
  createConnectionSettings,
  loadConnectionSettings,
  writeConnectionSettings,
} from "./connection-settings.js";
import type { DesktopPaths } from "./paths.js";
import {
  SECRET_ROLES,
  SecretStoreError,
  type SecretRole,
  type SecretStore,
} from "./secret-store.js";

const REQUIRED_CAPTURE_ROLES: readonly SecretRole[] = [
  "recall-api-key",
  "recall-webhook-verification-secret",
  "ngrok-authtoken",
];

export type ConnectionStorageHooks = {
  afterCandidateRecorded?(): void;
  afterSecretWritten?(role: SecretRole): void;
  afterCandidateVerified?(): void;
  afterAuthoritySwitch?(): void;
};

export type RedactedSecretStatus = {
  recallApiKey: boolean;
  recallWebhookVerificationSecret: boolean;
  ngrokAuthtoken: boolean;
  hermesApiKey: boolean;
};

export type ConnectionStorageStatus =
  | {
      kind: "ready";
      settings: ConnectionSettings;
      configured: RedactedSecretStatus;
      cleanupPending: boolean;
    }
  | {
      kind: "setup_required";
      settings: ConnectionSettings;
      configured: RedactedSecretStatus;
      cleanupPending: boolean;
    }
  | {
      kind: "needs_attention";
      code:
        | "candidate_cleanup_failed"
        | "keychain_access_denied"
        | "keychain_unavailable"
        | "keychain_write_failed";
      settings: ConnectionSettings;
      configured: RedactedSecretStatus;
      cleanupPending: boolean;
    };

export type ActiveConnectionAuthority = {
  connection: ConnectionConfiguration;
  secrets: Partial<Record<SecretRole, string>>;
  generation: string;
};

export class ConnectionStorage {
  readonly #paths: DesktopPaths;
  readonly #secretStore: SecretStore;
  readonly #generationId: () => string;
  readonly #hooks: ConnectionStorageHooks;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: {
    paths: DesktopPaths;
    secretStore: SecretStore;
    generationId?: () => string;
    hooks?: ConnectionStorageHooks;
  }) {
    this.#paths = options.paths;
    this.#secretStore = options.secretStore;
    this.#generationId = options.generationId ?? randomUUID;
    this.#hooks = options.hooks ?? {};
  }

  initialize(): Promise<ConnectionStorageStatus> {
    return this.#serialized(() => this.#initialize());
  }

  save(input: {
    connection: ConnectionConfiguration;
    replacements: Partial<Record<SecretRole, string | null>>;
  }): Promise<ConnectionStorageStatus> {
    return this.#serialized(async () => {
      createConnectionSettings(this.#paths);
      let settings = loadConnectionSettings(this.#paths);
      if (settings.candidateSecretGeneration !== null) {
        const reconciled = await this.#discardCandidate(settings);
        if (!reconciled) {
          return this.#attention(
            loadConnectionSettings(this.#paths),
            "candidate_cleanup_failed",
          );
        }
        settings = loadConnectionSettings(this.#paths);
      }
      const secrets = await this.#resolveReplacementSecrets(
        settings,
        input.replacements,
      );
      await this.#commitGeneration(
        settings,
        connectionConfigurationSchema.parse(input.connection),
        secrets,
      );
      await this.#cleanupPendingGenerations();
      return this.#statusForActive(loadConnectionSettings(this.#paths));
    });
  }

  resetCredentials(): Promise<ConnectionStorageStatus> {
    return this.#serialized(async () => {
      createConnectionSettings(this.#paths);
      const settings = loadConnectionSettings(this.#paths);
      const generations = uniqueGenerations([
        settings.activeSecretGeneration,
        settings.candidateSecretGeneration?.id ?? null,
        ...settings.secretGenerationsPendingCleanup,
      ]);
      for (const generation of generations) {
        await this.#deleteGeneration(generation);
      }
      const reset: ConnectionSettings = {
        ...settings,
        activeSecretGeneration: null,
        configuredSecretRoles: [],
        candidateSecretGeneration: null,
        secretGenerationsPendingCleanup: [],
      };
      writeConnectionSettings(this.#paths, reset);
      return this.#setupStatus(reset);
    });
  }

  loadActiveAuthority(): Promise<ActiveConnectionAuthority | null> {
    return this.#serialized(async () => {
      createConnectionSettings(this.#paths);
      const settings = loadConnectionSettings(this.#paths);
      if (settings.activeSecretGeneration === null) {
        return null;
      }
      return this.#readAuthority(settings);
    });
  }

  async #initialize(): Promise<ConnectionStorageStatus> {
    createConnectionSettings(this.#paths);
    let settings = loadConnectionSettings(this.#paths);

    if (settings.candidateSecretGeneration !== null) {
      if (!(await this.#discardCandidate(settings))) {
        return this.#attention(settings, "candidate_cleanup_failed");
      }
      settings = loadConnectionSettings(this.#paths);
    }

    if (settings.activeSecretGeneration !== null) {
      try {
        await this.#readAuthority(settings);
      } catch (error) {
        return this.#attention(settings, mapKeychainAttention(error));
      }
      await this.#cleanupPendingGenerations();
      return this.#statusForActive(loadConnectionSettings(this.#paths));
    }

    return this.#setupStatus(settings);
  }

  async #commitGeneration(
    settings: ConnectionSettings,
    connection: ConnectionConfiguration,
    secrets: Partial<Record<SecretRole, string>>,
  ): Promise<void> {
    const configuredSecretRoles = SECRET_ROLES.filter(
      (role) => secrets[role] !== undefined,
    );
    for (const role of REQUIRED_CAPTURE_ROLES) {
      if (!configuredSecretRoles.includes(role)) {
        throw new SecretStoreError(
          "invalid_request",
          "Required connection credentials are missing.",
        );
      }
    }
    if (connection.ngrok.domain === null) {
      throw new SecretStoreError(
        "invalid_request",
        "A stable ngrok domain is required.",
      );
    }
    const generation = this.#generationId();
    if (
      generation === settings.activeSecretGeneration ||
      settings.secretGenerationsPendingCleanup.includes(generation)
    ) {
      throw new SecretStoreError(
        "invalid_request",
        "A fresh secret generation could not be allocated.",
      );
    }
    const candidate: ConnectionSettings = {
      ...settings,
      candidateSecretGeneration: {
        id: generation,
        previousActiveGeneration: settings.activeSecretGeneration,
        phase: "recorded",
        configuredSecretRoles,
        connection,
      },
    };
    writeConnectionSettings(this.#paths, candidate);
    invokeHook(this.#hooks.afterCandidateRecorded);

    for (const role of configuredSecretRoles) {
      const value = secrets[role];
      if (value === undefined) {
        throw new SecretStoreError(
          "invalid_request",
          "A candidate Keychain value is missing.",
        );
      }
      await this.#secretStore.write(role, generation, value);
      invokeHook(this.#hooks.afterSecretWritten, role);
    }
    for (const role of configuredSecretRoles) {
      const expected = secrets[role];
      const stored = await this.#secretStore.read(role, generation);
      if (stored !== expected) {
        throw new SecretStoreError(
          "write_failed",
          "The candidate Keychain generation could not be verified.",
        );
      }
    }

    const verified = loadConnectionSettings(this.#paths);
    if (verified.candidateSecretGeneration?.id !== generation) {
      throw new Error("Connection candidate authority changed unexpectedly.");
    }
    verified.candidateSecretGeneration.phase = "secrets_written";
    writeConnectionSettings(this.#paths, verified);
    invokeHook(this.#hooks.afterCandidateVerified);

    const cleanup = uniqueGenerations([
      ...verified.secretGenerationsPendingCleanup,
      verified.activeSecretGeneration,
    ]);
    const activated: ConnectionSettings = {
      ...verified,
      recall: connection.recall,
      ngrok: connection.ngrok,
      hermes: connection.hermes,
      activeSecretGeneration: generation,
      configuredSecretRoles,
      candidateSecretGeneration: null,
      secretGenerationsPendingCleanup: cleanup.filter(
        (entry) => entry !== generation,
      ),
    };
    writeConnectionSettings(this.#paths, activated);
    invokeHook(this.#hooks.afterAuthoritySwitch);
  }

  async #resolveReplacementSecrets(
    settings: ConnectionSettings,
    replacements: Partial<Record<SecretRole, string | null>>,
  ): Promise<Partial<Record<SecretRole, string>>> {
    const resolved: Partial<Record<SecretRole, string>> = {};
    for (const role of SECRET_ROLES) {
      const replacement = replacements[role];
      if (replacement === null) {
        continue;
      }
      if (typeof replacement === "string" && replacement.length > 0) {
        resolved[role] = replacement;
        continue;
      }
      if (
        settings.activeSecretGeneration !== null &&
        settings.configuredSecretRoles.includes(role)
      ) {
        resolved[role] = await this.#secretStore.read(
          role,
          settings.activeSecretGeneration,
        );
      }
    }
    return resolved;
  }

  async #discardCandidate(settings: ConnectionSettings): Promise<boolean> {
    const generation = settings.candidateSecretGeneration?.id;
    if (generation === undefined) {
      return true;
    }
    try {
      await this.#deleteGeneration(generation);
    } catch {
      return false;
    }
    writeConnectionSettings(this.#paths, {
      ...settings,
      candidateSecretGeneration: null,
    });
    return true;
  }

  async #cleanupPendingGenerations(): Promise<void> {
    let settings = loadConnectionSettings(this.#paths);
    const remaining: string[] = [];
    for (const generation of settings.secretGenerationsPendingCleanup) {
      if (generation === settings.activeSecretGeneration) {
        continue;
      }
      try {
        await this.#deleteGeneration(generation);
      } catch {
        remaining.push(generation);
      }
    }
    if (remaining.length !== settings.secretGenerationsPendingCleanup.length) {
      settings = {
        ...settings,
        secretGenerationsPendingCleanup: remaining,
      };
      writeConnectionSettings(this.#paths, settings);
    }
  }

  async #deleteGeneration(generation: string): Promise<void> {
    for (const role of SECRET_ROLES) {
      await this.#secretStore.delete(role, generation);
    }
  }

  async #readAuthority(
    settings: ConnectionSettings,
  ): Promise<ActiveConnectionAuthority> {
    const generation = settings.activeSecretGeneration;
    if (generation === null) {
      throw new Error("Connection settings have no active secret generation.");
    }
    const secrets: Partial<Record<SecretRole, string>> = {};
    for (const role of settings.configuredSecretRoles) {
      secrets[role] = await this.#secretStore.read(role, generation);
    }
    for (const role of REQUIRED_CAPTURE_ROLES) {
      if (secrets[role] === undefined) {
        throw new SecretStoreError(
          "missing",
          "A required active Keychain item is missing.",
        );
      }
    }
    return {
      connection: connectionConfigurationFromSettings(settings),
      secrets,
      generation,
    };
  }

  #statusForActive(settings: ConnectionSettings): ConnectionStorageStatus {
    const configured = redactedStatus(settings.configuredSecretRoles);
    const hermes = settings.hermes;
    const configuredHermesIsIncomplete =
      settings.configuredSecretRoles.includes("hermes-api-key") &&
      hermes.mode !== null &&
      (!hermes.profile || (hermes.mode === "ssh" && !hermes.sshTarget));
    if (
      settings.activeSecretGeneration === null ||
      settings.ngrok.domain === null ||
      configuredHermesIsIncomplete ||
      REQUIRED_CAPTURE_ROLES.some(
        (role) => !settings.configuredSecretRoles.includes(role),
      )
    ) {
      return {
        kind: "setup_required",
        settings,
        configured,
        cleanupPending: settings.secretGenerationsPendingCleanup.length > 0,
      };
    }
    return {
      kind: "ready",
      settings,
      configured,
      cleanupPending: settings.secretGenerationsPendingCleanup.length > 0,
    };
  }

  #setupStatus(settings: ConnectionSettings): ConnectionStorageStatus {
    return {
      kind: "setup_required",
      settings,
      configured: redactedStatus(settings.configuredSecretRoles),
      cleanupPending: settings.secretGenerationsPendingCleanup.length > 0,
    };
  }

  #attention(
    settings: ConnectionSettings,
    code: Extract<ConnectionStorageStatus, { kind: "needs_attention" }>["code"],
  ): ConnectionStorageStatus {
    return {
      kind: "needs_attention",
      code,
      settings,
      configured: redactedStatus(settings.configuredSecretRoles),
      cleanupPending: settings.secretGenerationsPendingCleanup.length > 0,
    };
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function redactedStatus(roles: readonly SecretRole[]): RedactedSecretStatus {
  return {
    recallApiKey: roles.includes("recall-api-key"),
    recallWebhookVerificationSecret: roles.includes(
      "recall-webhook-verification-secret",
    ),
    ngrokAuthtoken: roles.includes("ngrok-authtoken"),
    hermesApiKey: roles.includes("hermes-api-key"),
  };
}

function uniqueGenerations(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function mapKeychainAttention(
  error: unknown,
): Extract<ConnectionStorageStatus, { kind: "needs_attention" }>["code"] {
  if (error instanceof SecretStoreError) {
    if (error.code === "access_denied") {
      return "keychain_access_denied";
    }
    if (error.code === "unavailable" || error.code === "missing") {
      return "keychain_unavailable";
    }
  }
  return "keychain_write_failed";
}

class ConnectionStorageHookInterruption extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : "Storage hook interrupted.",
      {
        cause,
      },
    );
    this.name = "ConnectionStorageHookInterruption";
  }
}

function invokeHook<T>(hook: ((value: T) => void) | undefined, value: T): void;
function invokeHook(hook: (() => void) | undefined): void;
function invokeHook<T>(
  hook: ((value?: T) => void) | undefined,
  value?: T,
): void {
  try {
    hook?.(value);
  } catch (error) {
    throw new ConnectionStorageHookInterruption(error);
  }
}
