import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createRecallWebhookServer,
  RECALL_WEBHOOK_PATH,
  type RecallWebhookIngestionPort,
} from "../capture/recall/recall-webhook-server.js";
import { RECALL_API_ENDPOINTS } from "../capture/recall/recall-capture-provider.js";
import {
  type NgrokAdapter,
  type NgrokEndpoint,
  NgrokEndpointError,
  startNgrokEndpoint,
} from "../connectivity/ngrok-endpoint-manager.js";
import { closeHttpServer, listenOnLoopback } from "../server-lifecycle.js";
import { ngrokDomainSchema } from "./connection-settings.js";

const connectionTestInputSchema = z.strictObject({
  generation: z.uuidv4(),
  recallApiKey: z.string().trim().min(1).max(4_096),
  recallWebhookVerificationSecret: z.string().trim().min(1).max(4_096),
  ngrokAuthtoken: z.string().trim().min(1).max(4_096),
  ngrokDomain: ngrokDomainSchema,
});

export type RecallNgrokConnectionTestInput = z.infer<
  typeof connectionTestInputSchema
>;

export type CallbackDiagnostic = {
  code:
    | "http_status"
    | "timeout"
    | "dns_failed"
    | "tls_certificate_failed"
    | "tls_protocol_failed"
    | "connection_refused"
    | "connection_reset"
    | "network_unreachable"
    | "connect_failed"
    | "not_attempted"
    | "ngrok_start_failed"
    | "ngrok_domain_mismatch"
    | "local_listener_failed";
  httpStatus?: number;
};
type WebhookCheck = {
  state: "verified_synthetic" | "failed";
  diagnostic?: CallbackDiagnostic;
};

export type RecallNgrokConnectionTestResult = {
  generation: string;
  recallCredentials: {
    state:
      | "authenticated_read_only"
      | "authentication_rejected"
      | "unavailable";
  };
  localWebhook: WebhookCheck;
  ngrokEndpoint: {
    state: "verified_exact_domain" | "failed";
    diagnostic?: CallbackDiagnostic;
  };
  publicWebhook: WebhookCheck;
  webhookAuthenticity: { state: "verified_in_automation" };
  botCreation: { state: "not_attempted" };
  retention: {
    requestedMedia: "none";
    providerConfirmation: "not_observed";
    accountMetadata: "unknown";
    localManagedDays: 7;
  };
};

export class RecallNgrokConnectionTestError extends Error {
  readonly code: "test_in_progress" | "invalid_request" | "cleanup_failed";

  constructor(code: RecallNgrokConnectionTestError["code"]) {
    super(
      code === "test_in_progress"
        ? "A connection test is already in progress."
        : code === "invalid_request"
          ? "Connection test settings are invalid."
          : "Connection test cleanup could not be confirmed.",
    );
    this.name = "RecallNgrokConnectionTestError";
    this.code = code;
  }
}

export class RecallNgrokConnectionTester {
  readonly #fetch: typeof fetch;
  readonly #ngrokAdapter?: NgrokAdapter;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  #running = false;
  #cleanupBlocked = false;

