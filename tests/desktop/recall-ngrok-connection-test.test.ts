import { describe, expect, it, vi } from "vitest";
import {
  RecallNgrokConnectionTester,
  RecallNgrokConnectionTestError,
} from "../../src/server/desktop/recall-ngrok-connection-test.js";
import type {
  NgrokAdapter,
  NgrokForwardOptions,
  NgrokListener,
} from "../../src/server/connectivity/ngrok-endpoint-manager.js";

const secretBytes = Buffer.from("unit-2b-synthetic-verification-secret");
const verificationSecret = `whsec_${secretBytes.toString("base64")}`;
const input = {
  generation: "00000000-0000-4000-8000-000000000001",
  recallApiKey: "recall-api-key-must-not-leak",
  recallWebhookVerificationSecret: verificationSecret,
  ngrokAuthtoken: "ngrok-token-must-not-leak",
  ngrokDomain: "portable-test.ngrok.app",
} as const;

describe("Recall and ngrok component test", () => {
  it("uses one read-only Recall GET and proves local/public webhook paths separately", async () => {
    const harness = createHarness();
    const tester = new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });

    const result = await tester.test(input);

    expect(result).toEqual({
      generation: input.generation,
      recallCredentials: { state: "authenticated_read_only" },
      localWebhook: { state: "verified_synthetic" },
      ngrokEndpoint: { state: "verified_exact_domain" },
      publicWebhook: { state: "verified_synthetic" },
      webhookAuthenticity: { state: "verified_in_automation" },
      botCreation: { state: "not_attempted" },
      retention: {
        requestedMedia: "none",
        providerConfirmation: "not_observed",
        accountMetadata: "unknown",
        localManagedDays: 7,
      },
    });
    expect(harness.forward).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.forward.mock.calls[0]?.[0]).toMatchObject({
      authtoken: input.ngrokAuthtoken,
      domain: input.ngrokDomain,
    });
    expect(harness.forward.mock.calls[0]?.[0].addr).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );

    const recallCalls = harness.fetchImpl.mock.calls.filter(([target]) =>
      String(target).startsWith("https://us-west-2.recall.ai/"),
    );
    expect(recallCalls).toHaveLength(1);
    expect(recallCalls[0]?.[0]).toBe(
      "https://us-west-2.recall.ai/api/v1/bot/?page=1",
    );
    expect(recallCalls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Authorization: input.recallApiKey,
        accept: "application/json",
      },
    });
    expect(recallCalls[0]?.[1]).not.toHaveProperty("body");
    expect(
      harness.fetchImpl.mock.calls.some(
        ([target, options]) =>
          String(target).startsWith("https://us-west-2.recall.ai/") &&
          options?.method !== "GET",
      ),
    ).toBe(false);
    expect(harness.publicRequests).toEqual([
      "https://portable-test.ngrok.app/api/capture/recall/webhook",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /must-not-leak|whsec_|unit-2b-synthetic/i,
    );
  });

  it("reports Recall authentication rejection without collapsing successful webhook checks", async () => {
    const harness = createHarness({ recallStatus: 401 });
    const result = await new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    }).test(input);

    expect(result.recallCredentials).toEqual({
      state: "authentication_rejected",
    });
    expect(result.localWebhook).toEqual({ state: "verified_synthetic" });
    expect(result.ngrokEndpoint).toEqual({
      state: "verified_exact_domain",
    });
    expect(result.publicWebhook).toEqual({ state: "verified_synthetic" });
    expect(result.botCreation).toEqual({ state: "not_attempted" });
  });

  it("reports ngrok/public failure while retaining the independent local proof", async () => {
    const harness = createHarness({ ngrokFailure: true });
    const result = await new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    }).test(input);

    expect(result.recallCredentials).toEqual({
      state: "authenticated_read_only",
    });
    expect(result.localWebhook).toEqual({ state: "verified_synthetic" });
    expect(result.ngrokEndpoint).toEqual({
      state: "failed",
      diagnostic: { code: "ngrok_start_failed" },
    });
    expect(result.publicWebhook).toEqual({
      state: "failed",
      diagnostic: { code: "not_attempted" },
    });
    expect(JSON.stringify(result)).not.toContain(input.ngrokAuthtoken);
  });

  it.each([302, 401, 502])(
    "reports public HTTP %s without response contents or following redirects",
    async (status) => {
      const harness = createHarness({ publicStatus: status });
      const result = await new RecallNgrokConnectionTester({
        fetchImpl: harness.fetchImpl,
        ngrokAdapter: harness.ngrokAdapter,
      }).test(input);
      expect(result.publicWebhook).toEqual({
        state: "failed",
        diagnostic: { code: "http_status", httpStatus: status },
      });
      expect(result.localWebhook.state).toBe("verified_synthetic");
      expect(
        harness.fetchImpl.mock.calls.find(([url]) =>
          String(url).startsWith(`https://${input.ngrokDomain}`),
        )?.[1]?.redirect,
      ).toBe("manual");
      expect(JSON.stringify(result)).not.toContain("private-response-body");
    },
  );
  it.each([
    ["TimeoutError", undefined, "timeout"],
    ["TypeError", "ENOTFOUND", "dns_failed"],
    ["TypeError", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_certificate_failed"],
    ["TypeError", "ERR_SSL_WRONG_VERSION_NUMBER", "tls_protocol_failed"],
    ["TypeError", "ECONNREFUSED", "connection_refused"],
    ["TypeError", "ECONNRESET", "connection_reset"],
    ["TypeError", "ENETUNREACH", "network_unreachable"],
    ["TypeError", "UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["TypeError", "UND_ERR_HEADERS_TIMEOUT", "timeout"],
    ["TypeError", "ETIMEDOUT", "timeout"],
    ["TypeError", "PRIVATE_TOKEN_123", "connect_failed"],
  ] as const)(
    "classifies public %s/%s as %s without exposing the native code",
    async (name, causeCode, expected) => {
      const harness = createHarness({ publicError: { name, causeCode } });
      const result = await new RecallNgrokConnectionTester({
        fetchImpl: harness.fetchImpl,
        ngrokAdapter: harness.ngrokAdapter,
      }).test(input);
      expect(result.publicWebhook).toEqual({
        state: "failed",
        diagnostic: {
          code: expected,
        },
      });
      expect(result.ngrokEndpoint.state).toBe("verified_exact_domain");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN_123");
    },
  );

  it("bounds cyclic AggregateError traversal and finds an allowlisted nested cause", async () => {
    const cyclic: { code: string; cause?: unknown } = {
      code: "PRIVATE_SECRET",
    };
    cyclic.cause = cyclic;
    const nested = new AggregateError([
      cyclic,
      { cause: { code: "ECONNRESET" } },
    ]);
    const harness = createHarness({ publicThrown: nested });
    const result = await new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
    }).test(input);
    expect(result.publicWebhook).toEqual({
      state: "failed",
      diagnostic: { code: "connection_reset" },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET");
  });

  it("contains a hostile AggregateError array getter and returns the safe fallback", async () => {
    const errors: unknown[] = [];
    Object.defineProperty(errors, "0", {
      get() {
        throw new Error("private getter value");
      },
    });
    errors.length = 1;
    const thrown = Object.assign(new Error("private aggregate"), { errors });
    const harness = createHarness({ publicThrown: thrown });
    const result = await new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
    }).test(input);
    expect(result.localWebhook).toEqual({ state: "verified_synthetic" });
    expect(result.ngrokEndpoint).toEqual({ state: "verified_exact_domain" });
    expect(result.publicWebhook).toEqual({
      state: "failed",
      diagnostic: { code: "connect_failed" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private getter|private aggregate/,
    );
  });
  it("marks public POST not attempted when endpoint startup fails", async () => {
    const harness = createHarness({ ngrokFailure: true });
    const result = await new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
    }).test(input);
    expect(result.ngrokEndpoint).toEqual({
      state: "failed",
      diagnostic: { code: "ngrok_start_failed" },
    });
    expect(result.publicWebhook).toEqual({
      state: "failed",
      diagnostic: { code: "not_attempted" },
    });
    expect(harness.publicRequests).toEqual([]);
  });

  it("rejects a concurrent test before a second ngrok endpoint can start", async () => {
    let releaseRecall: (response: Response) => void = () => undefined;
    const recallPending = new Promise<Response>((resolve) => {
      releaseRecall = resolve;
    });
    const harness = createHarness({ recallResponse: recallPending });
    const tester = new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });

    const first = tester.test(input);
    await vi.waitFor(() => expect(harness.fetchImpl).toHaveBeenCalledOnce());
    await expect(tester.test(input)).rejects.toEqual(
      new RecallNgrokConnectionTestError("test_in_progress"),
    );
    releaseRecall(new Response(null, { status: 200 }));
    await first;
    expect(harness.forward).toHaveBeenCalledOnce();
  });

  it("fails closed on bounded cleanup and never starts a second endpoint", async () => {
    const harness = createHarness({ closeNeverSettles: true });
    const tester = new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      timeoutMs: 5,
    });

    await expect(tester.test(input)).rejects.toEqual(
      new RecallNgrokConnectionTestError("cleanup_failed"),
    );
    await expect(tester.test(input)).rejects.toEqual(
      new RecallNgrokConnectionTestError("test_in_progress"),
    );
    expect(harness.forward).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("retains ownership when startup times out before a late listener exists", async () => {
    const forward = deferred<NgrokListener>();
    const harness = createHarness({ forwardResponse: forward.promise });
    const tester = new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      timeoutMs: 5,
    });

    await expect(tester.test(input)).rejects.toEqual(
      new RecallNgrokConnectionTestError("cleanup_failed"),
    );
    await expect(tester.test(input)).rejects.toEqual(
      new RecallNgrokConnectionTestError("test_in_progress"),
    );
    expect(harness.forward).toHaveBeenCalledOnce();

    forward.resolve({
      url: () => `https://${input.ngrokDomain}`,
      close: harness.close,
    });
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
  });

  it("fails closed when unexpected endpoint ownership cannot be confirmed", async () => {
    const harness = createHarness({
      closeNeverSettles: true,
      returnedDomain: "unexpected.ngrok.app",
    });
    const tester = new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      timeoutMs: 5,
    });

    await expect(tester.test(input)).rejects.toEqual(
      new RecallNgrokConnectionTestError("cleanup_failed"),
    );
    await expect(tester.test(input)).rejects.toEqual(
      new RecallNgrokConnectionTestError("test_in_progress"),
    );
    expect(harness.forward).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("fails closed when native endpoint URL inspection loses ownership", async () => {
    const harness = createHarness({
      closeNeverSettles: true,
      urlThrows: true,
    });
    const tester = new RecallNgrokConnectionTester({
      fetchImpl: harness.fetchImpl,
      ngrokAdapter: harness.ngrokAdapter,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      timeoutMs: 5,
    });

    await expect(tester.test(input)).rejects.toEqual(
      new RecallNgrokConnectionTestError("cleanup_failed"),
    );
    await expect(tester.test(input)).rejects.toEqual(
      new RecallNgrokConnectionTestError("test_in_progress"),
    );
    expect(harness.forward).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
  });
});

