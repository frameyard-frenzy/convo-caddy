import { z } from "zod";
import type { CaptureProvider } from "./capture/capture-provider.js";
import { RecallCaptureProvider } from "./capture/recall/recall-capture-provider.js";
import { FakeMartyProvider } from "./marty/fake-marty-provider.js";
import {
  HermesMartyProvider,
  normalizeHermesBaseUrl,
} from "./marty/hermes-marty-provider.js";
import type { MartyProvider } from "./marty/marty-provider.js";
import { UnavailableMartyProvider } from "./marty/unavailable-marty-provider.js";

const environmentSchema = z.object({
  CONVO_CADDY_HOST: z.enum(["127.0.0.1", "localhost", "::1"]).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  CONVO_CADDY_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  CONVO_CADDY_TEST_MODE: z.enum(["0", "1"]).optional(),
  CONVO_CADDY_HERMES_URL: z.string().optional(),
  CONVO_CADDY_HERMES_API_KEY: z.string().optional(),
  CONVO_CADDY_HERMES_MODEL: z.string().trim().min(1).optional(),
  CONVO_CADDY_HERMES_MAX_INPUT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  CONVO_CADDY_HERMES_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CONVO_CADDY_RECALL_API_KEY: z.string().optional(),
  CONVO_CADDY_RECALL_VERIFICATION_SECRET: z.string().optional(),
  CONVO_CADDY_RECALL_WEBHOOK_URL: z.string().optional(),
  CONVO_CADDY_RECALL_WEBHOOK_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .optional(),
  CONVO_CADDY_RECALL_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

export type MartyConfig =
  | { kind: "fake" }
  | { kind: "unavailable" }
  | ({ kind: "hermes" } & Omit<
      ConstructorParameters<typeof HermesMartyProvider>[0],
      "fetchImpl"
    >);

export type CaptureConfig =
  | { kind: "unavailable" }
  | {
      kind: "recall";
      region: "us-west-2";
      apiKey: string;
      webhookUrl: string;
      verificationSecret: string;
      host: "127.0.0.1";
      port: number;
      timeoutMs: number;
    };

export type ServerConfig = {
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  testMode: boolean;
  marty: MartyConfig;
  capture: CaptureConfig;
};

export function loadServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const parsed = environmentSchema.parse(environment);
  const testMode = parsed.CONVO_CADDY_TEST_MODE === "1";
  if (testMode && parsed.NODE_ENV === "production") {
    throw new Error("CONVO_CADDY_TEST_MODE must not be enabled in production.");
  }
  const apiKey = parsed.CONVO_CADDY_HERMES_API_KEY?.trim() ?? "";
  const model = parsed.CONVO_CADDY_HERMES_MODEL?.trim() ?? "";
  const hermesHasAnyConfiguration =
    Boolean(apiKey || model) ||
    parsed.CONVO_CADDY_HERMES_URL !== undefined ||
    parsed.CONVO_CADDY_HERMES_MAX_INPUT_BYTES !== undefined ||
    parsed.CONVO_CADDY_HERMES_TIMEOUT_MS !== undefined;

  let marty: MartyConfig;
  if (testMode) {
    marty = { kind: "fake" };
  } else if (!hermesHasAnyConfiguration) {
    marty = { kind: "unavailable" };
  } else if (!apiKey || !model) {
    throw new Error(
      "Hermes configuration must include an API key and explicit model route.",
    );
  } else {
    marty = {
      kind: "hermes",
      baseUrl: normalizeHermesBaseUrl(
        parsed.CONVO_CADDY_HERMES_URL ?? "http://127.0.0.1:8642",
      ),
      apiKey,
      model,
      maxInputBytes: parsed.CONVO_CADDY_HERMES_MAX_INPUT_BYTES ?? 60_000,
      timeoutMs: parsed.CONVO_CADDY_HERMES_TIMEOUT_MS ?? 30_000,
    };
  }

  const applicationPort = parsed.CONVO_CADDY_PORT ?? 4317;
  const recallApiKey = parsed.CONVO_CADDY_RECALL_API_KEY?.trim() ?? "";
  const verificationSecret =
    parsed.CONVO_CADDY_RECALL_VERIFICATION_SECRET?.trim() ?? "";
  const webhookUrl = parsed.CONVO_CADDY_RECALL_WEBHOOK_URL?.trim() ?? "";
  const recallValues = [recallApiKey, verificationSecret, webhookUrl];
  const recallConfigured = recallValues.every(Boolean);
  const recallHasAnyConfiguration =
    recallValues.some(Boolean) ||
    parsed.CONVO_CADDY_RECALL_WEBHOOK_PORT !== undefined ||
    parsed.CONVO_CADDY_RECALL_TIMEOUT_MS !== undefined;
  if (!recallConfigured && recallHasAnyConfiguration) {
    throw new Error(
      "Recall capture configuration must be supplied as a complete set.",
    );
  }

  let capture: CaptureConfig = { kind: "unavailable" };
  if (recallConfigured) {
    if (testMode) {
      throw new Error("Recall capture must not be enabled in test mode.");
    }
    validateRecallVerificationSecret(verificationSecret);
    validateRecallWebhookUrl(webhookUrl);
    const webhookPort = parsed.CONVO_CADDY_RECALL_WEBHOOK_PORT ?? 4318;
    if (webhookPort === applicationPort) {
      throw new Error(
        "Recall webhook port must differ from the application port.",
      );
    }
    capture = {
      kind: "recall",
      region: "us-west-2",
      apiKey: recallApiKey,
      webhookUrl,
      verificationSecret,
      host: "127.0.0.1",
      port: webhookPort,
      timeoutMs: parsed.CONVO_CADDY_RECALL_TIMEOUT_MS ?? 30_000,
    };
  }

  return {
    host: parsed.CONVO_CADDY_HOST ?? "127.0.0.1",
    port: applicationPort,
    testMode,
    marty,
    capture,
  };
}

export function createConfiguredMartyProvider(
  config: MartyConfig,
): MartyProvider {
  if (config.kind === "fake") {
    return new FakeMartyProvider();
  }
  if (config.kind === "hermes") {
    return new HermesMartyProvider(config);
  }
  return new UnavailableMartyProvider();
}

export function createConfiguredCaptureProvider(
  config: CaptureConfig,
): CaptureProvider | undefined {
  if (config.kind === "unavailable") {
    return undefined;
  }
  return new RecallCaptureProvider({
    region: config.region,
    apiKey: config.apiKey,
    webhookUrl: config.webhookUrl,
    timeoutMs: config.timeoutMs,
  });
}

function validateRecallVerificationSecret(secret: string): void {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : "";
  if (
    !encoded ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    Buffer.from(encoded, "base64").byteLength === 0
  ) {
    throw new Error("Recall webhook secret must be a whsec_ secret.");
  }
}

function validateRecallWebhookUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Recall webhook URL must be an HTTPS webhook endpoint.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/capture/recall/webhook"
  ) {
    throw new Error("Recall webhook URL must be an HTTPS webhook endpoint.");
  }
  if (!url.hostname.endsWith(".ngrok-free.dev")) {
    throw new Error("Recall webhook URL must use an ngrok-free.dev hostname.");
  }
}
