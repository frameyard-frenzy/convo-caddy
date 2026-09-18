import { startDesktopSetupRuntime } from "../src/desktop/setup-runtime.js";
import {
  defaultConnectionSettings,
  connectionConfigurationFromSettings,
} from "../src/server/desktop/connection-settings.js";
import type { ConnectionStorageStatus } from "../src/server/desktop/connection-storage.js";
import { LocalApiAccess } from "../src/server/security/local-api-access.js";

const token = "setup_fixture_token_12345678901234567890123";

function initialStatus(): ConnectionStorageStatus {
  return {
    kind: "setup_required",
    settings: defaultConnectionSettings(),
    configured: {
      recallApiKey: false,
      recallWebhookVerificationSecret: false,
      ngrokAuthtoken: false,
      hermesApiKey: false,
    },
    cleanupPending: false,
  };
}

let status: ConnectionStorageStatus = initialStatus();
const delay = () => new Promise((resolve) => setTimeout(resolve, 120));

const runtime = await startDesktopSetupRuntime({
  listenPort: Number(process.env.CONVO_CADDY_SETUP_FIXTURE_PORT ?? 4318),
  localApiAccess: new LocalApiAccess(token),
  initialStatus: status,
  storage: {
    initialize: async () => status,
    loadActiveAuthority: async () =>
      status.kind === "ready" && status.settings.activeSecretGeneration !== null
        ? {
            generation: status.settings.activeSecretGeneration,
            connection: connectionConfigurationFromSettings(status.settings),
            secrets: {
              "recall-api-key": status.configured.recallApiKey
                ? "saved-recall"
                : undefined,
              "recall-webhook-verification-secret": status.configured
                .recallWebhookVerificationSecret
                ? "whsec_c3ludGhldGlj"
                : undefined,
              "ngrok-authtoken": status.configured.ngrokAuthtoken
                ? "saved-ngrok"
                : undefined,
              "hermes-api-key": status.configured.hermesApiKey
                ? "saved-hermes"
                : undefined,
            },
          }
        : null,
    resetCredentials: async () => {
      status = initialStatus();
      return status;
    },
    save: async ({ connection, replacements }) => {
      await delay();
      if (replacements["recall-api-key"] === "fail-save") {
        throw new Error("synthetic failure");
      }
      status = {
        kind: "ready",
        settings: {
          ...defaultConnectionSettings(),
          ...connection,
          activeSecretGeneration: "00000000-0000-4000-8000-000000000001",
          configuredSecretRoles: [
            ...(status.configured.recallApiKey || replacements["recall-api-key"]
              ? (["recall-api-key"] as const)
              : []),
            ...(status.configured.recallWebhookVerificationSecret ||
            replacements["recall-webhook-verification-secret"]
              ? (["recall-webhook-verification-secret"] as const)
              : []),
            ...(status.configured.ngrokAuthtoken ||
            replacements["ngrok-authtoken"]
              ? (["ngrok-authtoken"] as const)
              : []),
            ...(status.configured.hermesApiKey || replacements["hermes-api-key"]
              ? (["hermes-api-key"] as const)
              : []),
          ] as never,
        },
        configured: {
          recallApiKey:
            Boolean(replacements["recall-api-key"]) ||
            status.configured.recallApiKey,
          recallWebhookVerificationSecret:
            Boolean(replacements["recall-webhook-verification-secret"]) ||
            status.configured.recallWebhookVerificationSecret,
          ngrokAuthtoken:
            Boolean(replacements["ngrok-authtoken"]) ||
            status.configured.ngrokAuthtoken,
          hermesApiKey:
            Boolean(replacements["hermes-api-key"]) ||
            status.configured.hermesApiKey,
        },
        cleanupPending: false,
      };
      return status;
    },
  },
  connectionTester: {
    test: async (input) => {
      await delay();
      if (input.recallApiKey === "fail-test")
        throw new Error("synthetic failure");
      return {
        generation: input.generation,
        recallCredentials: { state: "authenticated_read_only" },
        localWebhook: { state: "verified_synthetic" },
        ngrokEndpoint: { state: "verified_exact_domain" },
        publicWebhook: { state: "verified_synthetic" },
        webhookAuthenticity: { state: "verified_in_automation" },
        botCreation: { state: "not_attempted" },
        retention: {
          requestedMedia: "none",
          providerConfirmation: "not_observed",
          accountMetadata: "unknown",
          localManagedDays: 7,
        },
      };
    },
  },
  hermesConnectionTester: {
    discover: async (input) => {
      await delay();
      return input.apiKey === "fail-hermes"
        ? { generation: input.generation, state: "authentication_rejected" }
        : {
            generation: input.generation,
            state: "profiles_advertised",
            profiles: ["everyday", "backup"],
          };
    },
    testAssistant: async (input) => {
      await delay();
      return {
        generation: input.generation,
        state:
          input.profile === "backup"
            ? "response_rejected"
            : "assistant_verified_synthetic",
      };
    },
  },
  requestReload: async () => "reloaded",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(
    signal,
    () => void runtime.close().finally(() => process.exit(0)),
  );
}
