import { createHmac, timingSafeEqual } from "node:crypto";

export type RecallVerificationHeaders = Record<
  string,
  string | string[] | undefined
>;

export type VerifyRecallRequestInput = {
  secret: string;
  headers: RecallVerificationHeaders;
  rawBody: string;
  now?: () => Date;
  toleranceSeconds?: number;
};

const VERIFICATION_ERROR = "Recall webhook verification failed.";
const DEFAULT_TOLERANCE_SECONDS = 300;

export function verifyRecallRequest(input: VerifyRecallRequestInput): void {
  const secret = input.secret.trim();
  if (!secret.startsWith("whsec_")) {
    throw new Error(VERIFICATION_ERROR);
  }

  const webhookId = singleHeader(input.headers["webhook-id"]);
  const timestamp = singleHeader(input.headers["webhook-timestamp"]);
  const signatureHeader = singleHeader(input.headers["webhook-signature"]);
  if (!webhookId || !timestamp || !signatureHeader) {
    throw new Error(VERIFICATION_ERROR);
  }
  const timestampSeconds = Number(timestamp);
  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (
    !Number.isInteger(timestampSeconds) ||
    !Number.isInteger(toleranceSeconds) ||
    toleranceSeconds <= 0 ||
    Math.abs(
      Math.floor((input.now?.() ?? new Date()).getTime() / 1_000) -
        timestampSeconds,
    ) > toleranceSeconds
  ) {
    throw new Error(VERIFICATION_ERROR);
  }

  let key: Buffer;
  try {
    key = Buffer.from(secret.slice("whsec_".length), "base64");
  } catch {
    throw new Error(VERIFICATION_ERROR);
  }
  if (key.length === 0) {
    throw new Error(VERIFICATION_ERROR);
  }

  const expected = createHmac("sha256", key)
    .update(`${webhookId}.${timestamp}.${input.rawBody}`)
    .digest();

  for (const versionedSignature of signatureHeader.split(" ")) {
    const [version, encodedSignature] = versionedSignature.split(",", 2);
    if (version !== "v1" || !encodedSignature) {
      continue;
    }

    const candidate = Buffer.from(encodedSignature, "base64");
    if (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    ) {
      return;
    }
  }

  throw new Error(VERIFICATION_ERROR);
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
