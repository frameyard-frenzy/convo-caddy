import { describe, expect, it, vi } from "vitest";
import {
  HermesMartyProvider,
  normalizeHermesBaseUrl,
} from "../../src/server/marty/hermes-marty-provider.js";
import { HermesDispatchAuthority } from "../../src/server/marty/hermes-dispatch-authority.js";
import type { MartyContext } from "../../src/server/marty/marty-provider.js";

describe("Hermes Marty provider", () => {
  it("makes one authenticated request-owned request with stable action metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
      completionResponseForRequest(
        init,
        JSON.stringify({
          text: "Return to the serial mismatch.",
          citationTurnIds: ["turn-1"],
        }),
      ),
    );
    const provider = createProvider(fetcher);

    await expect(
      provider.requestRevisit(context, { idempotencyKey: "mutation-1" }),
    ).resolves.toEqual({
      text: "Return to the serial mismatch.",
      citationTurnIds: ["turn-1"],
    });

    expect(provider.invocationCount).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe("http://127.0.0.1:8642/v1/chat/completions");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer local-hermes-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("mutation-1");
    expect(headers.has("x-hermes-tools")).toBe(false);
    expect(headers.has("x-hermes-session-id")).toBe(false);
    expect(headers.has("x-hermes-session-key")).toBe(false);
    expect(headers.has("x-hermes-conversation-id")).toBe(false);
    expect(headers.has("x-hermes-memory")).toBe(false);

    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "interview-assistant",
      stream: false,
      messages: [
        { role: "system", content: expect.stringContaining("untrusted") },
        { role: "user", content: expect.any(String) },
      ],
    });
    expect(JSON.parse(body.messages[1].content)).toMatchObject({
      task: { kind: "revisit" },
      context: { elapsedMs: 12_000 },
      requestMetadata: { actionId: "mutation-1" },
    });
  });

  it("sends an ordinary question through the answer task", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
      completionResponseForRequest(
        init,
        JSON.stringify({
          text: "The mismatch changed the suspect population.",
          citationTurnIds: ["turn-1"],
        }),
      ),
    );
    const provider = createProvider(fetcher);

    await provider.ask("What changed?", context, {
      idempotencyKey: "mutation-answer",
    });

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(JSON.parse(body.messages[1].content).task).toEqual({
      kind: "answer",
      question: "What changed?",
    });
  });

  it("distinguishes identical independent actions while keeping each action ID stable", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
      completionResponseForRequest(
        init,
        JSON.stringify({ text: "Same answer.", citationTurnIds: [] }),
      ),
    );
    const provider = createProvider(fetcher);

    await provider.ask("What changed?", context, {
      idempotencyKey: "independent-action-1",
    });
    await provider.ask("What changed?", context, {
      idempotencyKey: "independent-action-2",
    });

    const actionIds = fetcher.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body));
      return JSON.parse(body.messages[1].content).requestMetadata.actionId;
    });
    expect(actionIds).toEqual(["independent-action-1", "independent-action-2"]);
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("idempotency-key"),
    ).toBe(actionIds[0]);
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("idempotency-key"),
    ).toBe(actionIds[1]);
  });

  it("sends contextual list hints through distinct structured tasks", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
      completionResponseForRequest(
        init,
        JSON.stringify({ text: "Generated list item.", citationTurnIds: [] }),
      ),
    );
    const provider = createProvider(fetcher);

    await provider.requestRevisit(
      context,
      { idempotencyKey: "hinted-revisit" },
      "spreadsheets",
    );
    await provider.requestQuestion("why is that", context, {
      idempotencyKey: "contextual-question",
    });

    const tasks = fetcher.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body));
      return JSON.parse(body.messages[1].content).task;
    });
    expect(tasks).toEqual([
      { kind: "revisit", hint: "spreadsheets" },
      { kind: "question", hint: "why is that" },
    ]);
  });

  it.each([
    ["non-JSON output", "Assistant returned malformed structured output."],
    [
      JSON.stringify({ text: "Fabricated.", citationTurnIds: ["missing"] }),
      "Assistant returned an invalid transcript citation.",
    ],
  ])(
    "rejects invalid Hermes output without a second request",
    async (content, error) => {
      const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
        completionResponseForRequest(init, content),
      );
      const provider = createProvider(fetcher);

      await expect(
        provider.requestRevisit(context, { idempotencyKey: "invalid-output" }),
      ).rejects.toThrow(error);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(provider.invocationCount).toBe(1);
    },
  );

  it("rejects incomplete Hermes output", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
      completionResponseForRequest(init, "partial", "length"),
    );
    const provider = createProvider(fetcher);

    await expect(
      provider.requestRevisit(context, { idempotencyKey: "partial" }),
    ).rejects.toThrow("Hermes did not complete the assistant response.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not expose a Hermes error body or retry HTTP failures", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('{"error":{"message":"provider secret detail"}}', {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = createProvider(fetcher);

    await expect(
      provider.ask("What changed?", context, { idempotencyKey: "http-fail" }),
    ).rejects.toThrow("Hermes returned HTTP 502.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps an aborted request to a clear timeout without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new DOMException("Synthetic timeout", "AbortError");
    });
    const provider = createProvider(fetcher);

    await expect(
      provider.ask("What changed?", context, { idempotencyKey: "timeout" }),
    ).rejects.toThrow("Hermes did not respond within 30000 ms.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails oversized context before making an HTTP request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createProvider(fetcher, { maxInputBytes: 20 });

    await expect(
      provider.requestRevisit(context, { idempotencyKey: "too-large" }),
    ).rejects.toThrow(/configured limit is 20 bytes/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(provider.invocationCount).toBe(0);
  });

  it("rejects unavailable dispatch before HTTP or invocation accounting", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createProvider(fetcher, {
      dispatchAuthority: new HermesDispatchAuthority(),
    });

    await expect(
      provider.ask("What changed?", context, {
        idempotencyKey: "unavailable",
      }),
    ).rejects.toThrow(
      "Assistant is unavailable while the Hermes connection is not ready.",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(provider.invocationCount).toBe(0);
  });

  it.each(["http://192.168.1.10:8642", "https://remote-hermes.example"])(
    "rejects every non-loopback Hermes URL: %s",
    (baseUrl) => {
      expect(
        () =>
          new HermesMartyProvider({
            baseUrl,
            apiKey: "local-hermes-token",
            model: "interview-assistant",
            maxInputBytes: 60_000,
            timeoutMs: 30_000,
          }),
      ).toThrow("Hermes URL must use loopback HTTP");
    },
  );

  it.each([
    "http://localhost.:8642",
    "http://127.0.0.2:8642",
    "http://[::ffff:127.0.0.1]:8642",
  ])(
    "accepts loopback HTTP aliases without permitting remote plaintext",
    (url) => {
      expect(normalizeHermesBaseUrl(url)).toContain(":8642");
    },
  );

  it("accepts a legitimate opaque Hermes session rotation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      completionResponse(
        JSON.stringify({
          text: "The mismatch changed the suspect population.",
          citationTurnIds: ["turn-1"],
        }),
        "stop",
        { "x-hermes-session-id": "telegram-session" },
      ),
    );
    const provider = createProvider(fetcher);

    await expect(
      provider.ask("What changed?", context, {
        idempotencyKey: "session-boundary",
      }),
    ).resolves.toMatchObject({
      text: "The mismatch changed the suspect population.",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("routes completions through a named profile endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
      completionResponseForRequest(
        init,
        JSON.stringify({ text: "Ready.", citationTurnIds: [] }),
      ),
    );
    const provider = createProvider(fetcher, {
      baseUrl: "http://127.0.0.1:8642/p/everyday",
    });
    await provider.ask("Ready?", context, { idempotencyKey: "named-profile" });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8642/p/everyday/v1/chat/completions",
    );
  });

  it.each(["", "x".repeat(257)])(
    "rejects malformed opaque session metadata",
    async (sessionId) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        completionResponse(
          JSON.stringify({ text: "Ready.", citationTurnIds: [] }),
          "stop",
          { "x-hermes-session-id": sessionId },
        ),
      );
      await expect(
        createProvider(fetcher).ask("Ready?", context, {
          idempotencyKey: "bad-session",
        }),
      ).rejects.toThrow(/session/);
    },
  );

  it("rejects tool calls instead of executing or presenting them", async () => {
    const response = Response.json(
      {
        choices: [
          {
            message: { content: "{}", tool_calls: [{ id: "synthetic" }] },
            finish_reason: "stop",
          },
        ],
      },
      { headers: { "x-hermes-session-id": "opaque" } },
    );
    const fetcher = vi.fn<typeof fetch>(async () => response);
    await expect(
      createProvider(fetcher).ask("Ready?", context, {
        idempotencyKey: "tool-response",
      }),
    ).rejects.toThrow("malformed API response");
  });

  it("rejects a successful response without the Hermes session boundary", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      completionResponse(
        JSON.stringify({
          text: "The mismatch changed the suspect population.",
          citationTurnIds: ["turn-1"],
        }),
      ),
    );
    const provider = createProvider(fetcher);

    await expect(
      provider.ask("What changed?", context, {
        idempotencyKey: "missing-session-boundary",
      }),
    ).rejects.toThrow("Hermes did not return its session boundary.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects mutation IDs that cannot be safely forwarded as headers", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createProvider(fetcher);

    await expect(
      provider.ask("What changed?", context, {
        idempotencyKey: "bad\r\nheader",
      }),
    ).rejects.toThrow(
      "Hermes idempotency key must contain 1–256 visible ASCII characters.",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(provider.invocationCount).toBe(0);
  });
});

