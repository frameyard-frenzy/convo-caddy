import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  startNgrokEndpoint,
  type NgrokEndpoint,
} from "../connectivity/ngrok-endpoint-manager.js";
import { closeHttpServer, listenOnLoopback } from "../server-lifecycle.js";
import { discoverRecallWebhookTools } from "./recall-mcp-webhook-client.js";
import {
  createReceiptServer,
  EXPERIMENT_WEBHOOK_PATH,
  ReceiptAttempt,
} from "./recall-test-receipt.js";

export const SYNTHETIC_SCENARIOS = [
  "early-callback",
  "no-receipt",
  "wrong-signature",
  "response-lost",
  "self-signed-only",
  "unrelated",
  "cancelled",
  "settings-changed",
  "endpoint-mismatch",
  "domain-collision",
  "send-rejected",
  "cleanup-failed",
] as const;
export type SyntheticScenario = (typeof SYNTHETIC_SCENARIOS)[number];
let running = false;
let cleanupBlocked = false;

/** Entire provider side is a fixture. Only HTTP to a newly owned loopback listener is real. */
export async function runSyntheticExperiment(
  scenario: SyntheticScenario,
  signal?: AbortSignal,
) {
  if (cleanupBlocked) throw new Error("cleanup_blocked");
  if (running) throw new Error("experiment_busy");
  if (!SYNTHETIC_SCENARIOS.includes(scenario))
    throw new Error("invalid_scenario");
  running = true;
  const domain = "fixture.invalid";
  const secret = `whsec_${Buffer.from("SECRET-SENTINEL-fixture-only").toString("base64")}`;
  const generation = randomUUID();
  const attempt = new ReceiptAttempt({
    secret,
    generation,
    settingsFingerprint: createHash("sha256")
      .update("fixture.invalid/us-west-2/fixture-endpoint/recording.done")
      .digest("hex"),
    now: Date.now,
    timeoutMs: 500,
  });
  const server = createReceiptServer(attempt);
  let endpoint: NgrokEndpoint | undefined;
  let fixtureSends = 0;
  let outcome: string = "unavailable";
  let discovery = "not_attempted";
  const cancel = () => attempt.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    // Port zero obtains a free, owned port; never inspect/stop/reuse another server.
    const address = await listenOnLoopback(server, 0, "127.0.0.1");
    const contract = await discoverRecallWebhookTools({
      region: "us-west-2",
      key: "SECRET-SENTINEL-fixture-only",
      fetchImpl: fixtureDiscoveryTransport,
    });
    discovery = contract.state;
    if (contract.state !== "discovered" || contract.cleanup !== "complete")
      throw new Error("fixture_discovery_failed");
    // Mandatory injected fake: no import or use of the default ngrok adapter.
    endpoint = await startNgrokEndpoint({
      approvedDomain: domain,
      authtoken: "fixture-only",
      webhook: { host: "127.0.0.1", port: address.port },
      adapter: {
        async forward(options) {
          if (scenario === "domain-collision")
            throw new Error("SECRET-SENTINEL occupied");
          return {
            url: () => `https://${options.domain}`,
            async close() {
              if (scenario === "cleanup-failed")
                throw new Error("SECRET-SENTINEL close");
            },
          };
        },
      },
    });
    const expected = `https://${domain}${EXPERIMENT_WEBHOOK_PATH}`;
    const selected =
      scenario === "endpoint-mismatch"
        ? "https://other.invalid/webhook"
        : expected;
    if (selected !== expected) {
      outcome = "configuration_rejected";
      throw new Error("fixture_precondition");
    }
    if (attempt.snapshot().outcome !== "pending") {
      outcome = attempt.snapshot().outcome;
      throw new Error("fixture_precondition");
    }
    const messageId = `fixture-${randomUUID()}`;
    fixtureSends++;
    if (scenario === "cancelled") attempt.cancel();
    if (scenario === "settings-changed") attempt.cancel("settings_changed");
    if (scenario !== "no-receipt" && scenario !== "send-rejected") {
      const id = scenario === "unrelated" ? "unrelated-message" : messageId;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        event: "recording.done",
        data: { fixtureOnly: true },
      });
      const signature = createHmac(
        "sha256",
        Buffer.from("SECRET-SENTINEL-fixture-only"),
      )
        .update(`${id}.${timestamp}.${body}`)
        .digest("base64");
      // Simulated provider callback, deliberately before the simulated send response.
      const response = await fetch(`${address.url}${EXPERIMENT_WEBHOOK_PATH}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(1000),
        body,
        headers: {
          "svix-id": id,
          "svix-timestamp": timestamp,
          "svix-signature": `v1,${scenario === "wrong-signature" ? "invalid" : signature}`,
        },
      });
      await response.body?.cancel();
    }
    // These are explicitly internal fixture fields, never Recall MCP wire fields.
    attempt.fixtureSendResult(
      scenario === "response-lost" || scenario === "self-signed-only"
        ? { state: "uncertain" }
        : scenario === "send-rejected"
          ? { state: "rejected" }
          : { state: "accepted", messageId },
    );
    if (attempt.snapshot().outcome === "pending") {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.max(0, attempt.snapshot().deadline - Date.now()),
        );
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) done();
      });
    }
    outcome = attempt.snapshot().outcome;
  } catch {
    if (outcome === "unavailable" && scenario === "domain-collision")
      outcome = "endpoint_unavailable";
  } finally {
    attempt.cancel();
    signal?.removeEventListener("abort", cancel);
    const releases = await Promise.allSettled([
      endpoint?.close(),
      closeHttpServer(server),
    ]);
    if (releases.some((result) => result.status === "rejected"))
      cleanupBlocked = true;
    running = false;
  }
  return report();
  function report() {
    return {
      evidence: "offline_fixture_only" as const,
      outcome: cleanupBlocked ? "cleanup_blocked" : outcome,
      discovery,
      fixtureSends,
      publicSelfPosts: 0,
      cleanup: cleanupBlocked ? ("blocked" as const) : ("complete" as const),
      liveTranscription: "not_tested" as const,
    };
  }
}

/** Fake schemas are deliberately unrelated to undocumented provider argument fields. */
const fixtureDiscoveryTransport: typeof fetch = async (_url, init) => {
  if (init?.method === "DELETE") return new Response(null, { status: 204 });
  const rpc = JSON.parse(String(init?.body));
  if (rpc.method === "notifications/initialized")
    return new Response(null, { status: 202 });
  const result =
    rpc.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "offline-fixture", version: "1" },
        }
      : {
          tools: [
            "list_webhook_endpoints",
            "send_test_webhook_endpoint",
            "list_webhook_deliveries",
          ].map((name) => ({
            name,
            inputSchema: {
              type: "object",
              properties: { fixtureOnly: { type: "boolean" } },
              additionalProperties: false,
            },
          })),
        };
  return Response.json(
    { jsonrpc: "2.0", id: rpc.id, result },
    { headers: { "Mcp-Session-Id": "fixture-session" } },
  );
};
