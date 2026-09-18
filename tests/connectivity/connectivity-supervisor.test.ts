import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../../src/domain/types.js";
import {
  startConnectivitySupervisor,
  type ConnectivitySession,
} from "../../src/server/connectivity/connectivity-supervisor.js";
import type {
  HermesConnectionManager,
  HermesConnectionStatus,
} from "../../src/server/connectivity/hermes-connection-manager.js";
import {
  type NgrokEndpoint,
  NgrokEndpointError,
  type NgrokEndpointStatus,
  startNgrokEndpoint,
} from "../../src/server/connectivity/ngrok-endpoint-manager.js";
import type { RecallReconciliationResult } from "../../src/server/session-service.js";
import { HermesDispatchAuthority } from "../../src/server/marty/hermes-dispatch-authority.js";
import { createSessionState } from "../helpers/session-state.js";

describe("connectivity supervisor", () => {
  it("retries only the failed Hermes owner, coalesces double retry, and ignores stale status", async () => {
    const old = new FakeHermesManager({
      state: "failed",
      diagnostic: "ssh_start_failed",
    });
    const next = new FakeHermesManager({ state: "owned" });
    const release = deferred<void>();
    old.close.mockImplementation(() => release.promise);
    const start = vi.fn().mockReturnValueOnce(old).mockReturnValue(next);
    const ngrok = vi.fn(async () => fakeNgrokEndpoint());
    const session = new FakeConnectivitySession(liveReadyState());
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session,
      dependencies: {
        startHermesConnectionManager: start,
        startNgrokEndpoint: ngrok,
      },
    });
    await supervisor.settled;
    const first = supervisor.retryHermes();
    const second = supervisor.retryHermes();
    expect(first).toBe(second);
    release.resolve();
    await first;
    old.publish({ state: "failed", diagnostic: "ssh_start_failed" });
    expect(supervisor.readiness.snapshot().components.hermes).toBe("ready");
    expect(start).toHaveBeenCalledTimes(2);
    expect(ngrok).toHaveBeenCalledOnce();
    expect(session.reconcileRecallCapture).toHaveBeenCalledOnce();
    await supervisor.close();
    expect(next.close).toHaveBeenCalledOnce();
  });

  it("quit during retry cleanup never creates another manager", async () => {
    const old = new FakeHermesManager({
      state: "failed",
      diagnostic: "ssh_start_failed",
    });
    const release = deferred<void>();
    old.close.mockImplementation(() => release.promise);
    const start = vi.fn(() => old);
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session: new FakeConnectivitySession(liveReadyState()),
      dependencies: {
        startHermesConnectionManager: start,
        startNgrokEndpoint: async () => fakeNgrokEndpoint(),
      },
    });
    await supervisor.settled;
    const retry = supervisor.retryHermes();
    const close = supervisor.close();
    release.resolve();
    await Promise.all([retry, close]);
    expect(start).toHaveBeenCalledOnce();
  });

  it("drains a request interrupted by network loss without replay before explicit recovery", async () => {
    const authority = new HermesDispatchAuthority();
    const old = new FakeHermesManager({ state: "owned" });
    const next = new FakeHermesManager({ state: "owned" });
    const start = vi.fn().mockReturnValueOnce(old).mockReturnValue(next);
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(authority),
      webhook: { host: "127.0.0.1", port: 54321 },
      session: new FakeConnectivitySession(liveReadyState()),
      dependencies: {
        startHermesConnectionManager: start,
        startNgrokEndpoint: async () => fakeNgrokEndpoint(),
      },
    });
    await supervisor.settled;
    const inflight = deferred<string>();
    const call = vi.fn(() => inflight.promise);
    const response = authority.run(call);
    await Promise.resolve();
    old.publish({ state: "failed", diagnostic: "ssh_owned_forward_exited" });
    const retry = supervisor.retryHermes();
    await Promise.resolve();
    expect(old.close).not.toHaveBeenCalled();
    await expect(authority.run(async () => "new")).rejects.toThrow(
      "unavailable",
    );
    inflight.resolve("synthetic request settled");
    await response;
    await retry;
    expect(call).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
    await supervisor.close();
  });

  it("ignores initial settlement after its owner was retired for retry", async () => {
    const authority = new HermesDispatchAuthority();
    const old = new FakeHermesManager({
      state: "failed",
      diagnostic: "ssh_start_failed",
    });
    const starting = deferred<void>(),
      closing = deferred<void>();
    Object.assign(old, { settled: starting.promise });
    old.close.mockImplementation(() => closing.promise);
    const next = new FakeHermesManager({ state: "owned" });
    const start = vi.fn().mockReturnValueOnce(old).mockReturnValue(next);
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(authority),
      webhook: { host: "127.0.0.1", port: 54321 },
      session: new FakeConnectivitySession(liveReadyState()),
      dependencies: {
        startHermesConnectionManager: start,
        startNgrokEndpoint: async () => fakeNgrokEndpoint(),
      },
    });
    const retry = supervisor.retryHermes();
    old.publish({ state: "owned" });
    starting.resolve();
    await supervisor.settled;
    await expect(
      authority.run(async () => "must stay blocked"),
    ).rejects.toThrow("unavailable");
    closing.resolve();
    await retry;
    await supervisor.close();
  });

  it("makes capture ready while degrading cleanly to Ready without Marty", async () => {
    const session = new FakeConnectivitySession(liveReadyState());
    const endpoint = fakeNgrokEndpoint();
    const hermes = new FakeHermesManager({
      state: "failed",
      diagnostic: "ssh_start_failed",
    });
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session,
      dependencies: {
        startNgrokEndpoint: async () => endpoint,
        startHermesConnectionManager: () => hermes,
      },
    });

    await supervisor.settled;
    expect(supervisor.readiness.snapshot()).toMatchObject({
      state: "ready_without_marty",
      components: {
        ngrok: "ready",
        hermesTunnel: "failed",
        hermes: "unavailable",
        capture: "ready",
      },
    });
    expect(session.reconcileRecallCapture).toHaveBeenCalledOnce();
    expect(session.captureAvailability).toEqual([false, true]);

    await supervisor.close();
    expect(session.captureAvailability.at(-1)).toBe(false);
    expect(endpoint.close).toHaveBeenCalledOnce();
    expect(hermes.close).toHaveBeenCalledOnce();
  });

  it("blocks capture and closes a failed ngrok startup without affecting Hermes", async () => {
    const session = new FakeConnectivitySession(liveReadyState());
    const hermes = new FakeHermesManager({ state: "reused" });
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session,
      dependencies: {
        startNgrokEndpoint: async () => {
          throw Object.assign(new Error("private provider detail"), {
            code: "ngrok_start_failed",
          });
        },
        startHermesConnectionManager: () => hermes,
      },
    });

    await supervisor.settled;
    const snapshot = supervisor.readiness.snapshot();
    expect(snapshot).toMatchObject({
      state: "needs_attention",
      components: { ngrok: "failed", capture: "disabled" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private provider detail");
    expect(session.reconcileRecallCapture).not.toHaveBeenCalled();
    expect(session.captureAvailability).toEqual([false]);
    expect(hermes.snapshot()).toEqual({ state: "reused" });
    await supervisor.close();
  });

  it("retains timed-out ngrok startup ownership until shutdown confirms release", async () => {
    const ownership = deferred<boolean>();
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session: new FakeConnectivitySession(liveReadyState()),
      dependencies: {
        startNgrokEndpoint: async () => {
          throw new NgrokEndpointError(
            "ngrok_start_failed",
            "synthetic timeout",
            ownership.promise,
          );
        },
        startHermesConnectionManager: () =>
          new FakeHermesManager({ state: "reused" }),
      },
    });
    await supervisor.settled;

    let closed = false;
    const closing = supervisor.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    ownership.resolve(true);
    await closing;
  });

  it("fails shutdown when timed-out ngrok ownership cannot be released", async () => {
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session: new FakeConnectivitySession(liveReadyState()),
      dependencies: {
        startNgrokEndpoint: async () => {
          throw new NgrokEndpointError(
            "ngrok_start_failed",
            "synthetic timeout",
            Promise.resolve(false),
          );
        },
        startHermesConnectionManager: () =>
          new FakeHermesManager({ state: "reused" }),
      },
    });
    await supervisor.settled;

    await expect(supervisor.close()).rejects.toThrow(
      "Connectivity shutdown failed",
    );
  });

  it("retains native URL failure ownership until normal shutdown", async () => {
    const ownership = deferred<void>();
    const listener = {
      url: () => {
        throw new Error("synthetic native URL failure");
      },
      close: vi.fn(() => ownership.promise),
    };
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session: new FakeConnectivitySession(liveReadyState()),
      dependencies: {
        startNgrokEndpoint: (options) =>
          startNgrokEndpoint({
            ...options,
            adapter: { forward: async () => listener },
          }),
        startHermesConnectionManager: () =>
          new FakeHermesManager({ state: "reused" }),
      },
    });
    await supervisor.settled;

    let closed = false;
    const closing = supervisor.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    ownership.resolve();
    await closing;
    expect(listener.close).toHaveBeenCalledOnce();
  });

  it("reports one-shot Recall recovery conflicts without issuing provider mutations", async () => {
    const session = new FakeConnectivitySession(liveReadyState());
    session.reconciliation = {
      kind: "needs_attention",
      diagnostic: "recall_reconciliation_conflict",
    };
    const hermes = new FakeHermesManager({ state: "reused" });
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session,
      dependencies: {
        startNgrokEndpoint: async () => fakeNgrokEndpoint(),
        startHermesConnectionManager: () => hermes,
      },
    });

    await supervisor.settled;
    expect(session.reconcileRecallCapture).toHaveBeenCalledOnce();
    expect(supervisor.readiness.snapshot()).toMatchObject({
      state: "needs_attention",
      components: { capture: "needs_attention" },
      diagnostics: [
        expect.objectContaining({
          code: "recall_reconciliation_conflict",
        }),
      ],
    });
    expect(session.captureAvailability).toEqual([false, false]);
    await supervisor.close();
  });

  it("does not repeat Recall recovery when the Hermes transport reconnects", async () => {
    const session = new FakeConnectivitySession(liveReadyState());
    const hermes = new FakeHermesManager({ state: "owned" });
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session,
      dependencies: {
        startNgrokEndpoint: async () => fakeNgrokEndpoint(),
        startHermesConnectionManager: () => hermes,
      },
    });

    await supervisor.settled;
    hermes.publish({
      state: "unavailable",
      diagnostic: "ssh_owned_forward_exited",
    });
    hermes.publish({ state: "owned" });

    expect(session.reconcileRecallCapture).toHaveBeenCalledOnce();
    expect(supervisor.readiness.snapshot()).toMatchObject({
      state: "ready",
      components: { hermesTunnel: "owned", hermes: "ready" },
    });
    await supervisor.close();
  });

  it("gates new capture during ngrok recovery without repeating Recall reconciliation", async () => {
    const session = new FakeConnectivitySession(liveReadyState());
    const endpoint = new FakeNgrokEndpoint();
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session,
      dependencies: {
        startNgrokEndpoint: async () => endpoint,
        startHermesConnectionManager: () =>
          new FakeHermesManager({ state: "reused" }),
      },
    });

    await supervisor.settled;
    endpoint.publish("reconnecting");
    expect(supervisor.readiness.snapshot()).toMatchObject({
      state: "starting",
      components: { ngrok: "reconnecting", capture: "disabled" },
    });
    expect(session.captureAvailability.at(-1)).toBe(false);
    endpoint.publish("ready");
    await vi.waitFor(() =>
      expect(session.captureAvailability.at(-1)).toBe(true),
    );
    expect(supervisor.readiness.snapshot()).toMatchObject({
      state: "ready",
      components: { ngrok: "ready", capture: "ready" },
    });
    expect(session.reconcileRecallCapture).toHaveBeenCalledOnce();
    await supervisor.close();
  });

  it("stops the owned Hermes tunnel before waiting for ngrok shutdown", async () => {
    let finishNgrokClose: () => void = () => undefined;
    const endpoint = fakeNgrokEndpoint();
    endpoint.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishNgrokClose = resolve;
        }),
    );
    const hermes = new FakeHermesManager({ state: "owned" });
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(),
      webhook: { host: "127.0.0.1", port: 54321 },
      session: new FakeConnectivitySession(liveReadyState()),
      dependencies: {
        startNgrokEndpoint: async () => endpoint,
        startHermesConnectionManager: () => hermes,
      },
    });
    await supervisor.settled;

    const close = supervisor.close();
    await vi.waitFor(() => expect(hermes.close).toHaveBeenCalledOnce());
    finishNgrokClose();
    await close;
  });

  it("makes dispatch ready only for an exact local connection and revokes it on loss", async () => {
    const authority = new HermesDispatchAuthority();
    const hermes = new FakeHermesManager({
      state: "unavailable",
      diagnostic: "hermes_unavailable",
    });
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(authority, "local"),
      webhook: { host: "127.0.0.1", port: 54321 },
      session: new FakeConnectivitySession(liveReadyState()),
      dependencies: {
        startNgrokEndpoint: async () => fakeNgrokEndpoint(),
        startHermesConnectionManager: () => hermes,
      },
    });
    await supervisor.settled;

    await expect(authority.run(async () => "blocked")).rejects.toThrow(
      "Assistant is unavailable",
    );
    hermes.publish({ state: "local" });
    await expect(authority.run(async () => "ready")).resolves.toBe("ready");
    hermes.publish({
      state: "unavailable",
      diagnostic: "hermes_unavailable",
    });
    await expect(authority.run(async () => "blocked-again")).rejects.toThrow(
      "Assistant is unavailable",
    );
    await supervisor.close();
  });

  it("drains accepted assistant work before closing an owned SSH connection", async () => {
    const authority = new HermesDispatchAuthority();
    const hermes = new FakeHermesManager({ state: "owned" });
    const supervisor = startConnectivitySupervisor({
      config: connectivityConfig(authority),
      webhook: { host: "127.0.0.1", port: 54321 },
      session: new FakeConnectivitySession(liveReadyState()),
      dependencies: {
        startNgrokEndpoint: async () => fakeNgrokEndpoint(),
        startHermesConnectionManager: () => hermes,
      },
    });
    await supervisor.settled;
    const accepted = deferred<string>();
    const request = authority.run(() => accepted.promise);

    const closing = supervisor.close();
    await Promise.resolve();
    expect(hermes.close).not.toHaveBeenCalled();
    accepted.resolve("settled");
    await expect(request).resolves.toBe("settled");
    await closing;
    expect(hermes.close).toHaveBeenCalledOnce();
  });
});