  constructor(
    options: {
      fetchImpl?: typeof fetch;
      ngrokAdapter?: NgrokAdapter;
      now?: () => Date;
      timeoutMs?: number;
    } = {},
  ) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#ngrokAdapter = options.ngrokAdapter;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Connection test timeout must be a positive integer.");
    }
  }

  async test(
    unparsedInput: RecallNgrokConnectionTestInput,
  ): Promise<RecallNgrokConnectionTestResult> {
    if (this.#running) {
      throw new RecallNgrokConnectionTestError("test_in_progress");
    }
    const parsed = connectionTestInputSchema.safeParse(unparsedInput);
    if (!parsed.success) {
      throw new RecallNgrokConnectionTestError("invalid_request");
    }
    this.#running = true;
    try {
      const [recallCredentials, webhook] = await Promise.all([
        this.#testRecallCredentials(parsed.data.recallApiKey),
        this.#testWebhookPath(parsed.data),
      ]);
      return {
        generation: parsed.data.generation,
        recallCredentials,
        ...webhook,
        webhookAuthenticity: { state: "verified_in_automation" },
        botCreation: { state: "not_attempted" },
        retention: {
          requestedMedia: "none",
          providerConfirmation: "not_observed",
          accountMetadata: "unknown",
          localManagedDays: 7,
        },
      };
    } finally {
      if (!this.#cleanupBlocked) {
        this.#running = false;
      }
    }
  }

  async #testRecallCredentials(
    apiKey: string,
  ): Promise<RecallNgrokConnectionTestResult["recallCredentials"]> {
    try {
      const response = await this.#fetch(
        `${RECALL_API_ENDPOINTS["us-west-2"]}?page=1`,
        {
          method: "GET",
          headers: { Authorization: apiKey, accept: "application/json" },
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 200) {
        return { state: "authenticated_read_only" };
      }
      if (response.status === 401 || response.status === 403) {
        return { state: "authentication_rejected" };
      }
      return { state: "unavailable" };
    } catch {
      return { state: "unavailable" };
    }
  }

  async #testWebhookPath(input: RecallNgrokConnectionTestInput): Promise<{
    localWebhook: RecallNgrokConnectionTestResult["localWebhook"];
    ngrokEndpoint: RecallNgrokConnectionTestResult["ngrokEndpoint"];
    publicWebhook: RecallNgrokConnectionTestResult["publicWebhook"];
  }> {
    const service: RecallWebhookIngestionPort = {
      ingestRecallLifecycle: () => "accepted",
      ingestRecallTranscript: () => "accepted",
    };
    const server = createRecallWebhookServer({
      service,
      verificationSecret: input.recallWebhookVerificationSecret,
      now: this.#now,
    });
    let endpoint: NgrokEndpoint | null = null;
    let result: {
      localWebhook: RecallNgrokConnectionTestResult["localWebhook"];
      ngrokEndpoint: RecallNgrokConnectionTestResult["ngrokEndpoint"];
      publicWebhook: RecallNgrokConnectionTestResult["publicWebhook"];
    };
    let endpointClosed = true;
    try {
      const address = await listenOnLoopback(server, 0, "127.0.0.1");
      const localVerified = await this.#sendSyntheticWebhook(
        `${address.url}${RECALL_WEBHOOK_PATH}`,
        input.recallWebhookVerificationSecret,
      );
      try {
        endpoint = await startNgrokEndpoint({
          ...(this.#ngrokAdapter ? { adapter: this.#ngrokAdapter } : {}),
          authtoken: input.ngrokAuthtoken,
          approvedDomain: input.ngrokDomain,
          startupTimeoutMs: this.#timeoutMs,
          reconnectTimeoutMs: this.#timeoutMs,
          webhook: { host: "127.0.0.1", port: address.port },
        });
      } catch (error) {
        if (
          error instanceof NgrokEndpointError &&
          error.pendingOwnershipRelease !== null &&
          !(await settleBooleanWithin(
            error.pendingOwnershipRelease,
            this.#timeoutMs,
          ))
        ) {
          this.#cleanupBlocked = true;
          throw new RecallNgrokConnectionTestError("cleanup_failed");
        }
        result = {
          localWebhook: localVerified,
          ngrokEndpoint: {
            state: "failed",
            diagnostic: {
              code:
                error instanceof NgrokEndpointError
                  ? error.code
                  : "ngrok_start_failed",
            },
          },
          publicWebhook: {
            state: "failed",
            diagnostic: { code: "not_attempted" },
          },
        };
        return result;
      }
      const publicVerified = await this.#sendSyntheticWebhook(
        `https://${input.ngrokDomain}${RECALL_WEBHOOK_PATH}`,
        input.recallWebhookVerificationSecret,
      );
      result = {
        localWebhook: localVerified,
        ngrokEndpoint: { state: "verified_exact_domain" },
        publicWebhook: publicVerified,
      };
    } catch (error) {
      if (error instanceof RecallNgrokConnectionTestError) {
        throw error;
      }
      result = {
        localWebhook: {
          state: "failed",
          diagnostic: { code: "local_listener_failed" },
        },
        ngrokEndpoint: {
          state: "failed",
          diagnostic: { code: "not_attempted" },
        },
        publicWebhook: {
          state: "failed",
          diagnostic: { code: "not_attempted" },
        },
      };
    } finally {
      endpointClosed = await closeEndpointWithin(endpoint, this.#timeoutMs);
      await closeHttpServer(server).catch(() => undefined);
    }
    if (!endpointClosed) {
      this.#cleanupBlocked = true;
      throw new RecallNgrokConnectionTestError("cleanup_failed");
    }
    return result;
  }

  async #sendSyntheticWebhook(
    url: string,
    verificationSecret: string,
  ): Promise<WebhookCheck> {
    const rawBody = JSON.stringify({ event: "convo_caddy.connection_test" });
    const webhookId = `msg_${randomUUID()}`;
    const timestamp = Math.floor(this.#now().getTime() / 1_000).toString();
    const signature = signSyntheticRequest({
      verificationSecret,
      webhookId,
      timestamp,
      rawBody,
    });
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "webhook-id": webhookId,
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${signature}`,
        },
        body: rawBody,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.status === 204
        ? { state: "verified_synthetic" }
        : {
            state: "failed",
            diagnostic: { code: "http_status", httpStatus: response.status },
          };
    } catch (error) {
      return {
        state: "failed",
        diagnostic: { code: classifyTransportError(error) },
      };
    }
  }
}

const TRANSPORT_CODES: Readonly<Record<string, CallbackDiagnostic["code"]>> = {
  ENOTFOUND: "dns_failed",
  EAI_AGAIN: "dns_failed",
  CERT_HAS_EXPIRED: "tls_certificate_failed",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls_certificate_failed",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls_certificate_failed",
  SELF_SIGNED_CERT_IN_CHAIN: "tls_certificate_failed",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls_certificate_failed",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_certificate_failed",
  ERR_SSL_PACKET_LENGTH_TOO_LONG: "tls_protocol_failed",
  ERR_SSL_WRONG_VERSION_NUMBER: "tls_protocol_failed",
  ERR_TLS_PROTOCOL_VERSION_CONFLICT: "tls_protocol_failed",
  EPROTO: "tls_protocol_failed",
  ECONNREFUSED: "connection_refused",
  ECONNRESET: "connection_reset",
  ENETUNREACH: "network_unreachable",
  EHOSTUNREACH: "network_unreachable",
};

function classifyTransportError(error: unknown): CallbackDiagnostic["code"] {
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();
  for (let visited = 0; queue.length > 0 && visited < 24; visited++) {
    const item = queue.shift();
    if (!item) break;
    const { value, depth } = item;
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value === null
    )
      continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const name = safeProperty(value, "name");
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
    const code = safeProperty(value, "code");
    if (typeof code === "string" && Object.hasOwn(TRANSPORT_CODES, code))
      return TRANSPORT_CODES[code] ?? "connect_failed";
    if (depth >= 5) continue;
    const cause = safeProperty(value, "cause");
    if (cause !== undefined) queue.push({ value: cause, depth: depth + 1 });
    const errors = safeProperty(value, "errors");
    if (Array.isArray(errors))
      for (const nested of errors.slice(0, 8))
        queue.push({ value: nested, depth: depth + 1 });
  }
  return "connect_failed";
}

function safeProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

async function closeEndpointWithin(
  endpoint: NgrokEndpoint | null,
  timeoutMs: number,
): Promise<boolean> {
  if (endpoint === null) {
    return true;
  }
  let close: Promise<boolean>;
  try {
    close = endpoint.close().then(
      () => true,
      () => false,
    );
  } catch {
    return false;
  }
  return settleBooleanWithin(close, timeoutMs);
}

async function settleBooleanWithin(
  operation: Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([operation, timeout]);
  if (timer !== null) {
    clearTimeout(timer);
  }
  return result;
}

function signSyntheticRequest(input: {
  verificationSecret: string;
  webhookId: string;
  timestamp: string;
  rawBody: string;
}): string {
  const encoded = input.verificationSecret.startsWith("whsec_")
    ? input.verificationSecret.slice("whsec_".length)
    : "";
  const key = Buffer.from(encoded, "base64");
  return createHmac("sha256", key)
    .update(`${input.webhookId}.${input.timestamp}.${input.rawBody}`)
    .digest("base64");
}
