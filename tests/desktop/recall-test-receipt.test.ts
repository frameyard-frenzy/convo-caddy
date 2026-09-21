import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ReceiptAttempt } from "../../src/server/desktop/recall-test-receipt.js";
const secret = `whsec_${Buffer.from("synthetic-key").toString("base64")}`;
const start = 1800000000000;
function signed(
  id = "fixture-message",
  event = "recording.done",
  time = start,
  family = "webhook",
) {
  const body = JSON.stringify({ event, data: { synthetic: true } });
  const timestamp = String(Math.floor(time / 1000));
  const signature = createHmac("sha256", Buffer.from("synthetic-key"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    body,
    headers: {
      [`${family}-id`]: id,
      [`${family}-timestamp`]: timestamp,
      [`${family}-signature`]: `v1,${signature}`,
    },
  };
}
function attempt() {
  let time = start;
  const a = new ReceiptAttempt({
    secret,
    generation: "fixture-generation",
    settingsFingerprint: "fixture-settings",
    now: () => time,
    timeoutMs: 1000,
  });
  return {
    a,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
describe("isolated synthetic receipt attribution", () => {
  it.each(["webhook", "svix"])(
    "retains early %s callback but requires independent send linkage",
    (family) => {
      const { a } = attempt();
      const { body, headers } = signed(undefined, undefined, undefined, family);
      expect(a.receive(body, headers)).toBe(204);
      expect(a.snapshot().outcome).toBe("pending");
      a.fixtureSendResult({ state: "accepted", messageId: "fixture-message" });
      expect(a.snapshot().outcome).toBe("synthetic_attributed");
      a.receive(body, headers);
      expect(a.snapshot().receipts).toBe(1);
    },
  );
  it("sender success alone times out, never green", () => {
    const { a, advance } = attempt();
    a.fixtureSendResult({ state: "accepted", messageId: "fixture-message" });
    advance(1000);
    expect(a.snapshot().outcome).toBe("not_received");
    const x = signed();
    a.receive(x.body, x.headers);
    expect(a.snapshot().outcome).toBe("not_received");
  });
  it.each([
    "bad-signature",
    "stale",
    "oversize",
    "malformed",
    "conflict",
    "duplicate-header",
  ])("rejects %s", (kind) => {
    const { a } = attempt();
    const x = signed(
      "fixture-message",
      "recording.done",
      kind === "stale" ? start - 301000 : start,
    );
    if (kind === "bad-signature") x.headers["webhook-signature"] = "v1,bad";
    if (kind === "oversize") x.body = "x".repeat(1048577);
    if (kind === "malformed") x.body = "{";
    if (kind === "conflict") x.headers["svix-id"] = "different";
    if (kind === "duplicate-header") x.headers["webhook-id"] += ", other";
    expect(a.receive(x.body, x.headers)).toBe(kind === "oversize" ? 413 : 400);
    a.fixtureSendResult({ state: "accepted", messageId: "fixture-message" });
    expect(a.snapshot().outcome).toBe("pending");
  });
  it("rejects unrelated events and stale attempt receipts even within signature tolerance", () => {
    const { a } = attempt();
    for (const x of [
      signed("fixture-message", "bot.done"),
      signed("fixture-message", "recording.done", start - 1000),
    ])
      a.receive(x.body, x.headers);
    a.fixtureSendResult({ state: "accepted", messageId: "fixture-message" });
    expect(a.snapshot().outcome).toBe("pending");
  });
  it.each(["cancelled", "settings_changed"] as const)(
    "freezes %s",
    (reason) => {
      const { a } = attempt();
      a.cancel(reason);
      const x = signed();
      a.receive(x.body, x.headers);
      a.fixtureSendResult({ state: "accepted", messageId: "fixture-message" });
      expect(a.snapshot().outcome).toBe(reason);
    },
  );
  it("self signing and lost send response provide no attribution", () => {
    const { a, advance } = attempt();
    const x = signed();
    a.receive(x.body, x.headers);
    a.fixtureSendResult({ state: "uncertain" });
    advance(1000);
    expect(a.snapshot().outcome).toBe("unattributed");
  });
  it("bounds retained receipts and never exposes body or secret", () => {
    const { a } = attempt();
    for (let i = 0; i < 100; i++) {
      const x = signed(`id-${i}`);
      a.receive(x.body, x.headers);
    }
    expect(a.snapshot().receipts).toBeLessThanOrEqual(32);
    expect(JSON.stringify(a.snapshot())).not.toContain(secret);
    expect(JSON.stringify(a.snapshot())).not.toContain("synthetic-key");
  });
});

describe("receipt wire boundary", () => {
  it("accepts equal complete families but rejects duplicate array headers", () => {
    const { a } = attempt();
    const x = signed();
    const y = signed(undefined, undefined, undefined, "svix");
    expect(a.receive(x.body, { ...x.headers, ...y.headers })).toBe(204);
    expect(
      a.receive(x.body, { ...x.headers, "webhook-id": ["fixture-message"] }),
    ).toBe(400);
  });
  it("rejects correctly signed malformed JSON", () => {
    const { a } = attempt();
    const x = signed();
    const body = "{";
    x.headers["webhook-signature"] = `v1,${createHmac(
      "sha256",
      Buffer.from("synthetic-key"),
    )
      .update(`fixture-message.${start / 1000}.${body}`)
      .digest("base64")}`;
    expect(a.receive(body, x.headers)).toBe(400);
  });
  it("a prior generation's signed ID cannot credit a new fixture invocation", () => {
    const old = attempt().a;
    const next = attempt().a;
    const x = signed("prior-message");
    old.receive(x.body, x.headers);
    old.fixtureSendResult({ state: "accepted", messageId: "prior-message" });
    next.receive(x.body, x.headers);
    next.fixtureSendResult({ state: "accepted", messageId: "new-message" });
    expect(next.snapshot().outcome).toBe("pending");
  });
});

it("isolated HTTP receiver enforces exact route, method, duplicate headers and body cap", async () => {
  const { request } = await import("node:http");
  const { createReceiptServer } = await import(
    "../../src/server/desktop/recall-test-receipt.js"
  );
  const { listenOnLoopback, closeHttpServer } = await import(
    "../../src/server/server-lifecycle.js"
  );
  const { a } = attempt();
  const server = createReceiptServer(a);
  const address = await listenOnLoopback(server, 0, "127.0.0.1");
  const x = signed();
  const send = (
    method: string,
    path: string,
    body: string,
    headers: Record<string, string | string[]>,
  ) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        `${address.url}${path}`,
        { method, headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  try {
    const path = "/api/capture/recall/webhook";
    expect(await send("GET", path, "", {})).toBe(404);
    expect(
      await send("POST", `${path}?nonce=unsigned`, x.body, x.headers),
    ).toBe(404);
    expect(
      await send("POST", path, x.body, {
        ...x.headers,
        "webhook-id": ["fixture-message", "fixture-message"],
      }),
    ).toBe(400);
    expect(await send("POST", path, "x".repeat(1048577), x.headers)).toBe(413);
    expect(await send("POST", path, x.body, x.headers)).toBe(204);
    expect(a.snapshot().outcome).toBe("pending");
  } finally {
    await closeHttpServer(server);
  }
});

it.each(["ordinary", "unsigned-bom", "malformed-utf8"] as const)(
  "HTTP verification preserves signed body bytes: %s",
  async (variant) => {
    const { request } = await import("node:http");
    const { createReceiptServer } = await import(
      "../../src/server/desktop/recall-test-receipt.js"
    );
    const { listenOnLoopback, closeHttpServer } = await import(
      "../../src/server/server-lifecycle.js"
    );
    const { a } = attempt();
    const server = createReceiptServer(a);
    const address = await listenOnLoopback(server, 0, "127.0.0.1");
    const signedBody = signed();
    const original = Buffer.from(signedBody.body, "utf8");
    // Sign ordinary JSON, then change the HTTP bytes without resigning.
    const body =
      variant === "unsigned-bom"
        ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original])
        : variant === "malformed-utf8"
          ? Buffer.concat([original, Buffer.from([0xff])])
          : original;
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          `${address.url}/api/capture/recall/webhook`,
          { method: "POST", headers: signedBody.headers },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
      const accepted = variant === "ordinary";
      expect.soft(status).toBe(accepted ? 204 : 400);
      expect.soft(a.snapshot().receipts).toBe(accepted ? 1 : 0);
      a.fixtureSendResult({ state: "accepted", messageId: "fixture-message" });
      expect(a.snapshot().outcome).toBe(
        accepted ? "synthetic_attributed" : "pending",
      );
    } finally {
      await closeHttpServer(server);
    }
  },
);
