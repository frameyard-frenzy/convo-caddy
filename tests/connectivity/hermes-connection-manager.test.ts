import { describe, expect, it, vi } from "vitest";
import {
  hermesSshArguments,
  startHermesConnectionManager,
  type OwnedSshProcess,
  type SshProcessAdapter,
} from "../../src/server/connectivity/hermes-connection-manager.js";
import type { HermesIdentityResult } from "../../src/server/connectivity/hermes-identity.js";

describe("Hermes connection manager", () => {
  it("refuses an occupied setup port without probing or touching its occupant", async () => {
    const adapter = new FakeSshProcessAdapter();
    const probeIdentity = vi.fn(async () => ({ kind: "verified" as const }));
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@100.101.102.103",
      requireOwnedForward: true,
      isPortAvailable: async () => false,
      probeIdentity,
    });
    await manager.settled;
    expect(manager.snapshot()).toEqual({
      state: "failed",
      diagnostic: "ssh_forward_unavailable",
    });
    expect(probeIdentity).not.toHaveBeenCalled();
    expect(adapter.spawn).not.toHaveBeenCalled();
    await manager.close();
  });

  it.each(["operator@100.101.102.103", "operator@hermes.example.ts.net"])(
    "owns a fresh setup forward to %s even with matching metadata",
    async (sshTarget) => {
      const adapter = new FakeSshProcessAdapter();
      const manager = startHermesConnectionManager({
        ...common(adapter),
        mode: "ssh",
        sshTarget,
        requireOwnedForward: true,
        isPortAvailable: async () => true,
        probeIdentity: async () => ({ kind: "verified" }),
      });
      await manager.settled;
      expect(manager.snapshot()).toEqual({ state: "owned" });
      expect(adapter.spawn).toHaveBeenCalledOnce();
      await manager.close();
    },
  );

  it("does not trust metadata until the owned SSH process confirms its bind", async () => {
    const adapter = new FakeSshProcessAdapter();
    const bound = deferred<boolean>();
    Object.assign(adapter.process, { forwardReady: bound.promise });
    const probeIdentity = vi.fn(async () => ({ kind: "verified" as const }));
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@100.101.102.103",
      requireOwnedForward: true,
      isPortAvailable: async () => true,
      probeIdentity,
    });
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledOnce());
    expect(probeIdentity).not.toHaveBeenCalled();
    bound.resolve(false);
    await manager.settled;
    expect(manager.snapshot()).toMatchObject({ state: "failed" });
    expect(probeIdentity).not.toHaveBeenCalled();
    await manager.close();
  });

  it("exhausts reconnection without exposing an intermediate failure as settled", async () => {
    const first = new FakeOwnedSshProcess();
    const attempts = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(() => {
        throw new Error("synthetic offline");
      });
    let initiallyReady = false;
    const manager = startHermesConnectionManager({
      ...common({ spawn: attempts }),
      mode: "ssh",
      sshTarget: "operator@100.101.102.103",
      reconnectAttempts: 2,
      probeIdentity: async () => {
        if (attempts.mock.calls.length === 1 && !initiallyReady) {
          initiallyReady = true;
          return { kind: "verified" };
        }
        return { kind: "absent" };
      },
    });
    await manager.settled;
    const states: string[] = [];
    manager.subscribe((status) => states.push(status.state));
    first.exit({ code: 255, signal: null });
    await vi.waitFor(() => expect(attempts).toHaveBeenCalledTimes(3));
    expect(states.filter((state) => state === "failed")).toHaveLength(1);
    expect(manager.snapshot()).toMatchObject({ state: "failed" });
    await manager.close();
  });

  it("builds a config-isolated loopback-only SSH invocation", () => {
    expect(
      hermesSshArguments({
        localPort: 18_642,
        remotePort: 28_642,
        sshTarget: "operator@hermes-host.local",
      }),
    ).toEqual([
      "-F",
      "none",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "ProxyCommand=none",
      "-o",
      "ProxyJump=none",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ControlPersist=no",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "GatewayPorts=no",
      "-o",
      "RemoteCommand=none",
      "-o",
      "RequestTTY=no",
      "-o",
      "SessionType=none",
      "-o",
      "Tunnel=no",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-N",
      "-L",
      "127.0.0.1:18642:127.0.0.1:28642",
      "operator@hermes-host.local",
    ]);
  });

  it.each(["-Ffoo", "operator@-Ffoo", "--"])(
    "rejects option-like or non-host SSH target %s",
    (sshTarget) => {
      expect(() =>
        hermesSshArguments({
          localPort: 8_642,
          remotePort: 8_642,
          sshTarget,
        }),
      ).toThrow("Hermes SSH target has an invalid format.");
    },
  );

  it("keeps local mode SSH-free while an absent service becomes ready", async () => {
    const adapter = new FakeSshProcessAdapter();
    const monitor = controlledDelays();
    const probes: HermesIdentityResult[] = [
      { kind: "absent" },
      { kind: "verified" },
    ];
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "local",
      probeIdentity: async () => probes.shift() ?? { kind: "verified" },
      monitorDelay: monitor.delay,
    });

    await manager.settled;
    expect(manager.snapshot()).toEqual({
      state: "unavailable",
      diagnostic: "hermes_unavailable",
    });
    expect(adapter.spawn).not.toHaveBeenCalled();

    monitor.releaseNext();
    await vi.waitFor(() =>
      expect(manager.snapshot()).toEqual({ state: "local" }),
    );
    expect(adapter.spawn).not.toHaveBeenCalled();
    await manager.close();
  });

  it("blocks local readiness on loss and recovers only after exact identity returns", async () => {
    const adapter = new FakeSshProcessAdapter();
    const monitor = controlledDelays();
    const probes: HermesIdentityResult[] = [
      { kind: "verified" },
      { kind: "absent" },
      { kind: "verified" },
    ];
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "local",
      probeIdentity: async () => probes.shift() ?? { kind: "verified" },
      monitorDelay: monitor.delay,
    });

    await manager.settled;
    expect(manager.snapshot()).toEqual({ state: "local" });
    monitor.releaseNext();
    await vi.waitFor(() =>
      expect(manager.snapshot()).toEqual({
        state: "unavailable",
        diagnostic: "hermes_unavailable",
      }),
    );
    monitor.releaseNext();
    await vi.waitFor(() =>
      expect(manager.snapshot()).toEqual({ state: "local" }),
    );
    await manager.close();
  });

  it("waits for an in-flight monitor probe before releasing connection ownership", async () => {
    const adapter = new FakeSshProcessAdapter();
    const monitor = controlledDelays();
    const lateProbe = deferred<HermesIdentityResult>();
    const probeIdentity = vi
      .fn<() => Promise<HermesIdentityResult>>()
      .mockResolvedValueOnce({ kind: "verified" })
      .mockReturnValueOnce(lateProbe.promise);
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "local",
      probeIdentity,
      monitorDelay: monitor.delay,
    });

    await manager.settled;
    monitor.releaseNext();
    await vi.waitFor(() => expect(probeIdentity).toHaveBeenCalledTimes(2));

    let closed = false;
    const closing = manager.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    lateProbe.resolve({ kind: "verified" });
    await closing;
    expect(closed).toBe(true);
  });

  it("spawns the exact parameterized key-only forward and owns only its child", async () => {
    const adapter = new FakeSshProcessAdapter();
    const probes: HermesIdentityResult[] = [
      { kind: "absent" },
      { kind: "verified" },
    ];
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      baseUrl: "http://127.0.0.1:18642",
      localPort: 18_642,
      remotePort: 28_642,
      sshTarget: "operator@hermes-host.local",
      probeIdentity: async () => probes.shift() ?? { kind: "verified" },
      delay: async () => undefined,
    });

    await manager.settled;
    expect(manager.snapshot()).toEqual({ state: "owned" });
    expect(adapter.spawn).toHaveBeenCalledWith({
      executable: "/usr/bin/ssh",
      args: hermesSshArguments({
        localPort: 18_642,
        remotePort: 28_642,
        sshTarget: "operator@hermes-host.local",
      }),
    });
    await manager.close();
    expect(adapter.process.terminate).toHaveBeenCalledOnce();
  });

  it("rejects a base URL that does not exactly match the configured loopback port", () => {
    expect(() =>
      startHermesConnectionManager({
        ...common(new FakeSshProcessAdapter()),
        mode: "local",
        localPort: 18_642,
      }),
    ).toThrow("Hermes base URL must match the configured loopback port.");
  });

  it("reuses exact SSH Hermes without claiming or terminating the listener", async () => {
    const adapter = new FakeSshProcessAdapter();
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@hermes-host.local",
      probeIdentity: async () => ({ kind: "verified" }),
    });

    await manager.settled;
    expect(manager.snapshot()).toEqual({ state: "reused" });
    expect(adapter.spawn).not.toHaveBeenCalled();
    await manager.close();
    expect(adapter.process.terminate).not.toHaveBeenCalled();
  });

  it("rejects an unknown local-port occupant without spawning or killing it", async () => {
    const adapter = new FakeSshProcessAdapter();
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@hermes-host.local",
      probeIdentity: async () => ({
        kind: "rejected",
        reason: "profile_not_advertised",
      }),
    });

    await manager.settled;
    expect(manager.snapshot()).toEqual({
      state: "failed",
      diagnostic: "hermes_profile_not_advertised",
    });
    expect(adapter.spawn).not.toHaveBeenCalled();
    expect(adapter.process.terminate).not.toHaveBeenCalled();
  });

  it("surfaces and cleans a child that exits before the forward is ready", async () => {
    const adapter = new FakeSshProcessAdapter();
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@hermes-host.local",
      probeIdentity: async () => ({ kind: "absent" }),
      delay: async () => {
        adapter.process.exit({ code: 255, signal: null });
      },
    });

    await manager.settled;
    expect(manager.snapshot()).toEqual({
      state: "failed",
      diagnostic: "ssh_exited_before_ready",
    });
    expect(adapter.process.terminate).toHaveBeenCalledOnce();
  });

  it("rejects readiness from a probe that outlives its starting child", async () => {
    const adapter = new FakeSshProcessAdapter();
    const lateProbe = deferred<HermesIdentityResult>();
    const probeIdentity = vi
      .fn<() => Promise<HermesIdentityResult>>()
      .mockResolvedValueOnce({ kind: "absent" })
      .mockReturnValueOnce(lateProbe.promise);
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@hermes-host.local",
      probeIdentity,
    });

    await vi.waitFor(() => expect(probeIdentity).toHaveBeenCalledTimes(2));
    adapter.process.exit({ code: 255, signal: null });
    lateProbe.resolve({ kind: "verified" });
    await manager.settled;

    expect(manager.snapshot()).toEqual({
      state: "failed",
      diagnostic: "ssh_exited_before_ready",
    });
    expect(adapter.process.terminate).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("reconnects an owned forward with bounded attempts after its child exits", async () => {
    const first = new FakeOwnedSshProcess();
    const second = new FakeOwnedSshProcess();
    const adapter: SshProcessAdapter = {
      spawn: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    };
    const probes: HermesIdentityResult[] = [
      { kind: "absent" },
      { kind: "verified" },
      { kind: "absent" },
      { kind: "verified" },
    ];
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@hermes-host.local",
      probeIdentity: async () => probes.shift() ?? { kind: "verified" },
    });
    const statuses: unknown[] = [];
    manager.subscribe((status) => statuses.push(status));

    await manager.settled;
    first.exit({ code: 255, signal: null });
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledTimes(2));
    expect(statuses).toContainEqual({
      state: "unavailable",
      diagnostic: "ssh_owned_forward_exited",
    });
    expect(manager.snapshot()).toEqual({ state: "owned" });
    expect(first.terminate).not.toHaveBeenCalled();
    await manager.close();
    expect(second.terminate).toHaveBeenCalledOnce();
  });

  it("never republishes owned from a probe that outlives its child", async () => {
    const adapter = new FakeSshProcessAdapter();
    const monitor = controlledDelays();
    const lateProbe = deferred<HermesIdentityResult>();
    const probeIdentity = vi
      .fn<() => Promise<HermesIdentityResult>>()
      .mockResolvedValueOnce({ kind: "absent" })
      .mockResolvedValueOnce({ kind: "verified" })
      .mockReturnValueOnce(lateProbe.promise);
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@hermes-host.local",
      probeIdentity,
      monitorDelay: monitor.delay,
      reconnectAttempts: 0,
    });

    await manager.settled;
    expect(manager.snapshot()).toEqual({ state: "owned" });
    monitor.releaseNext();
    await vi.waitFor(() => expect(probeIdentity).toHaveBeenCalledTimes(3));

    adapter.process.exit({ code: 255, signal: null });
    await vi.waitFor(() =>
      expect(manager.snapshot()).toEqual({
        state: "failed",
        diagnostic: "ssh_owned_forward_exited",
      }),
    );
    lateProbe.resolve({ kind: "verified" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.snapshot()).toEqual({
      state: "failed",
      diagnostic: "ssh_owned_forward_exited",
    });
    await manager.close();
  });

  it("does not reconnect when closing an owned child", async () => {
    const adapter = new FakeSshProcessAdapter();
    adapter.process.terminate.mockImplementation(async () => {
      adapter.process.exit({ code: null, signal: "SIGTERM" });
    });
    const probes: HermesIdentityResult[] = [
      { kind: "absent" },
      { kind: "verified" },
    ];
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@hermes-host.local",
      probeIdentity: async () => probes.shift() ?? { kind: "absent" },
    });

    await manager.settled;
    await manager.close();
    await Promise.resolve();
    expect(adapter.spawn).toHaveBeenCalledOnce();
  });

  it("terminates a late-starting owned child exactly once during close", async () => {
    const adapter = new FakeSshProcessAdapter();
    adapter.process.terminate.mockImplementation(async () => {
      adapter.process.exit({ code: null, signal: "SIGTERM" });
    });
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@hermes-host.local",
      probeIdentity: async () => ({ kind: "absent" }),
      delay: async () => new Promise<void>(() => undefined),
    });
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledOnce());

    await manager.close();
    expect(adapter.process.terminate).toHaveBeenCalledOnce();
  });

  it("owns a replacement only after an exact reused listener disappears", async () => {
    const adapter = new FakeSshProcessAdapter();
    const monitor = controlledDelays();
    const probes: HermesIdentityResult[] = [
      { kind: "verified" },
      { kind: "absent" },
      { kind: "absent" },
      { kind: "verified" },
    ];
    const manager = startHermesConnectionManager({
      ...common(adapter),
      mode: "ssh",
      sshTarget: "operator@hermes-host.local",
      probeIdentity: async () => probes.shift() ?? { kind: "verified" },
      monitorDelay: monitor.delay,
    });

    await manager.settled;
    expect(manager.snapshot()).toEqual({ state: "reused" });
    monitor.releaseNext();
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledOnce());
    expect(manager.snapshot()).toEqual({ state: "owned" });
    await manager.close();
  });
});

function common(adapter: SshProcessAdapter) {
  return {
    apiKey: "private-key",
    baseUrl: "http://127.0.0.1:8642",
    profile: "selected-profile",
    localPort: 8_642,
    remotePort: 8_642,
    processAdapter: adapter,
    readinessAttempts: 3,
    reconnectAttempts: 1,
    delay: async () => undefined,
  };
}

function controlledDelays() {
  const waiting: Array<() => void> = [];
  return {
    delay: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
      }),
    releaseNext() {
      const resolve = waiting.shift();
      if (!resolve) {
        throw new Error("No Hermes monitor delay is pending.");
      }
      resolve();
    },
  };
}

class FakeSshProcessAdapter implements SshProcessAdapter {
  readonly process = new FakeOwnedSshProcess();
  readonly spawn = vi.fn(() => this.process);
}

class FakeOwnedSshProcess implements OwnedSshProcess {
  readonly forwardReady = Promise.resolve(true);
  readonly #exit = deferred<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  readonly exited = this.#exit.promise;
  readonly terminate = vi.fn(async () => undefined);

  exit(result: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.#exit.resolve(result);
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
