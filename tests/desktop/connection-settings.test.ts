import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTION_SETTINGS_SCHEMA_VERSION,
  createConnectionSettings,
  defaultConnectionSettings,
  loadConnectionSettings,
  writeConnectionSettings,
} from "../../src/server/desktop/connection-settings.js";
import { resolveDesktopPaths } from "../../src/server/desktop/paths.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop connection settings", () => {
  it("creates a strict owner-private fresh document without personal defaults or secrets", () => {
    const paths = createPaths();

    expect(createConnectionSettings(paths)).toBe("created");
    expect(createConnectionSettings(paths)).toBe("existing");
    expect(lstatSync(paths.configDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.connectionSettingsFile).mode & 0o777).toBe(0o600);
    expect(loadConnectionSettings(paths)).toEqual(defaultConnectionSettings());

    const persisted = readFileSync(paths.connectionSettingsFile, "utf8");
    expect(persisted).toContain(
      `"schemaVersion": ${CONNECTION_SETTINGS_SCHEMA_VERSION}`,
    );
    expect(persisted).toContain('"region": "us-west-2"');
    expect(persisted).toContain('"language": "en"');
    expect(persisted).not.toMatch(/api[_-]?key|authtoken|whsec_/i);
  });

  it.each([1, 2, 3])(
    "rejects schema %s without rewriting it",
    (schemaVersion) => {
      const paths = createPaths();
      createConnectionSettings(paths);
      const old = defaultConnectionSettings();
      const input = { ...old, schemaVersion } as Record<string, unknown>;
      const hermes = { ...old.hermes } as Record<string, unknown>;
      delete hermes.endpointPath;
      input.hermes = hermes;
      if (schemaVersion === 1) input.recall = { region: "us-west-2" };
      const bytes = JSON.stringify(input);
      writeFileSync(paths.connectionSettingsFile, bytes);
      expect(() => loadConnectionSettings(paths)).toThrow(
        "Desktop connection settings are invalid",
      );
      expect(readFileSync(paths.connectionSettingsFile, "utf8")).toBe(bytes);
    },
  );

  it("round-trips only strict bounded nonsecret settings", () => {
    const paths = createPaths();
    createConnectionSettings(paths);
    const settings = defaultConnectionSettings();
    settings.ngrok.domain = "example.ngrok.app";
    settings.hermes = {
      mode: "ssh",
      localPort: 8643,
      remotePort: 8642,
      sshTarget: "interviewer@agent-mac.local",
      endpointPath: "/",
      profile: null,
    };
    settings.activeSecretGeneration = "00000000-0000-4000-8000-000000000001";
    settings.configuredSecretRoles = [
      "recall-api-key",
      "recall-webhook-verification-secret",
      "ngrok-authtoken",
    ];
    settings.legacyMigration = { state: "complete" };

    writeConnectionSettings(paths, settings);

    expect(loadConnectionSettings(paths)).toEqual(settings);
  });

  it("fails closed for unknown fields, future versions, and invalid connection fields", () => {
    const paths = createPaths();
    createConnectionSettings(paths);
    const base = defaultConnectionSettings();

    for (const invalid of [
      { ...base, unknown: true },
      { ...base, schemaVersion: 5 },
      {
        ...base,
        activeSecretGeneration: "018f3d70-7c21-7a12-8f5d-123456789abc",
      },
      {
        ...base,
        hermes: {
          mode: "local",
          localPort: 0,
          remotePort: 8642,
          sshTarget: null,
          profile: null,
        },
      },
      {
        ...base,
        hermes: {
          mode: "ssh",
          localPort: 8642,
          remotePort: 8642,
          sshTarget: "-Ffoo",
          profile: null,
        },
      },
      {
        ...base,
        ngrok: { domain: "https://example.ngrok.app/path" },
      },
      {
        ...base,
        hermes: {
          mode: "ssh",
          localPort: 8642,
          remotePort: 8642,
          sshTarget: "user name@example.local",
          profile: null,
        },
      },
    ]) {
      writeFileSync(
        paths.connectionSettingsFile,
        `${JSON.stringify(invalid)}\n`,
        { mode: 0o600 },
      );
      chmodSync(paths.connectionSettingsFile, 0o600);
      expect(() => loadConnectionSettings(paths)).toThrow(
        "Desktop connection settings are invalid",
      );
    }
  });

  it("rejects symlink and broadly readable settings without normalizing them", () => {
    const paths = createPaths();
    createConnectionSettings(paths);
    chmodSync(paths.connectionSettingsFile, 0o640);
    expect(() => loadConnectionSettings(paths)).toThrow("owner-private");
    expect(lstatSync(paths.connectionSettingsFile).mode & 0o777).toBe(0o640);

    rmSync(paths.connectionSettingsFile);
    const external = path.join(createTemporaryDirectory(), "connections.json");
    writeFileSync(
      external,
      `${JSON.stringify(defaultConnectionSettings())}\n`,
      {
        mode: 0o600,
      },
    );
    symlinkSync(external, paths.connectionSettingsFile);
    expect(() => loadConnectionSettings(paths)).toThrow("symbolic link");
  });
});

function createPaths() {
  const root = createTemporaryDirectory();
  return resolveDesktopPaths({
    applicationSupportDirectory: path.join(root, "Application Support"),
    logsDirectory: path.join(root, "Logs"),
  });
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(
    path.join(tmpdir(), "convo-caddy-connections-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}
