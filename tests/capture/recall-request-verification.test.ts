import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyRecallRequest } from "../../src/server/capture/recall/verify-request.js";

const secretBytes = Buffer.from("phase-4-test-secret");
const secret = `whsec_${secretBytes.toString("base64")}`;
const webhookId = "msg_fixture_01";
const webhookTimestamp = "1787100000";
const rawBody = '{"event":"transcript.data","data":{"fixture":true}}';

function signature(payload = rawBody): string {
  return createHmac("sha256", secretBytes)
    .update(`${webhookId}.${webhookTimestamp}.${payload}`)
    .digest("base64");
}

describe("verifyRecallRequest", () => {
  it("accepts the exact signed raw body and one valid v1 signature", () => {
    expect(() =>
      verifyRecallRequest({
        secret,
        rawBody,
        now: () => new Date(Number(webhookTimestamp) * 1_000),
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": webhookTimestamp,
          "webhook-signature": `v1,${signature()}`,
        },
      }),
    ).not.toThrow();
  });

  it("accepts a valid signature during Recall secret rotation", () => {
    expect(() =>
      verifyRecallRequest({
        secret,
        rawBody,
        now: () => new Date(Number(webhookTimestamp) * 1_000),
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": webhookTimestamp,
          "webhook-signature": `v1,invalid v1,${signature()}`,
        },
      }),
    ).not.toThrow();
  });

  it.each([
    ["a missing secret", "", rawBody],
    ["a malformed secret", "not-a-webhook-secret", rawBody],
    ["a changed body", secret, `${rawBody} `],
  ])("rejects %s", (_label, candidateSecret, candidateBody) => {
    expect(() =>
      verifyRecallRequest({
        secret: candidateSecret,
        rawBody: candidateBody,
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": webhookTimestamp,
          "webhook-signature": `v1,${signature()}`,
        },
      }),
    ).toThrow("Recall webhook verification failed");
  });

  it("rejects missing verification headers", () => {
    expect(() => verifyRecallRequest({ secret, rawBody, headers: {} })).toThrow(
      "Recall webhook verification failed",
    );
  });

  it("rejects a correctly signed request outside the bounded replay window", () => {
    expect(() =>
      verifyRecallRequest({
        secret,
        rawBody,
        now: () => new Date((Number(webhookTimestamp) + 301) * 1_000),
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": webhookTimestamp,
          "webhook-signature": `v1,${signature()}`,
        },
      }),
    ).toThrow("Recall webhook verification failed");
  });
});
