import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionStorage,
  type ConnectionStorageHooks,
} from "../../src/server/desktop/connection-storage.js";
import {
  connectionConfigurationFromSettings,
  defaultConnectionSettings,
  loadConnectionSettings,
} from "../../src/server/desktop/connection-settings.js";
import { resolveDesktopPaths } from "../../src/server/desktop/paths.js";
import {
  SECRET_ROLES,
  SecretStoreError,
  type SecretRole,
  type SecretStore,
} from "../../src/server/desktop/secret-store.js";

const firstGeneration = "00000000-0000-4000-8000-000000000001";
const secondGeneration = "00000000-0000-4000-8000-000000000002";
const thirdGeneration = "00000000-0000-4000-8000-000000000003";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("connection storage initialization", () => {
  it("creates current nonsecret settings without env or Keychain writes", async () => {
    const paths = createPaths();
    const secrets = new FakeSecretStore();
    await expect(
      createStorage(paths, secrets, []).initialize(),
    ).resolves.toMatchObject({ kind: "setup_required" });
    expect(loadConnectionSettings(paths)).toEqual(defaultConnectionSettings());
    expect(existsSync(path.join(paths.configDirectory, ".env"))).toBe(false);
    expect(secrets.calls).toEqual([]);
  });

  it.each([
    "not_checked",
    "not_needed",
    "complete",
    "retiring_plaintext",
    "needs_attention",
  ] as const)(
    "keeps v4 %s metadata inert through loading and Save",
    async (state) => {
      const paths = createPaths();
      const secrets = new FakeSecretStore();
      const storage = createStorage(paths, secrets, [
        firstGeneration,
        secondGeneration,
      ]);
      await storage.save(saveInput());
      const settings = loadConnectionSettings(paths);
      settings.legacyMigration =
        state === "needs_attention"
          ? { state, code: "legacy_invalid" }
          : { state };
      writePrivateSettings(paths, settings);
      const original = readFileSync(paths.connectionSettingsFile, "utf8");
      secrets.calls.splice(0);
      await expect(storage.initialize()).resolves.toMatchObject({
        kind: "ready",
      });
      expect(readFileSync(paths.connectionSettingsFile, "utf8")).toBe(original);
      expect(secrets.calls).toEqual(
        SECRET_ROLES.map((role) => ({
          operation: "read",
          role,
          generation: firstGeneration,
        })),
      );
      await storage.save({
        connection: connectionConfigurationFromSettings(settings),
        replacements: {},
      });
      expect(loadConnectionSettings(paths).legacyMigration).toEqual(
        settings.legacyMigration,
      );
      expect(loadConnectionSettings(paths).hermes).toEqual(settings.hermes);
      expect(loadConnectionSettings(paths).configuredSecretRoles).toEqual(
        settings.configuredSecretRoles,
      );
    },
  );
  it("saves capture settings without fabricating an optional Hermes key", async () => {
    const paths = createPaths();
    const secrets = new FakeSecretStore();
    const input = saveInput();
    await createStorage(paths, secrets, [firstGeneration]).save({
      ...input,
      replacements: { ...input.replacements, "hermes-api-key": null },
    });
    expect(loadConnectionSettings(paths).configuredSecretRoles).toEqual(
      SECRET_ROLES.slice(0, 3),
    );
    expect(secrets.has("hermes-api-key", firstGeneration)).toBe(false);
  });
  it.each(["access_denied", "unavailable"] as const)(
    "preserves current authority when Save encounters %s",
    async (code) => {
      const paths = createPaths();
      const secrets = new FakeSecretStore();
      const storage = createStorage(paths, secrets, [
        firstGeneration,
        secondGeneration,
        thirdGeneration,
      ]);
      await storage.save(saveInput());
      secrets.failWriteCode = code;
      await expect(storage.save(saveInput())).rejects.toMatchObject({ code });
      expect(loadConnectionSettings(paths).activeSecretGeneration).toBe(
        firstGeneration,
      );
      expect(secrets.value("recall-api-key", firstGeneration)).toBe(
        "synthetic-recall-key",
      );
      secrets.failWriteCode = null;
      await expect(storage.initialize()).resolves.toMatchObject({
        kind: "ready",
      });
      expect(
        loadConnectionSettings(paths).candidateSecretGeneration,
      ).toBeNull();
      await storage.save(saveInput());
      expect(loadConnectionSettings(paths).activeSecretGeneration).toBe(
        thirdGeneration,
      );
    },
  );

  for (const active of [false, true]) {
    for (const filename of [".env", ".env.retired"]) {
      it.each(["valid", "malformed", "symlink"])(
        `ignores ${filename} (%s) with active=${active}`,
        async (kind) => {
          const paths = createPaths();
          const secrets = new FakeSecretStore();
          const storage = createStorage(paths, secrets, [firstGeneration]);
          await storage.initialize();
          if (active) await storage.save(saveInput());
          const settings = loadConnectionSettings(paths);
          settings.legacyMigration = { state: "retiring_plaintext" };
          writePrivateSettings(paths, settings);
          const file = path.join(paths.configDirectory, filename);
          const contents =
            kind === "malformed"
              ? "invalid=fixture\ninvalid=duplicate"
              : "CONVO_CADDY_RECALL_API_KEY=synthetic-recall\nCONVO_CADDY_RECALL_VERIFICATION_SECRET=whsec_c3ludGhldGlj\nCONVO_CADDY_NGROK_AUTHTOKEN=synthetic-token\nCONVO_CADDY_HERMES_API_KEY=synthetic-hermes\nCONVO_CADDY_HERMES_SSH_TARGET=operator@host.example\n";
          const target = path.join(paths.configDirectory, "ignored-target");
          if (kind === "symlink") {
            writeFileSync(target, contents, { mode: 0o600 });
            symlinkSync(target, file);
          } else writeFileSync(file, contents, { mode: 0o600 });
          const before = lstatSync(file);
          const bytes = readFileSync(paths.connectionSettingsFile, "utf8");
          secrets.calls.splice(0);
          await expect(storage.initialize()).resolves.toMatchObject({
            kind: active ? "ready" : "setup_required",
          });
          expect(lstatSync(file).ino).toBe(before.ino);
          expect(lstatSync(file).isSymbolicLink()).toBe(kind === "symlink");
          expect(readFileSync(file, "utf8")).toBe(contents);
          expect(readFileSync(paths.connectionSettingsFile, "utf8")).toBe(
            bytes,
          );
          expect(
            secrets.calls.every(
              (call) =>
                call.operation === "read" &&
                call.generation === firstGeneration,
            ),
          ).toBe(true);
          expect(loadConnectionSettings(paths)).toEqual(settings);
        },
      );
    }
  }
});

