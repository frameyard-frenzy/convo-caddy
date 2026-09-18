import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startOwnedDesktopRuntime } from "../../src/desktop/runtime-owner.js";
import {
  defaultConnectionSettings,
  type ConnectionSettings,
} from "../../src/server/desktop/connection-settings.js";
import type { ConnectionStorageStatus } from "../../src/server/desktop/connection-storage.js";
import { resolveDesktopPaths } from "../../src/server/desktop/paths.js";
import {
  LOCAL_API_COOKIE_NAME,
  LocalApiAccess,
} from "../../src/server/security/local-api-access.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop runtime owner", () => {
  it("serves authenticated setup before checking ngrok or creating provider resources", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "convo-caddy-desktop-owner-"));
    temporaryDirectories.push(root);
    const paths = resolveDesktopPaths({
      applicationSupportDirectory: path.join(root, "Application Support"),
      logsDirectory: path.join(root, "Logs"),
    });
    let checks = 0;

    const localApiAccess = new LocalApiAccess("e".repeat(43));
    const runtime = await startOwnedDesktopRuntime({
      paths,
      clientDirectory: path.join(root, "missing-client"),
      localApiAccess,
      requestReload: async () => "reloaded",
      verifyNgrokRuntime: async () => {
        checks += 1;
      },
    });

    try {
      expect(runtime.mode).toBe("setup");
      const response = await fetch(runtime.applicationUrl, {
        headers: {
          Cookie: `${LOCAL_API_COOKIE_NAME}=${"e".repeat(43)}`,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<h1>Connection settings</h1>");
    } finally {
      await runtime.close();
    }
    expect(checks).toBe(0);
  });

  it("creates private nonsecret settings but never creates a plaintext template", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "convo-caddy-desktop-owner-"));
    temporaryDirectories.push(root);
    const paths = resolveDesktopPaths({
      applicationSupportDirectory: path.join(root, "Application Support"),
      logsDirectory: path.join(root, "Logs"),
    });

    const runtime = await startOwnedDesktopRuntime({
      paths,
      clientDirectory: path.join(root, "missing-client"),
      localApiAccess: new LocalApiAccess("e".repeat(43)),
      requestReload: async () => "reloaded",
    });

    expect(existsSync(path.join(paths.configDirectory, ".env"))).toBe(false);
    expect(existsSync(paths.connectionSettingsFile)).toBe(true);
    expect(statSync(paths.connectionSettingsFile).mode & 0o777).toBe(0o600);
    expect(runtime.mode).toBe("setup");
    await runtime.close();
  });

  it("forces an already-configured installation into setup without loading secrets or connectivity", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "convo-caddy-desktop-owner-"));
    temporaryDirectories.push(root);
    const paths = resolveDesktopPaths({
      applicationSupportDirectory: path.join(root, "Application Support"),
      logsDirectory: path.join(root, "Logs"),
    });
    const generation = "123e4567-e89b-42d3-a456-426614174000";
    const settings: ConnectionSettings = {
      ...defaultConnectionSettings(),
      activeSecretGeneration: generation,
      configuredSecretRoles: [
        "recall-api-key",
        "recall-webhook-verification-secret",
        "ngrok-authtoken",
      ],
      legacyMigration: { state: "complete" as const },
    };
    const status: ConnectionStorageStatus = {
      kind: "ready" as const,
      settings,
      configured: {
        recallApiKey: true,
        recallWebhookVerificationSecret: true,
        ngrokAuthtoken: true,
        hermesApiKey: false,
      },
      cleanupPending: false,
    };
    const storage = {
      initialize: vi.fn(async () => status),
      resetCredentials: vi.fn(async () => status),
      loadActiveAuthority: vi.fn(async () => null),
      save: vi.fn(async () => status),
    };
    const verifyNgrokRuntime = vi.fn(async () => undefined);
    const runtime = await startOwnedDesktopRuntime({
      paths,
      clientDirectory: path.join(root, "missing-client"),
      localApiAccess: new LocalApiAccess("e".repeat(43)),
      forceSetup: true,
      requestReload: async () => "reloaded",
      connectionStorage: storage,
      verifyNgrokRuntime,
    });

    try {
      expect(runtime.mode).toBe("setup");
      const response = await fetch(runtime.applicationUrl, {
        headers: {
          Cookie: `${LOCAL_API_COOKIE_NAME}=${"e".repeat(43)}`,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<h1>Connection settings</h1>");
    } finally {
      await runtime.close();
    }
    expect(storage.loadActiveAuthority).not.toHaveBeenCalled();
    expect(verifyNgrokRuntime).not.toHaveBeenCalled();
  });
});
