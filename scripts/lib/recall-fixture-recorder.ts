import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import {
  ensurePrivateDirectory,
  syncDirectory,
} from "../../src/server/persistence/atomic-write.js";
import { verifyRecallRequest } from "../../src/server/capture/recall/verify-request.js";

export type RecallFixtureRecorderOptions = {
  secret: string;
  fixtureDirectory: string;
  maxBodyBytes?: number;
  now?: () => Date;
  onOutcome?: (outcome: RecallFixtureRecorderOutcome) => void;
};

export type RecallFixtureRecorderOutcome =
  | "stored"
  | "duplicate"
  | "conflict"
  | "invalid"
  | "too_large"
  | "internal_error"
  | "unexpected_request";

const WEBHOOK_PATH = "/api/capture/recall/webhook";
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const SAFE_WEBHOOK_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function createRecallFixtureRecorderServer(
  options: RecallFixtureRecorderOptions,
): Server {
  const fixtureDirectory = path.resolve(options.fixtureDirectory);
  ensurePrivateDirectory(fixtureDirectory);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== WEBHOOK_PATH) {
      finish(response, 404, "unexpected_request", options.onOutcome);
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readRawBody(request, maxBodyBytes);
    } catch (error) {
      finish(
        response,
        error instanceof PayloadTooLargeError ? 413 : 500,
        error instanceof PayloadTooLargeError ? "too_large" : "internal_error",
        options.onOutcome,
      );
      return;
    }

    try {
      verifyRecallRequest({
        secret: options.secret,
        headers: request.headers,
        rawBody,
        now: options.now,
      });

      const webhookId = headerValue(request.headers["webhook-id"]);
      if (!webhookId || !SAFE_WEBHOOK_ID.test(webhookId)) {
        finish(response, 400, "invalid", options.onOutcome);
        return;
      }

      try {
        const result = storeVerifiedFixture(
          fixtureDirectory,
          webhookId,
          rawBody,
        );
        finish(
          response,
          result === "conflict" ? 409 : 204,
          result === "created" ? "stored" : result,
          options.onOutcome,
        );
      } catch {
        finish(response, 500, "internal_error", options.onOutcome);
      }
    } catch {
      finish(response, 400, "invalid", options.onOutcome);
    }
  });
}

function finish(
  response: ServerResponse,
  status: number,
  outcome: RecallFixtureRecorderOutcome,
  onOutcome: RecallFixtureRecorderOptions["onOutcome"],
): void {
  response.writeHead(status).end();
  try {
    onOutcome?.(outcome);
  } catch {
    // Operator diagnostics must never affect webhook acknowledgement.
  }
}

function storeVerifiedFixture(
  fixtureDirectory: string,
  webhookId: string,
  rawBody: string,
): "created" | "duplicate" | "conflict" {
  const destination = path.join(fixtureDirectory, `${webhookId}.json`);
  let descriptor: number | undefined;

  try {
    descriptor = openSync(destination, "wx", 0o600);
    writeFileSync(descriptor, rawBody, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(fixtureDirectory);
    return "created";
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    if (lstatSync(destination).isSymbolicLink()) {
      throw new Error("Recall fixture destination must not be a symlink.");
    }
    return readFileSync(destination, "utf8") === rawBody
      ? "duplicate"
      : "conflict";
  }
}

async function readRawBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let byteCount = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += bytes.length;
    if (byteCount > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
    chunks.push(bytes);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function headerValue(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

class PayloadTooLargeError extends Error {}