describe("current Save crash recovery", () => {
  it.each([
    "afterCandidateRecorded",
    "afterSecretWritten",
    "afterCandidateVerified",
    "afterAuthoritySwitch",
  ] as const)("recovers %s without losing current authority", async (hook) => {
    const paths = createPaths();
    const secrets = new FakeSecretStore();
    await createStorage(paths, secrets, [firstGeneration]).save(saveInput());
    let writes = 0;
    const crashing = createStorage(paths, secrets, [secondGeneration], {
      [hook]: () => {
        if (hook !== "afterSecretWritten" || ++writes === 2)
          throw new Error("simulated crash");
      },
    });
    await expect(
      crashing.save({
        connection: saveInput().connection,
        replacements: { "recall-api-key": "replacement" },
      }),
    ).rejects.toThrow("simulated crash");
    const switched = hook === "afterAuthoritySwitch";
    expect(loadConnectionSettings(paths).activeSecretGeneration).toBe(
      switched ? secondGeneration : firstGeneration,
    );
    if (!switched)
      expect(
        loadConnectionSettings(paths).candidateSecretGeneration?.phase,
      ).toBe(
        hook === "afterCandidateVerified" ? "secrets_written" : "recorded",
      );
    const recovered = createStorage(paths, secrets, [thirdGeneration]);
    await expect(recovered.initialize()).resolves.toMatchObject({
      kind: "ready",
    });
    expect(loadConnectionSettings(paths).candidateSecretGeneration).toBeNull();
    for (const role of SECRET_ROLES) {
      expect(
        secrets.has(role, switched ? firstGeneration : secondGeneration),
      ).toBe(false);
      expect(
        secrets.has(role, switched ? secondGeneration : firstGeneration),
      ).toBe(true);
    }
    await recovered.save({
      connection: saveInput().connection,
      replacements: { "recall-api-key": "retry" },
    });
    expect(loadConnectionSettings(paths).activeSecretGeneration).toBe(
      thirdGeneration,
    );
  });
});

