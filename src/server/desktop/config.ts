import type { ServerConfig } from "../config.js";
import type { ConnectivityConfig } from "../connectivity/connectivity-supervisor.js";
import { normalizeHermesBaseUrl } from "../marty/hermes-marty-provider.js";
import { HermesDispatchAuthority } from "../marty/hermes-dispatch-authority.js";
import type { ActiveConnectionAuthority } from "./connection-storage.js";

const RECALL_WEBHOOK_PATH = "/api/capture/recall/webhook";

export type DesktopConfig = {
  connectivity: ConnectivityConfig;
  server: ServerConfig;
};

export class DesktopConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopConfigError";
  }
}

export function buildDesktopConfig(
  authority: ActiveConnectionAuthority,
): DesktopConfig {
  const domain = authority.connection.ngrok.domain;
  if (domain === null) {
    throw new DesktopConfigError("Desktop ngrok domain is not configured.");
  }
  const recallApiKey = requireSecret(authority, "recall-api-key");
  const verificationSecret = requireSecret(
    authority,
    "recall-webhook-verification-secret",
  );
  validateRecallVerificationSecret(verificationSecret);
  const ngrokAuthtoken = requireSecret(authority, "ngrok-authtoken");
  const hermesApiKey = optionalSecret(authority, "hermes-api-key");
  const webhookUrl = `https://${domain}${RECALL_WEBHOOK_PATH}`;
  const hermes = buildHermesConfig(authority, hermesApiKey);

  return {
    connectivity: {
      ngrok: { authtoken: ngrokAuthtoken, approvedDomain: domain },
      hermes: hermes.connectivity,
    },
    server: {
      host: "127.0.0.1",
      port: 0,
      testMode: false,
      marty: hermes.server,
      capture: {
        kind: "recall",
        region: "us-west-2",
        apiKey: recallApiKey,
        webhookUrl,
        verificationSecret,
        host: "127.0.0.1",
        port: 0,
        timeoutMs: 30_000,
      },
    },
  };
}

function buildHermesConfig(
  authority: ActiveConnectionAuthority,
  apiKey: string,
): {
  connectivity: ConnectivityConfig["hermes"];
  server: ServerConfig["marty"];
} {
  const hermes = authority.connection.hermes;
  if (!apiKey || hermes.mode === null) {
    return {
      connectivity: { kind: "unavailable" },
      server: { kind: "unavailable" },
    };
  }
  if (
    !hermes.profile ||
    (hermes.mode === "ssh" && !hermes.sshTarget) ||
    (hermes.mode === "local" && hermes.sshTarget !== null)
  ) {
    throw new DesktopConfigError(
      "Desktop Hermes settings are incomplete or invalid.",
    );
  }
  const baseUrl = normalizeHermesBaseUrl(
    `http://127.0.0.1:${hermes.localPort}${hermes.endpointPath === "/" ? "" : hermes.endpointPath}`,
  );
  const dispatchAuthority = new HermesDispatchAuthority();
  return {
    connectivity: {
      kind: "configured",
      mode: hermes.mode,
      baseUrl,
      apiKey,
      profile: hermes.profile,
      localPort: hermes.localPort,
      remotePort: hermes.remotePort,
      sshTarget: hermes.sshTarget,
      dispatchAuthority,
    },
    server: {
      kind: "hermes",
      baseUrl,
      apiKey,
      model: hermes.profile,
      maxInputBytes: 60_000,
      timeoutMs: 30_000,
      dispatchAuthority,
    },
  };
}

function requireSecret(
  authority: ActiveConnectionAuthority,
  role:
    | "recall-api-key"
    | "recall-webhook-verification-secret"
    | "ngrok-authtoken",
): string {
  const value = authority.secrets[role]?.trim();
  if (!value) {
    throw new DesktopConfigError(
      "Desktop Keychain configuration is incomplete.",
    );
  }
  return value;
}

function optionalSecret(
  authority: ActiveConnectionAuthority,
  role: "hermes-api-key",
): string {
  return authority.secrets[role]?.trim() ?? "";
}

function validateRecallVerificationSecret(secret: string): void {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : "";
  if (
    !encoded ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    Buffer.from(encoded, "base64").byteLength === 0
  ) {
    throw new DesktopConfigError(
      "Desktop Recall verification secret has an invalid stored format.",
    );
  }
}