function createHarness(
  options: {
    recallStatus?: number;
    recallResponse?: Promise<Response>;
    ngrokFailure?: boolean;
    publicStatus?: number;
    publicError?: { name: string; causeCode?: string };
    publicThrown?: unknown;
    closeNeverSettles?: boolean;
    returnedDomain?: string;
    urlThrows?: boolean;
    forwardResponse?: Promise<NgrokListener>;
  } = {},
) {
  let localBaseUrl = "";
  const publicRequests: string[] = [];
  const close = vi.fn(() => {
    if (options.closeNeverSettles) {
      return new Promise<void>(() => undefined);
    }
    return Promise.resolve();
  });
  const forward = vi.fn(async (forwardOptions: NgrokForwardOptions) => {
    if (options.ngrokFailure) {
      throw new Error(`provider failure ${input.ngrokAuthtoken}`);
    }
    localBaseUrl = forwardOptions.addr;
    if (options.forwardResponse) {
      return options.forwardResponse;
    }
    return {
      url: () => {
        if (options.urlThrows) {
          throw new Error("synthetic native URL failure");
        }
        return `https://${options.returnedDomain ?? forwardOptions.domain}`;
      },
      close,
    };
  });
  const ngrokAdapter: NgrokAdapter = { forward };
  const fetchImpl = vi.fn<typeof fetch>(async (target, requestOptions) => {
    const url = String(target);
    if (url.startsWith("https://us-west-2.recall.ai/")) {
      return (
        options.recallResponse ??
        new Response(null, { status: options.recallStatus ?? 200 })
      );
    }
    if (url.startsWith(`https://${input.ngrokDomain}/`)) {
      publicRequests.push(url);
      if (options.publicThrown) throw options.publicThrown;
      if (options.publicError)
        throw Object.assign(new Error("private-response-body"), {
          name: options.publicError.name,
          cause: options.publicError.causeCode
            ? { code: options.publicError.causeCode }
            : undefined,
        });
      if (options.publicStatus)
        return new Response("private-response-body", {
          status: options.publicStatus,
        });
      const localTarget = new URL(new URL(url).pathname, localBaseUrl);
      return fetch(localTarget, requestOptions);
    }
    return fetch(target, requestOptions);
  });
  return { close, fetchImpl, forward, ngrokAdapter, publicRequests };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