function connectivityConfig(
  dispatchAuthority = new HermesDispatchAuthority(),
  mode: "local" | "ssh" = "ssh",
) {
  return {
    ngrok: {
      authtoken: "private-ngrok-token",
      approvedDomain: "interviews.example.ngrok-free.dev",
    },
    hermes: {
      kind: "configured" as const,
      mode,
      apiKey: "private-hermes-key",
      baseUrl: "http://127.0.0.1:8642",
      profile: "selected-profile",
      localPort: 8_642,
      remotePort: 8_642,
      sshTarget: mode === "ssh" ? "operator@hermes-host.local" : null,
      dispatchAuthority,
    },
  };
}

function liveReadyState(): SessionState {
  return createSessionState({
    sessionId: "connectivity-session",
    startedAt: "2026-08-25T12:00:00.000Z",
    capture: {
      mode: "live_ready",
      meetingPlatform: "microsoft_teams_personal",
      recording: { location: null, retention: null },
    },
  });
}

function fakeNgrokEndpoint(): NgrokEndpoint & {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    url: "https://interviews.example.ngrok-free.dev",
    snapshot: () => "ready",
    subscribe: () => () => undefined,
    close: vi.fn(async () => undefined),
  };
}

class FakeNgrokEndpoint implements NgrokEndpoint {
  readonly url = "https://interviews.example.ngrok-free.dev";
  readonly close = vi.fn<() => Promise<void>>(async () => undefined);
  readonly #listeners = new Set<(status: NgrokEndpointStatus) => void>();
  #status: NgrokEndpointStatus = "ready";

