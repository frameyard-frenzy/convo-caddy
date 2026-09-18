import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
import { startHermesConnectionManager } from "../../src/server/connectivity/hermes-connection-manager.js";

describe("owned OpenSSH bind proof", () => {
  it.each(["pre-bind only", "wrong port", "reversed confirmation"])(
    "does not probe across polling intervals with %s",
    async (scenario) => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        kill: vi.fn(() => {
          child.emit("exit", null, "SIGTERM");
          return true;
        }),
      });
      native.spawn.mockReset().mockReturnValue(child);
      const probe = vi.fn(async () => ({ kind: "verified" as const }));
      const waits: Array<() => void> = [];
      const manager = startHermesConnectionManager({
        mode: "ssh",
        sshTarget: "operator@100.101.102.103",
        baseUrl: "http://127.0.0.1:18642",
        apiKey: "synthetic",
        profile: "synthetic",
        localPort: 18642,
        remotePort: 8642,
        requireOwnedForward: true,
        isPortAvailable: async () => true,
        probeIdentity: probe,
        readinessAttempts: 3,
        reconnectAttempts: 0,
        delay: () =>
          new Promise<void>((resolve) => {
            waits.push(resolve);
          }),
      });
      try {
        await vi.waitFor(() => expect(waits).toHaveLength(1));
        const emit = (line: string) =>
          child.stderr.emit("data", Buffer.from(line + "\n"));
        const confirmation =
          "debug1: channel 0: new port-listener [port listener] (inactive timeout: 0)";
        if (scenario === "reversed confirmation") emit(confirmation);
        emit(
          `debug1: Local forwarding listening on 127.0.0.1 port ${scenario === "wrong port" ? 18643 : 18642}.`,
        );
        if (scenario === "wrong port") emit(confirmation);
        waits[0]!();
        await vi.waitFor(() => expect(waits).toHaveLength(2));
        expect(probe).not.toHaveBeenCalled();
        waits[1]!();
        await vi.waitFor(() => expect(waits).toHaveLength(3));
        expect(probe).not.toHaveBeenCalled();
        waits[2]!();
        await manager.settled;
        expect(manager.snapshot().state).toBe("failed");
        expect(probe).not.toHaveBeenCalled();
      } finally {
        await manager.close();
      }
    },
  );
  it.each([true, false])(
    "requires post-listen confirmation, including split stderr chunks (%s)",
    async (success) => {
      const child = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => {
        child.emit("exit", null, "SIGTERM");
        return true;
      });
      native.spawn.mockReturnValue(child);
      const probe = vi.fn(async () => ({ kind: "verified" as const }));
      const manager = startHermesConnectionManager({
        mode: "ssh",
        sshTarget: "operator@100.101.102.103",
        baseUrl: "http://127.0.0.1:18642",
        apiKey: "synthetic",
        profile: "synthetic",
        localPort: 18642,
        remotePort: 8642,
        requireOwnedForward: true,
        isPortAvailable: async () => true,
        probeIdentity: probe,
        readinessAttempts: 3,
        reconnectAttempts: 0,
      });
      await vi.waitFor(() => expect(native.spawn).toHaveBeenCalled());
      expect(native.spawn.mock.calls.at(-1)?.[1]).toContain("-v");
      child.stderr.emit(
        "data",
        Buffer.from(
          "debug1: Local forwarding listening on 127.0.0.1 port 18642.\n",
        ),
      );
      expect(probe).not.toHaveBeenCalled();
      if (success) {
        child.stderr.emit("data", Buffer.from("debug1: channel 0: new port-"));
        child.stderr.emit(
          "data",
          Buffer.from("listener [port listener] (inactive timeout: 0)\r\n"),
        );
      } else {
        child.stderr.emit(
          "data",
          Buffer.from(
            "bind [127.0.0.1]:18642: Address already in use\nPRIVATE-SSH-DETAIL\n",
          ),
        );
        child.emit("exit", 255, null);
      }
      await manager.settled;
      expect(manager.snapshot().state).toBe(success ? "owned" : "failed");
      expect(probe).toHaveBeenCalledTimes(success ? 1 : 0);
      expect(JSON.stringify(manager.snapshot())).not.toContain("PRIVATE");
      await manager.close();
    },
  );
});