describe("connection generation updates and reset", () => {
  it("copies blank-preserved values inside the secret store and switches all roles atomically", async () => {
    const paths = createPaths();
    const secrets = new FakeSecretStore();
    const storage = createStorage(paths, secrets, [
      firstGeneration,
      secondGeneration,
    ]);
    await storage.save(saveInput());
    const current = loadConnectionSettings(paths);

    await storage.save({
      connection: connectionConfigurationFromSettings(current),
      replacements: {
        "recall-api-key": "replacement-recall-key",
        "recall-webhook-verification-secret": "",
        "ngrok-authtoken": "",
        "hermes-api-key": "",
      },
    });

    expect(loadConnectionSettings(paths)).toMatchObject({
      activeSecretGeneration: secondGeneration,
      candidateSecretGeneration: null,
      secretGenerationsPendingCleanup: [],
    });
    expect(secrets.value("recall-api-key", secondGeneration)).toBe(
      "replacement-recall-key",
    );
    expect(
      secrets.value("recall-webhook-verification-secret", secondGeneration),
    ).toBe("whsec_ZGVza3RvcC10ZXN0LXNlY3JldA==");
    expect(secrets.value("ngrok-authtoken", secondGeneration)).toBe(
      "synthetic-ngrok-token",
    );
    expect(secrets.value("hermes-api-key", secondGeneration)).toBe(
      "synthetic-hermes-key",
    );
    for (const role of SECRET_ROLES) {
      expect(secrets.has(role, firstGeneration)).toBe(false);
    }
  });

  it("does not invalidate an active generation when abandoned-candidate cleanup fails", async () => {
    const paths = createPaths();
    const secrets = new FakeSecretStore();
    const initial = createStorage(
      paths,
      secrets,
      [firstGeneration, secondGeneration],
      {
        afterCandidateRecorded: (() => {
          let count = 0;
          return () => {
            count += 1;
            if (count === 2) {
              throw new Error("simulated update crash");
            }
          };
        })(),
      },
    );
    await initial.save(saveInput());
    const current = loadConnectionSettings(paths);
    await expect(
      initial.save({
        connection: connectionConfigurationFromSettings(current),
        replacements: { "recall-api-key": "replacement" },
      }),
    ).rejects.toThrow("simulated update crash");
    secrets.failDeleteGeneration = secondGeneration;

    const status = await createStorage(paths, secrets, [
      thirdGeneration,
    ]).initialize();

    expect(status).toMatchObject({
      kind: "needs_attention",
      code: "candidate_cleanup_failed",
    });
    expect(loadConnectionSettings(paths).activeSecretGeneration).toBe(
      firstGeneration,
    );
    expect(secrets.value("recall-api-key", firstGeneration)).toBe(
      "synthetic-recall-key",
    );
  });

  it("refuses a generated ID that aliases active authority before writing secrets", async () => {
    const paths = createPaths();
    const secrets = new FakeSecretStore();
    const storage = createStorage(paths, secrets, [
      firstGeneration,
      firstGeneration,
    ]);
    await storage.save(saveInput());
    const current = loadConnectionSettings(paths);
    secrets.calls.splice(0);

    await expect(
      storage.save({
        connection: connectionConfigurationFromSettings(current),
        replacements: { "recall-api-key": "replacement" },
      }),
    ).rejects.toThrow("fresh secret generation");

    expect(loadConnectionSettings(paths).activeSecretGeneration).toBe(
      firstGeneration,
    );
    expect(secrets.calls.some((call) => call.operation === "write")).toBe(
      false,
    );
    expect(secrets.value("recall-api-key", firstGeneration)).toBe(
      "synthetic-recall-key",
    );
  });

  it("rejects aliased candidates without deleting protected generations", async () => {
    for (const alias of ["active", "cleanup"] as const) {
      const paths = createPaths();
      const secrets = new FakeSecretStore();
      const storage = createStorage(paths, secrets, [firstGeneration]);
      await storage.save(saveInput());
      const settings = loadConnectionSettings(paths);
      const candidateId =
        alias === "active" ? firstGeneration : secondGeneration;
      writeFileSync(
        paths.connectionSettingsFile,
        `${JSON.stringify({
          ...settings,
          candidateSecretGeneration: {
            id: candidateId,
            previousActiveGeneration: firstGeneration,
            phase: "recorded",
            configuredSecretRoles: settings.configuredSecretRoles,
            connection: connectionConfigurationFromSettings(settings),
          },
          secretGenerationsPendingCleanup:
            alias === "cleanup" ? [secondGeneration] : [],
        })}\n`,
        { mode: 0o600 },
      );
      secrets.calls.splice(0);

      await expect(storage.initialize()).rejects.toThrow(
        "Desktop connection settings are invalid",
      );

      expect(secrets.calls).toEqual([]);
      expect(secrets.value("recall-api-key", firstGeneration)).toBe(
        "synthetic-recall-key",
      );
    }
  });

  it("resets only recorded generations and leaves nonsecret settings intact", async () => {
    const paths = createPaths();
    const secrets = new FakeSecretStore();
    const storage = createStorage(paths, secrets, [firstGeneration]);
    await storage.save(saveInput());
    const before = loadConnectionSettings(paths);

    await storage.resetCredentials();

    const after = loadConnectionSettings(paths);
    expect(after.ngrok).toEqual(before.ngrok);
    expect(after.hermes).toEqual(before.hermes);
    expect(after).toMatchObject({
      activeSecretGeneration: null,
      configuredSecretRoles: [],
      candidateSecretGeneration: null,
      secretGenerationsPendingCleanup: [],
    });
    for (const role of SECRET_ROLES) {
      expect(secrets.has(role, firstGeneration)).toBe(false);
    }
  });

  it("serializes concurrent saves into distinct authoritative generations", async () => {
    const paths = createPaths();
    const secrets = new FakeSecretStore();
    const storage = createStorage(paths, secrets, [
      firstGeneration,
      secondGeneration,
      thirdGeneration,
    ]);
    await storage.save(saveInput());
    const connection = connectionConfigurationFromSettings(
      loadConnectionSettings(paths),
    );

    await Promise.all([
      storage.save({
        connection,
        replacements: { "recall-api-key": "first-concurrent-value" },
      }),
      storage.save({
        connection,
        replacements: { "recall-api-key": "second-concurrent-value" },
      }),
    ]);

    expect(loadConnectionSettings(paths)).toMatchObject({
      activeSecretGeneration: thirdGeneration,
      candidateSecretGeneration: null,
      secretGenerationsPendingCleanup: [],
    });
    expect(secrets.value("recall-api-key", thirdGeneration)).toBe(
      "second-concurrent-value",
    );
    for (const role of SECRET_ROLES) {
      expect(secrets.has(role, firstGeneration)).toBe(false);
      expect(secrets.has(role, secondGeneration)).toBe(false);
    }
  });
});

