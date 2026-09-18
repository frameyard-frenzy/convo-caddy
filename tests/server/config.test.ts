import { describe, expect, it } from "vitest";
import { loadServerConfig } from "../../src/server/config.js";

describe("server config", () => {
  it("starts with Marty unavailable when no Hermes credential is supplied", () => {
    expect(loadServerConfig({})).toMatchObject({
      marty: { kind: "unavailable" },
      capture: { kind: "unavailable" },
    });
  });

  it("uses fake Marty only in explicit test mode", () => {
    expect(
      loadServerConfig({
        CONVO_CADDY_TEST_MODE: "1",
        CONVO_CADDY_HERMES_API_KEY: "must-not-be-used",
      }).marty,
    ).toEqual({ kind: "fake" });
  });

  it("builds the loopback Hermes configuration from an explicit key and profile", () => {
    expect(
      loadServerConfig({
        CONVO_CADDY_HERMES_API_KEY: "local-hermes-token",
        CONVO_CADDY_HERMES_MODEL: "research",
      }),
    ).toMatchObject({
      host: "127.0.0.1",
      port: 4317,
      testMode: false,
      marty: {
        kind: "hermes",
        baseUrl: "http://127.0.0.1:8642",
        apiKey: "local-hermes-token",
        model: "research",
        maxInputBytes: 60_000,
        timeoutMs: 30_000,
      },
    });
  });

  it.each([
    { CONVO_CADDY_HERMES_API_KEY: "local-hermes-token" },
    { CONVO_CADDY_HERMES_MODEL: "research" },
    { CONVO_CADDY_HERMES_TIMEOUT_MS: "1000" },
  ])("rejects partial developer Hermes configuration", (environment) => {
    expect(() => loadServerConfig(environment)).toThrow(
      "Hermes configuration must include an API key and explicit model route.",
    );
  });

  it("rejects invalid host, numeric, and Hermes URL configuration", () => {
    expect(() => loadServerConfig({ CONVO_CADDY_HOST: "0.0.0.0" })).toThrow();
    expect(() => loadServerConfig({ CONVO_CADDY_PORT: "invalid" })).toThrow();
    expect(() =>
      loadServerConfig({
        CONVO_CADDY_HERMES_API_KEY: "local-hermes-token",
        CONVO_CADDY_HERMES_MODEL: "research",
        CONVO_CADDY_HERMES_URL: "http://192.168.1.10:8642",
      }),
    ).toThrow("Hermes URL must use loopback HTTP");

    expect(() =>
      loadServerConfig({
        CONVO_CADDY_HERMES_API_KEY: "secret",
        CONVO_CADDY_HERMES_MODEL: "research",
        CONVO_CADDY_HERMES_URL: "https://remote-hermes.example",
      }),
    ).toThrow("Hermes URL must use loopback HTTP");
  });

  it("rejects production startup when test-only fake Marty is enabled", () => {
    expect(() =>
      loadServerConfig({
        NODE_ENV: "production",
        CONVO_CADDY_TEST_MODE: "1",
      }),
    ).toThrow("CONVO_CADDY_TEST_MODE must not be enabled in production.");
  });

  it("builds one fail-closed Recall configuration only from the complete credential set", () => {
    expect(
      loadServerConfig({
        CONVO_CADDY_RECALL_API_KEY: "local-recall-key",
        CONVO_CADDY_RECALL_VERIFICATION_SECRET: "whsec_cGhhc2UtNC1zZWNyZXQ=",
        CONVO_CADDY_RECALL_WEBHOOK_URL:
          "https://interviews.example.ngrok-free.dev/api/capture/recall/webhook",
      }).capture,
    ).toEqual({
      kind: "recall",
      region: "us-west-2",
      apiKey: "local-recall-key",
      webhookUrl:
        "https://interviews.example.ngrok-free.dev/api/capture/recall/webhook",
      verificationSecret: "whsec_cGhhc2UtNC1zZWNyZXQ=",
      host: "127.0.0.1",
      port: 4318,
      timeoutMs: 30_000,
    });
  });

  it("rejects partial, test/live, and overlapping Recall configuration", () => {
    expect(() =>
      loadServerConfig({ CONVO_CADDY_RECALL_API_KEY: "local-recall-key" }),
    ).toThrow(
      "Recall capture configuration must be supplied as a complete set",
    );
    expect(() =>
      loadServerConfig({ CONVO_CADDY_RECALL_WEBHOOK_PORT: "4319" }),
    ).toThrow(
      "Recall capture configuration must be supplied as a complete set",
    );

    expect(() =>
      loadServerConfig({
        CONVO_CADDY_TEST_MODE: "1",
        CONVO_CADDY_RECALL_API_KEY: "local-recall-key",
        CONVO_CADDY_RECALL_VERIFICATION_SECRET: "whsec_cGhhc2UtNC1zZWNyZXQ=",
        CONVO_CADDY_RECALL_WEBHOOK_URL:
          "https://example.ngrok-free.dev/api/capture/recall/webhook",
      }),
    ).toThrow("Recall capture must not be enabled in test mode.");

    expect(() =>
      loadServerConfig({
        CONVO_CADDY_PORT: "4318",
        CONVO_CADDY_RECALL_API_KEY: "local-recall-key",
        CONVO_CADDY_RECALL_VERIFICATION_SECRET: "whsec_cGhhc2UtNC1zZWNyZXQ=",
        CONVO_CADDY_RECALL_WEBHOOK_URL:
          "https://interviews.example.ngrok-free.dev/api/capture/recall/webhook",
      }),
    ).toThrow("Recall webhook port must differ from the application port.");
  });

  it("rejects malformed Recall secrets and callback URLs", () => {
    expect(() =>
      loadServerConfig({
        CONVO_CADDY_RECALL_API_KEY: "local-recall-key",
        CONVO_CADDY_RECALL_VERIFICATION_SECRET: "not-a-secret",
        CONVO_CADDY_RECALL_WEBHOOK_URL:
          "https://example.ngrok-free.dev/api/capture/recall/webhook",
      }),
    ).toThrow("Recall webhook secret must be a whsec_ secret.");

    expect(() =>
      loadServerConfig({
        CONVO_CADDY_RECALL_API_KEY: "local-recall-key",
        CONVO_CADDY_RECALL_VERIFICATION_SECRET: "whsec_cGhhc2UtNC1zZWNyZXQ=",
        CONVO_CADDY_RECALL_WEBHOOK_URL:
          "http://127.0.0.1:4318/api/capture/recall/webhook",
      }),
    ).toThrow("Recall webhook URL must be an HTTPS");

    expect(() =>
      loadServerConfig({
        CONVO_CADDY_RECALL_API_KEY: "local-recall-key",
        CONVO_CADDY_RECALL_VERIFICATION_SECRET: "whsec_cGhhc2UtNC1zZWNyZXQ=",
        CONVO_CADDY_RECALL_WEBHOOK_URL:
          "https://callbacks.example.com/api/capture/recall/webhook",
      }),
    ).toThrow("Recall webhook URL must use an ngrok-free.dev hostname.");
  });
});