function createProvider(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof HermesMartyProvider>[0]> = {},
): HermesMartyProvider {
  return new HermesMartyProvider({
    baseUrl: "http://127.0.0.1:8642",
    apiKey: "local-hermes-token",
    model: "interview-assistant",
    maxInputBytes: 60_000,
    timeoutMs: 30_000,
    fetchImpl,
    ...overrides,
  });
}

function completionResponseForRequest(
  init: RequestInit | undefined,
  content: string,
  finishReason = "stop",
): Response {
  const body = JSON.parse(String(init?.body)) as {
    messages: Array<{ role: string; content: string }>;
  };
  const systemPrompt = body.messages.find(
    (message) => message.role === "system",
  )?.content;
  const userPrompt = body.messages.find(
    (message) => message.role === "user",
  )?.content;
  if (!systemPrompt || !userPrompt) {
    throw new Error("Test request did not contain the expected prompts.");
  }
  return completionResponse(content, finishReason, {
    "x-hermes-session-id": "opaque-synthetic-session",
  });
}

function completionResponse(
  content: string,
  finishReason = "stop",
  headers?: HeadersInit,
): Response {
  return Response.json(
    {
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "interview-assistant",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: finishReason,
        },
      ],
    },
    { headers },
  );
}

const context: MartyContext = {
  elapsedMs: 12_000,
  topics: [],
  revisit: [],
  questions: [],
  notes: [],
  transcript: [
    {
      id: "turn-1",
      speakerLabel: "Participant",
      text: "The serial mismatch changed the suspect population.",
      startedAtMs: 8_000,
      endedAtMs: 10_000,
    },
  ],
};
