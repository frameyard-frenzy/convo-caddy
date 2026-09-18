import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDesktopConfig } from "../../src/server/desktop/config.js";
import type { ActiveConnectionAuthority } from "../../src/server/desktop/connection-storage.js";
import { resolveDesktopPaths } from "../../src/server/desktop/paths.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop paths", () => {
  it("resolves canonical settings, workspace, Electron, and log roots without using the checkout", () => {
    const library = path.join(createTemporaryDirectory(), "Library");
    const paths = resolveDesktopPaths({
      applicationSupportDirectory: path.join(library, "Application Support"),
      logsDirectory: path.join(library, "Logs"),
    });

    expect(paths).toEqual({
      applicationRoot: path.join(library, "Application Support", "Convo Caddy"),
      configDirectory: path.join(
        library,
        "Application Support",
        "Convo Caddy",
        "config",
      ),
      connectionSettingsFile: path.join(
        library,
        "Application Support",
        "Convo Caddy",
        "config",
        "connections.json",
      ),
      preferencesFile: path.join(
        library,
        "Application Support",
        "Convo Caddy",
        "config",
        "preferences.json",
      ),
      electronDirectory: path.join(
        library,
        "Application Support",
        "Convo Caddy",
        "electron",
      ),
      logsDirectory: path.join(library, "Logs", "Convo Caddy"),
    });
  });
});

describe("active desktop connection authority", () => {
  it("derives the existing packaged runtime without mutating process.env", () => {
    const beforeEnvironment = { ...process.env };
    const config = buildDesktopConfig(authority());

    expect(process.env).toEqual(beforeEnvironment);
    expect(config).toMatchObject({
      connectivity: {
        ngrok: {
          authtoken: "ngrok-owner-token",
          approvedDomain: "example.ngrok.app",
        },
        hermes: {
          kind: "configured",
          mode: "ssh",
          baseUrl: "http://127.0.0.1:8642",
          apiKey: "hermes-owner-token",
          profile: "research",
          localPort: 8642,
          remotePort: 8642,
          sshTarget: "interviewer@agent-mac.local",
        },
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        testMode: false,
        marty: {
          kind: "hermes",
          baseUrl: "http://127.0.0.1:8642",
          model: "research",
        },
        capture: {
          kind: "recall",
          region: "us-west-2",
          host: "127.0.0.1",
          port: 0,
          webhookUrl: "https://example.ngrok.app/api/capture/recall/webhook",
        },
      },
    });
    if (
      config.connectivity.hermes.kind !== "configured" ||
      config.server.marty.kind !== "hermes"
    ) {
      throw new Error("Expected configured Hermes desktop runtime.");
    }
    expect(config.connectivity.hermes.dispatchAuthority).toBe(
      config.server.marty.dispatchAuthority,
    );
  });

  it("configures same-Mac Hermes without an SSH target", () => {
    const input = authority();
    input.connection.hermes.mode = "local";
    input.connection.hermes.sshTarget = null;

    expect(buildDesktopConfig(input)).toMatchObject({
      connectivity: {
        hermes: {
          kind: "configured",
          mode: "local",
          localPort: 8642,
          remotePort: 8642,
          sshTarget: null,
          profile: "research",
        },
      },
      server: { marty: { kind: "hermes", model: "research" } },
    });
  });

  it("keeps deterministic behavior available when Hermes is not configured", () => {
    const input = authority();
    delete input.secrets["hermes-api-key"];

    expect(buildDesktopConfig(input)).toMatchObject({
      connectivity: { hermes: { kind: "unavailable" } },
      server: { marty: { kind: "unavailable" } },
    });

    const disabled = authority();
    disabled.connection.hermes = {
      mode: null,
      localPort: 8642,
      remotePort: 8642,
      sshTarget: null,
      endpointPath: "/",
      profile: null,
    };
    expect(buildDesktopConfig(disabled)).toMatchObject({
      connectivity: { hermes: { kind: "unavailable" } },
      server: { marty: { kind: "unavailable" } },
    });
  });

  it("fails closed without reflecting invalid stored secret values", () => {
    for (const input of [
      (() => {
        const value = authority();
        delete value.secrets["recall-api-key"];
        return value;
      })(),
      (() => {
        const value = authority();
        value.secrets["recall-webhook-verification-secret"] =
          "must-not-appear-invalid";
        return value;
      })(),
      (() => {
        const value = authority();
        value.connection.hermes.profile = null;
        return value;
      })(),
    ]) {
      let message = "";
      try {
        buildDesktopConfig(input);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/incomplete|invalid/);
      expect(message).not.toContain("must-not-appear-invalid");
      expect(message).not.toContain("hermes-owner-token");
    }
  });
});

function authority(): ActiveConnectionAuthority {
  return {
    generation: "00000000-0000-4000-8000-000000000001",
    connection: {
      recall: { region: "us-west-2", language: "en" },
      ngrok: { domain: "example.ngrok.app" },
      hermes: {
        mode: "ssh",
        localPort: 8642,
        remotePort: 8642,
        sshTarget: "interviewer@agent-mac.local",
        endpointPath: "/",
        profile: "research",
      },
    },
    secrets: {
      "recall-api-key": "runtime-test-recall-key",
      "recall-webhook-verification-secret":
        "whsec_ZGVza3RvcC10ZXN0LXNlY3JldA==",
      "ngrok-authtoken": "ngrok-owner-token",
      "hermes-api-key": "hermes-owner-token",
    },
  };
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "convo-caddy-desktop-"));
  temporaryDirectories.push(directory);
  return directory;
}
