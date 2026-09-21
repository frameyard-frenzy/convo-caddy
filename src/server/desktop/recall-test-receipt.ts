import { createServer, type Server } from "node:http";
import {
  verifyRecallRequest,
  type RecallVerificationHeaders,
} from "../capture/recall/verify-request.js";

export const EXPERIMENT_WEBHOOK_PATH = "/api/capture/recall/webhook";
const MAX_BODY = 1048576;
type Outcome =
  | "pending"
  | "synthetic_attributed"
  | "not_received"
  | "unattributed"
  | "cancelled"
  | "settings_changed"
  | "send_rejected";
export type FixtureSendResult = {
  state: "accepted" | "uncertain" | "rejected";
  messageId?: string;
};

/** Canonicalize ONLY for the isolated receiver; production verification is unchanged. */
function canonicalHeaders(
  headers: RecallVerificationHeaders,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of ["id", "timestamp", "signature"]) {
    const a = headers[`webhook-${field}`];
    const b = headers[`svix-${field}`];
    if (
      (a !== undefined && typeof a !== "string") ||
      (b !== undefined && typeof b !== "string") ||
      (a !== undefined && b !== undefined && a !== b)
    )
      throw new Error("invalid_headers");
    const value = a ?? b;
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 4096 ||
      (field !== "signature" && !/^[A-Za-z0-9_-]+$/.test(value))
    )
      throw new Error("invalid_headers");
    result[`webhook-${field}`] = value;
  }
  // A partial alternate family is ambiguous even when its one value agrees.
  for (const family of ["webhook", "svix"]) {
    const count = ["id", "timestamp", "signature"].filter(
      (f) => headers[`${family}-${f}`] !== undefined,
    ).length;
    if (count !== 0 && count !== 3) throw new Error("invalid_headers");
  }
  if (!/^\d{1,12}$/.test(result["webhook-timestamp"]))
    throw new Error("invalid_headers");
  if (
    !/^v1,[A-Za-z0-9+/]+=*(?: v1,[A-Za-z0-9+/]+=*)*$/.test(
      result["webhook-signature"],
    )
  )
    throw new Error("invalid_headers");
  return result;
}

export class ReceiptAttempt {
  readonly #options: {
    secret: string;
    generation: string;
    settingsFingerprint: string;
    now: () => number;
    timeoutMs: number;
  };
  readonly #start: number;
  readonly #deadline: number;
  readonly #receipts = new Map<string, number>();
  #outcome: Outcome = "pending";
  #send: FixtureSendResult = { state: "uncertain" };
  #sendSettled = false;
  constructor(options: {
    secret: string;
    generation: string;
    settingsFingerprint: string;
    now: () => number;
    timeoutMs: number;
  }) {
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30000
    )
      throw new Error("invalid_deadline");
    this.#options = options;
    this.#start = options.now();
    this.#deadline = this.#start + options.timeoutMs;
  }
  #update() {
    if (this.#outcome !== "pending") return;
    if (this.#options.now() >= this.#deadline) {
      this.#outcome = this.#receipts.size ? "unattributed" : "not_received";
      return;
    }
    if (
      this.#send.state === "accepted" &&
      this.#send.messageId &&
      this.#receipts.has(this.#send.messageId)
    )
      this.#outcome = "synthetic_attributed";
  }
  receive(rawBody: string, headers: RecallVerificationHeaders): number {
    if (Buffer.byteLength(rawBody) > MAX_BODY) return 413;
    let canonical: Record<string, string>;
    let event: unknown;
    try {
      canonical = canonicalHeaders(headers);
      verifyRecallRequest({
        secret: this.#options.secret,
        headers: canonical,
        rawBody,
        now: () => new Date(this.#options.now()),
      });
      event = JSON.parse(rawBody)?.event;
    } catch {
      return 400;
    }
    this.#update();
    if (
      this.#outcome !== "pending" ||
      event !== "recording.done" ||
      Number(canonical["webhook-timestamp"]) < Math.floor(this.#start / 1000)
    )
      return 204;
    if (this.#receipts.size < 32)
      this.#receipts.set(canonical["webhook-id"], this.#options.now());
    this.#update();
    return 204;
  }
  /** Fixture adapter contract, NOT a claimed Recall send response schema. */
  fixtureSendResult(result: FixtureSendResult) {
    this.#update();
    if (this.#outcome !== "pending" || this.#sendSettled) return;
    this.#sendSettled = true;
    this.#send = {
      state: result.state,
      ...(result.messageId && result.messageId.length <= 256
        ? { messageId: result.messageId }
        : {}),
    };
    if (result.state === "rejected") this.#outcome = "send_rejected";
    this.#update();
  }
  cancel(reason: "cancelled" | "settings_changed" = "cancelled") {
    if (this.#outcome === "pending") this.#outcome = reason;
  }
  snapshot() {
    this.#update();
    return {
      generation: this.#options.generation,
      settingsFingerprint: this.#options.settingsFingerprint,
      start: this.#start,
      deadline: this.#deadline,
      event: "recording.done" as const,
      receipts: this.#receipts.size,
      send: this.#send.state,
      outcome: this.#outcome,
    };
  }
}

/** No ingestion port exists: recording.done can never reach SessionService here. */
export function createReceiptServer(attempt: ReceiptAttempt): Server {
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 16384 },
    async (request, response) => {
      const finish = (status: number) => {
        response.writeHead(status, { connection: "close" });
        response.end();
      };
      if (
        request.method !== "POST" ||
        request.url !== EXPERIMENT_WEBHOOK_PATH
      ) {
        finish(404);
        return;
      }
      const headers: RecallVerificationHeaders = {};
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i].toLowerCase();
        if (!/^(webhook|svix)-(id|timestamp|signature)$/.test(name)) continue;
        if (headers[name] !== undefined) {
          finish(400);
          return;
        }
        headers[name] = request.rawHeaders[i + 1];
      }
      const timer = setTimeout(() => {
        finish(408);
        request.destroy();
      }, 5000);
      try {
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_BODY) {
            finish(413);
            return;
          }
          chunks.push(buffer);
        }
        finish(
          attempt.receive(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
            headers,
          ),
        );
      } catch {
        if (!response.headersSent) finish(400);
      } finally {
        clearTimeout(timer);
      }
    },
  );
  server.maxConnections = 8;
  return server;
}