  snapshot(): NgrokEndpointStatus {
    return this.#status;
  }

  subscribe(listener: (status: NgrokEndpointStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(status: NgrokEndpointStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) {
      listener(status);
    }
  }
}

class FakeConnectivitySession implements ConnectivitySession {
  reconciliation: RecallReconciliationResult = { kind: "not_needed" };
  readonly captureAvailability: boolean[] = [];
  readonly reconcileRecallCapture = vi.fn(async () => this.reconciliation);

  constructor(private state: SessionState) {}

  getSnapshot(): SessionState {
    return structuredClone(this.state);
  }

  setRecallCaptureAvailable(available: boolean): void {
    this.captureAvailability.push(available);
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    listener(this.getSnapshot());
    return () => undefined;
  }
}

class FakeHermesManager implements HermesConnectionManager {
  readonly settled = Promise.resolve();
  readonly close = vi.fn<() => Promise<void>>(async () => undefined);
  readonly #listeners = new Set<(status: HermesConnectionStatus) => void>();

  constructor(private status: HermesConnectionStatus) {}

  snapshot(): HermesConnectionStatus {
    return { ...this.status };
  }

  subscribe(listener: (status: HermesConnectionStatus) => void): () => void {
    listener(this.snapshot());
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(status: HermesConnectionStatus): void {
    this.status = status;
    for (const listener of this.#listeners) {
      listener(this.snapshot());
    }
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