function createStorage(
  paths: ReturnType<typeof createPaths>,
  secretStore: FakeSecretStore,
  generations: string[],
  hooks: ConnectionStorageHooks = {},
): ConnectionStorage {
  return new ConnectionStorage({
    paths,
    secretStore,
    generationId: () => {
      const next = generations.shift();
      if (!next) {
        throw new Error("No test generation remains.");
      }
      return next;
    },
    hooks,
  });
}

class FakeSecretStore implements SecretStore {
  readonly #values = new Map<string, string>();
  readonly calls: Array<{
    operation: "read" | "write" | "delete";
    role: SecretRole;
    generation: string;
  }> = [];
  failDeleteGeneration: string | null = null;
  failWriteCode: "access_denied" | "unavailable" | null = null;

  async write(role: SecretRole, generation: string, secret: string) {
    this.calls.push({ operation: "write", role, generation });
    if (this.failWriteCode) {
      throw new SecretStoreError(this.failWriteCode, "Test write failed.");
    }
    this.#values.set(key(role, generation), secret);
  }

  async read(role: SecretRole, generation: string) {
    this.calls.push({ operation: "read", role, generation });
    const value = this.#values.get(key(role, generation));
    if (value === undefined) {
      throw new SecretStoreError("missing", "Test secret is missing.");
    }
    return value;
  }

  async delete(role: SecretRole, generation: string) {
    this.calls.push({ operation: "delete", role, generation });
    if (this.failDeleteGeneration === generation) {
      throw new SecretStoreError("delete_failed", "Test delete failed.");
    }
    return this.#values.delete(key(role, generation)) ? "deleted" : "missing";
  }

  has(role: SecretRole, generation: string): boolean {
    return this.#values.has(key(role, generation));
  }

  value(role: SecretRole, generation: string): string {
    const value = this.#values.get(key(role, generation));
    if (value === undefined) {
      throw new Error("Missing test secret.");
    }
    return value;
  }
}

function key(role: SecretRole, generation: string): string {
  return `${role}@${generation}`;
}

function createPaths() {
  const root = mkdtempSync(path.join(tmpdir(), "convo-caddy-storage-"));
  temporaryDirectories.push(root);
  return resolveDesktopPaths({
    applicationSupportDirectory: path.join(root, "Application Support"),
    logsDirectory: path.join(root, "Logs"),
  });
}

function writePrivateSettings(
  paths: ReturnType<typeof createPaths>,
  settings: unknown,
) {
  mkdirSync(paths.configDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.applicationRoot, 0o700);
  chmodSync(paths.configDirectory, 0o700);
  writeFileSync(paths.connectionSettingsFile, `${JSON.stringify(settings)}\n`, {
    mode: 0o600,
  });
  chmodSync(paths.connectionSettingsFile, 0o600);
}

function saveInput() {
  const connection = connectionConfigurationFromSettings(
    defaultConnectionSettings(),
  );
  connection.ngrok.domain = "example.ngrok.app";
  connection.hermes = {
    mode: "ssh",
    localPort: 18642,
    remotePort: 28642,
    sshTarget: "operator@host.example",
    endpointPath: "/p/research",
    profile: "synthetic-model",
  };
  return {
    connection,
    replacements: {
      "recall-api-key": "synthetic-recall-key",
      "recall-webhook-verification-secret":
        "whsec_ZGVza3RvcC10ZXN0LXNlY3JldA==",
      "ngrok-authtoken": "synthetic-ngrok-token",
      "hermes-api-key": "synthetic-hermes-key",
    },
  };
}
