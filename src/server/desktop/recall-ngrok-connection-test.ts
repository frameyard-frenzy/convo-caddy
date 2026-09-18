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
      const timeout =
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name);
      return {
        state: "failed",
        diagnostic: { code: timeout ? "timeout" : "connect_failed" },
      };
    }
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
