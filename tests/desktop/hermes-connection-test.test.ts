import { describe, expect, it, vi } from "vitest";
import type {
  HermesConnectionManager,
  HermesConnectionStatus,
  StartHermesConnectionManagerOptions,
} from "../../src/server/connectivity/hermes-connection-manager.js";
import {
  HermesConnectionTester,
  type HermesSetupConnection,
} from "../../src/server/desktop/hermes-connection-test.js";
import type { MartyProvider } from "../../src/server/marty/marty-provider.js";

describe("Hermes setup connection tester", () => {
  it.each(["operator@100.101.102.103", "operator@hermes.example.ts.net"])(
    "checks fresh owned remote metadata for %s without inference",
    async (sshTarget) => {
      const close = vi.fn(async () => undefined);
      const start = vi.fn((options: StartHermesConnectionManagerOptions) =>
        managerThatProbes(options, close),
      );
      const createProvider = vi.fn();
      const tester = new HermesConnectionTester({
        startConnectionManager: start,
        discoverProfiles: async () => ({
          kind: "advertised",
          profiles: ["synthetic"],
        }),
        createProvider,
      });
      await tester.discover({ ...connection(), mode: "ssh", sshTarget });
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          requireOwnedForward: true,
          reconnectAttempts: 0,
          sshTarget,
        }),
      );
      expect(createProvider).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["hermes_authentication_rejected", "authentication_rejected"],
    ["hermes_health_mismatch", "identity_rejected"],
    ["hermes_models_malformed", "models_rejected"],
    ["hermes_transport_mismatch", "transport_unknown"],
    ["ssh_forward_unavailable", "forwarding_unavailable"],
    ["ssh_exited_before_ready", "ssh_failed"],
    ["hermes_unavailable", "unavailable"],
  ] as const)(
    "returns allowlisted %s with confirmed cleanup",
    async (diagnostic, state) => {
      const close = vi.fn(async () => undefined);
      const tester = new HermesConnectionTester({
        startConnectionManager: () => ({
          ...readyManager(close),
          snapshot: () => ({ state: "failed", diagnostic }),
        }),
      });
      await expect(tester.discover(connection())).resolves.toEqual({
        generation: connection().generation,
        state,
      });
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("holds exclusivity until a late failed discovery owner has closed", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => pending);
    const tester = new HermesConnectionTester({
      startConnectionManager: () => ({
        ...readyManager(close),
        snapshot: () => ({ state: "failed", diagnostic: "ssh_start_failed" }),
      }),
    });
    const first = tester.discover(connection());
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await expect(tester.discover(connection())).rejects.toMatchObject({
      code: "test_in_progress",
    });
    release();
    await expect(first).resolves.toMatchObject({ state: "ssh_failed" });
  });

  it("discovers advertised profiles through one temporary local connection", async () => {
    const close = vi.fn(async () => undefined);
    const startConnectionManager = vi.fn(
      (options: StartHermesConnectionManagerOptions) =>
        managerThatProbes(options, close),
    );
    const discoverProfiles = vi.fn(async () => ({
      kind: "advertised" as const,
      profiles: ["alpha", "research"],
    }));
    const tester = new HermesConnectionTester({
      startConnectionManager,
      discoverProfiles,
    });

    await expect(tester.discover(connection())).resolves.toEqual({
      generation: connection().generation,
      state: "profiles_advertised",
      profiles: ["alpha", "research"],
    });
    expect(discoverProfiles).toHaveBeenCalledOnce();
    expect(startConnectionManager).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "local",
        localPort: 18_642,
        remotePort: 28_642,
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("sends one synthetic assistant request with no participant context and never returns its text", async () => {
    const close = vi.fn(async () => undefined);
    const ask = vi.fn<MartyProvider["ask"]>(async () => ({
      text: "private provider response",
      citationTurnIds: [],
    }));
    const tester = new HermesConnectionTester({
      startConnectionManager: () => readyManager(close),
      createProvider: () => ({ ask }),
    });

    const result = await tester.testAssistant({
      ...connection(),
      profile: "research",
    });

    expect(result).toEqual({
      generation: connection().generation,
      state: "assistant_verified_synthetic",
    });
    expect(JSON.stringify(result)).not.toContain("private provider response");
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]?.[1]).toMatchObject({
      transcript: [],
      topics: [],
      revisit: [],
      questions: [],
      notes: [],
    });
    expect(ask.mock.calls[0]?.[0]).toContain("synthetic");
    expect(close).toHaveBeenCalledOnce();
  });

  it("gives independent assistant tests distinct action IDs under the same credential generation", async () => {
    const ask = vi.fn<MartyProvider["ask"]>(async () => ({
      text: "ok",
      citationTurnIds: [],
    }));
    const tester = new HermesConnectionTester({
      startConnectionManager: () => readyManager(async () => undefined),
      createProvider: () => ({ ask }),
    });
    const input = { ...connection(), profile: "research" };
    await tester.testAssistant(input);
    await tester.testAssistant(input);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0]?.[2].idempotencyKey).not.toBe(
      ask.mock.calls[1]?.[2].idempotencyKey,
    );
  });

  it("fails closed after temporary connection cleanup cannot be confirmed", async () => {
    const tester = new HermesConnectionTester({
      startConnectionManager: () =>
        readyManager(
          vi.fn(async () => {
            throw new Error("private cleanup detail");
          }),
        ),
      createProvider: () => ({
        ask: vi.fn(async () => ({ text: "ok", citationTurnIds: [] })),
      }),
    });

    await expect(
      tester.testAssistant({ ...connection(), profile: "research" }),
    ).rejects.toMatchObject({ code: "cleanup_failed" });
    await expect(tester.discover(connection())).rejects.toEqual(
      expect.objectContaining({ code: "cleanup_failed" }),
    );
  });
});

function connection(): HermesSetupConnection {
  return {
    generation: "00000000-0000-4000-8000-000000000001",
    mode: "local",
    baseUrl: "http://127.0.0.1:18642",
    localPort: 18_642,
    remotePort: 28_642,
    sshTarget: null,
    apiKey: "private-key",
  };
}

function managerThatProbes(
  options: StartHermesConnectionManagerOptions,
  close: () => Promise<void>,
): HermesConnectionManager {
  let status: HermesConnectionStatus = { state: "starting" };
  const settled = (
    options.probeIdentity?.() ?? Promise.resolve({ kind: "absent" as const })
  ).then((identity) => {
    status =
      identity.kind === "verified"
        ? { state: "local" }
        : { state: "unavailable", diagnostic: "hermes_unavailable" };
  });
  return {
    settled,
    snapshot: () => ({ ...status }),
    subscribe: () => () => undefined,
    close,
  };
}

function readyManager(close: () => Promise<void>): HermesConnectionManager {
  return {
    settled: Promise.resolve(),
    snapshot: () => ({ state: "local" }),
    subscribe: () => () => undefined,
    close,
  };
}
