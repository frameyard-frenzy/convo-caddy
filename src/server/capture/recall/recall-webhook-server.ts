import { createServer, type IncomingMessage, type Server } from "node:http";
import type { SessionService } from "../../session-service.js";
import {
  isRecallLifecycleEvent,
  normalizeRecallLifecycleEvent,
} from "./normalize-lifecycle.js";
import { normalizeRecallTranscriptEvent } from "./normalize-transcript.js";
import { verifyRecallRequest } from "./verify-request.js";

export const RECALL_WEBHOOK_PATH = "/api/capture/recall/webhook";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export type RecallWebhookIngestionPort = Pick<
  SessionService,
  "ingestRecallLifecycle" | "ingestRecallTranscript"
>;

export type RecallWebhookServerOptions = {
  service: RecallWebhookIngestionPort;
  verificationSecret: string;
  maxBodyBytes?: number;
  now?: () => Date;
};

export function createRecallWebhookServer(
  options: RecallWebhookServerOptions,
): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("Recall webhook body limit must be a positive integer.");
  }
  const now = options.now ?? (() => new Date());

  return createServer((request, response) => {
    handleRequest(request, options, maxBodyBytes, now)
      .then((status) => {
        response.statusCode = status;
        response.end();
      })
      .catch((error: unknown) => {
        response.statusCode = error instanceof BodyTooLargeError ? 413 : 500;
        response.end();
      });
  });
}

async function handleRequest(
  request: IncomingMessage,
  options: RecallWebhookServerOptions,
  maxBodyBytes: number,
  now: () => Date,
): Promise<number> {
  if (request.method !== "POST" || request.url === undefined) {
    return 404;
  }
  let url: URL;
  try {
    url = new URL(request.url, "http://127.0.0.1");
  } catch {
    return 404;
  }
  if (url.pathname !== RECALL_WEBHOOK_PATH) {
    return 404;
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(request, maxBodyBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return 413;
    }
    return 400;
  }

  try {
    verifyRecallRequest({
      secret: options.verificationSecret,
      headers: request.headers,
      rawBody,
      now,
    });
  } catch {
    return 400;
  }

  const webhookId = singleHeader(request.headers["webhook-id"]);
  if (!webhookId) {
    return 400;
  }

  let event: unknown;
  try {
    const payload = JSON.parse(rawBody) as unknown;
    event =
      typeof payload === "object" && payload !== null && "event" in payload
        ? payload.event
        : undefined;
  } catch {
    return 400;
  }
  if (event !== "transcript.data" && !isRecallLifecycleEvent(event)) {
    return 204;
  }

  if (isRecallLifecycleEvent(event)) {
    let normalized: ReturnType<typeof normalizeRecallLifecycleEvent>;
    try {
      normalized = normalizeRecallLifecycleEvent(rawBody);
    } catch {
      return 400;
    }
    const result = options.service.ingestRecallLifecycle(normalized);
    return result === "conflict" ? 409 : 204;
  }

  let normalized: ReturnType<typeof normalizeRecallTranscriptEvent>;
  try {
    normalized = normalizeRecallTranscriptEvent({
      rawBody,
      webhookId,
      receivedAt: verifiedWebhookTimestamp(request),
    });
  } catch {
    return 400;
  }

  const result = options.service.ingestRecallTranscript(normalized);
  return result === "conflict" ? 409 : 204;
}

async function readRawBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBodyBytes) {
      exceeded = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) {
    throw new BodyTooLargeError();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function verifiedWebhookTimestamp(request: IncomingMessage): string {
  const timestamp = singleHeader(request.headers["webhook-timestamp"]);
  const seconds = timestamp === null ? Number.NaN : Number(timestamp);
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new Error("Invalid Recall webhook timestamp.");
  }
  return new Date(seconds * 1_000).toISOString();
}

function singleHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length === 1) {
    return value[0] ?? null;
  }
  return null;
}

class BodyTooLargeError extends Error {}
