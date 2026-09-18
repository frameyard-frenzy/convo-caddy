import { describe, expect, it, vi } from "vitest";
import {
  discoverHermesProfiles,
  probeHermesIdentity,
} from "../../src/server/connectivity/hermes-identity.js";

const baseUrl = "http://127.0.0.1:8642";

describe("Hermes identity probe", () => {
  it("discovers only sorted, deduplicated exact Hermes profile identifiers", async () => {
    const fetchImpl = exactHermesFetch([
      model("zeta"),
      model("alpha"),
      model("zeta"),
    ]);

    await expect(
      discoverHermesProfiles({
        apiKey: "private-key",
        baseUrl,
        timeoutMs: 500,
        fetchImpl,
        probePort: async () => true,
      }),
    ).resolves.toEqual({ kind: "advertised", profiles: ["alpha", "zeta"] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.redirect).toBe("error");
    }
  });

  it("accepts model aliases while distinguishing a missing selected model", async () => {
    await expect(
      discoverHermesProfiles({
        apiKey: "private-key",
        baseUrl,
        timeoutMs: 500,
        fetchImpl: exactHermesFetch([
          { ...model("interview-assistant"), root: "different-profile" },
        ]),
        probePort: async () => true,
      }),
    ).resolves.toEqual({
      kind: "advertised",
      profiles: ["interview-assistant"],
    });

    await expect(
      probeHermesIdentity({
        apiKey: "private-key",
        baseUrl,
        model: "selected-profile",
        timeoutMs: 500,
        fetchImpl: exactHermesFetch([model("another-profile")]),
        probePort: async () => true,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      reason: "profile_not_advertised",
    });
  });

  it.each([401, 403])(
    "reports health HTTP %s as authentication rejection",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response(null, { status }),
      );
      await expect(
        discoverHermesProfiles({
          apiKey: "synthetic",
          baseUrl,
          timeoutMs: 500,
          fetchImpl,
          probePort: async () => true,
        }),
      ).resolves.toEqual({
        kind: "rejected",
        reason: "authentication_rejected",
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("accepts bounded additive discovery metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/health")
        ? Response.json({
            status: "ok",
            platform: "hermes-agent",
            build: { channel: "stable" },
          })
        : Response.json({
            object: "list",
            metadata: { version: 1 },
            data: [{ ...model("default"), label: "Default" }],
          }),
    );
    await expect(
      discoverHermesProfiles({
        apiKey: "synthetic",
        baseUrl,
        timeoutMs: 500,
        fetchImpl,
        probePort: async () => true,
      }),
    ).resolves.toEqual({ kind: "advertised", profiles: ["default"] });
  });

  it.each(["health", "models"])(
    "rejects oversized %s metadata",
    async (stage) => {
      const fetchImpl = vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith("/health")
          ? Response.json({
              status: "ok",
              platform: "hermes-agent",
              ...(stage === "health" ? { extra: "x".repeat(65537) } : {}),
            })
          : Response.json({
              object: "list",
              data: [model("default")],
              extra: "x".repeat(65537),
            }),
      );
      await expect(
        discoverHermesProfiles({
          apiKey: "synthetic",
          baseUrl,
          timeoutMs: 500,
          fetchImpl,
          probePort: async () => true,
        }),
      ).resolves.toEqual({
        kind: "rejected",
        reason: stage === "health" ? "health_mismatch" : "models_malformed",
      });
    },
  );

  it("reports non-successful health responses as unavailable transport failures", async () => {
    for (const status of [404, 429, 500, 503]) {
      await expect(
        discoverHermesProfiles({
          apiKey: "private-key",
          baseUrl,
          timeoutMs: 500,
          fetchImpl: vi.fn<typeof fetch>(
            async () => new Response(null, { status }),
          ),
          probePort: async () => true,
        }),
      ).resolves.toEqual({ kind: "rejected", reason: "transport_mismatch" });
    }
  });

  it("reports only actual authorization statuses as authentication rejection", async () => {
    for (const status of [401, 403]) {
      await expect(
        discoverHermesProfiles({
          apiKey: "private-key",
          baseUrl,
          timeoutMs: 500,
          fetchImpl: hermesModelsStatusFetch(status),
          probePort: async () => true,
        }),
      ).resolves.toEqual({
        kind: "rejected",
        reason: "authentication_rejected",
      });
    }

    for (const status of [404, 429, 500, 503]) {
      await expect(
        discoverHermesProfiles({
          apiKey: "private-key",
          baseUrl,
          timeoutMs: 500,
          fetchImpl: hermesModelsStatusFetch(status),
          probePort: async () => true,
        }),
      ).resolves.toEqual({ kind: "rejected", reason: "transport_mismatch" });
    }
  });

  it("reuses only the exact health response plus an authenticated marty identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(
          JSON.stringify({ status: "ok", platform: "hermes-agent" }),
          { status: 200 },
        );
      }
      expect(init?.headers).toEqual({ Authorization: "Bearer private-key" });
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "interview-assistant",
              object: "model",
              created: 1,
              owned_by: "hermes",
              permission: [],
              root: "interview-assistant",
              parent: null,
            },
          ],
        }),
        { status: 200 },
      );
    });

    await expect(
      probeHermesIdentity({
        apiKey: "private-key",
        baseUrl,
        model: "interview-assistant",
        timeoutMs: 500,
        fetchImpl,
        probePort: async () => true,
      }),
    ).resolves.toEqual({ kind: "verified" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "health-shaped impostor",
      async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            platform: "not-hermes",
            lookalike: true,
          }),
          { status: 200 },
        ),
      "health_mismatch",
    ],
    [
      "wrong bearer token",
      async (input: RequestInfo | URL) =>
        String(input).endsWith("/health")
          ? new Response(
              JSON.stringify({ status: "ok", platform: "hermes-agent" }),
              { status: 200 },
            )
          : new Response("unauthorized", { status: 401 }),
      "authentication_rejected",
    ],
    [
      "wrong advertised profile",
      async (input: RequestInfo | URL) =>
        String(input).endsWith("/health")
          ? new Response(
              JSON.stringify({ status: "ok", platform: "hermes-agent" }),
              { status: 200 },
            )
          : new Response(
              JSON.stringify({
                object: "list",
                data: [
                  {
                    id: "not-marty",
                    object: "model",
                    created: 1,
                    owned_by: "hermes",
                    permission: [],
                    root: "not-marty",
                    parent: null,
                  },
                ],
              }),
              { status: 200 },
            ),
      "profile_not_advertised",
    ],
  ])("rejects a %s", async (_label, response, reason) => {
    await expect(
      probeHermesIdentity({
        apiKey: "private-key",
        baseUrl,
        model: "interview-assistant",
        timeoutMs: 500,
        fetchImpl: vi.fn<typeof fetch>(response),
        probePort: async () => true,
      }),
    ).resolves.toEqual({ kind: "rejected", reason });
  });

  it("distinguishes a free port from an occupied non-HTTP process", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      probeHermesIdentity({
        apiKey: "private-key",
        baseUrl,
        model: "interview-assistant",
        timeoutMs: 10,
        fetchImpl,
        probePort: async () => false,
      }),
    ).resolves.toEqual({ kind: "absent" });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      probeHermesIdentity({
        apiKey: "private-key",
        baseUrl,
        model: "interview-assistant",
        timeoutMs: 10,
        fetchImpl: vi.fn<typeof fetch>(async () => {
          throw new Error("not HTTP");
        }),
        probePort: async () => true,
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "transport_mismatch" });
  });

  it("uses the named profile scope and bearer authentication for health and models", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer private-key",
      );
      return String(input).endsWith("/health")
        ? Response.json({
            status: "ok",
            platform: "hermes-agent",
            version: "2026.8.31",
          })
        : Response.json({
            object: "list",
            data: [
              model("default"),
              { ...model("quick"), root: "default", parent: "default" },
            ],
          });
    });
    await expect(
      discoverHermesProfiles({
        apiKey: "private-key",
        baseUrl: `${baseUrl}/p/everyday`,
        timeoutMs: 500,
        fetchImpl,
        probePort: async () => true,
      }),
    ).resolves.toEqual({ kind: "advertised", profiles: ["default", "quick"] });
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      `${baseUrl}/p/everyday/health`,
      `${baseUrl}/p/everyday/v1/models`,
    ]);
  });
});

function hermesModelsStatusFetch(status: number) {
  return vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith("/health")
      ? Response.json({ status: "ok", platform: "hermes-agent" })
      : new Response(null, { status }),
  );
}

function exactHermesFetch(models: unknown[]) {
  return vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith("/health")) {
      return Response.json({ status: "ok", platform: "hermes-agent" });
    }
    expect(init?.headers).toEqual({ Authorization: "Bearer private-key" });
    return Response.json({ object: "list", data: models });
  });
}

function model(id: string) {
  return {
    id,
    object: "model",
    created: 1,
    owned_by: "hermes",
    permission: [],
    root: id,
    parent: null,
  };
}
