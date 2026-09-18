import { describe, expect, it, vi } from "vitest";
import {
  NgrokEndpointError,
  startNgrokEndpoint,
  type NgrokAdapter,
  type NgrokForwardOptions,
  type NgrokListener,
} from "../../src/server/connectivity/ngrok-endpoint-manager.js";

const approvedDomain = "interviews.example.ngrok-free.dev";

describe("ngrok endpoint manager", () => {
  it("forwards only the assigned webhook listener through the approved domain", async () => {
    const listener = new FakeNgrokListener(`https://${approvedDomain}`);
    const adapter = new FakeNgrokAdapter(listener);

    const endpoint = await startNgrokEndpoint({
      adapter,
      authtoken: "private-ngrok-token",
      approvedDomain,
      webhook: { host: "127.0.0.1", port: 54321 },
    });

    expect(adapter.forward).toHaveBeenCalledWith({
      addr: "http://127.0.0.1:54321",
      authtoken: "private-ngrok-token",
      domain: approvedDomain,
      onStatusChange: expect.any(Function),
    });
    expect(endpoint.url).toBe(`https://${approvedDomain}`);
    await Promise.all([endpoint.close(), endpoint.close()]);
    expect(listener.close).toHaveBeenCalledOnce();
  });

  it("reports recovery and closes the listener after a bounded reconnect window", async () => {
    vi.useFakeTimers();
    try {
      const listener = new FakeNgrokListener(`https://${approvedDomain}`);
      const adapter = new FakeNgrokAdapter(listener);
      const endpoint = await startNgrokEndpoint({
        adapter,
        authtoken: "private-ngrok-token",
        approvedDomain,
        reconnectTimeoutMs: 50,
        webhook: { host: "127.0.0.1", port: 54321 },
      });
      const statuses: string[] = [];
      endpoint.subscribe((status) => statuses.push(status));

      adapter.publish("closed");
      expect(endpoint.snapshot()).toBe("reconnecting");
      adapter.publish("connected");
      expect(endpoint.snapshot()).toBe("ready");
      expect(listener.close).not.toHaveBeenCalled();

      adapter.publish("closed");
      await vi.advanceTimersByTimeAsync(50);
      expect(endpoint.snapshot()).toBe("failed");
      adapter.publish("connected");
      expect(endpoint.snapshot()).toBe("failed");
      expect(statuses).toEqual([
        "reconnecting",
        "ready",
        "reconnecting",
        "failed",
      ]);
      expect(listener.close).toHaveBeenCalledOnce();
      await endpoint.close();
      expect(listener.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds endpoint startup and closes a listener that arrives after timeout", async () => {
    const listener = new FakeNgrokListener(`https://${approvedDomain}`);
    const pending = deferred<NgrokListener>();
    const adapter: NgrokAdapter = { forward: vi.fn(() => pending.promise) };
    const starting = startNgrokEndpoint({
      adapter,
      authtoken: "private-ngrok-token",
      approvedDomain,
      startupTimeoutMs: 5,
      webhook: { host: "127.0.0.1", port: 54321 },
    });

    await expect(starting).rejects.toMatchObject({
      code: "ngrok_start_failed",
    });
    pending.resolve(listener);
    await Promise.resolve();
    expect(listener.close).toHaveBeenCalledOnce();
  });

  it("closes a native listener whose returned URL does not match the approved domain", async () => {
    const listener = new FakeNgrokListener("https://wrong-domain.ngrok.app");

    await expect(
      startNgrokEndpoint({
        adapter: new FakeNgrokAdapter(listener),
        authtoken: "private-ngrok-token",
        approvedDomain,
        webhook: { host: "127.0.0.1", port: 54321 },
      }),
    ).rejects.toMatchObject({ code: "ngrok_domain_mismatch" });
    expect(listener.close).toHaveBeenCalledOnce();
  });

  it("preserves ownership when an unexpected endpoint cannot be closed", async () => {
    const listener: NgrokListener = {
      url: () => "https://wrong-domain.ngrok.app",
      close: vi.fn(async () => {
        throw new Error("synthetic close failure");
      }),
    };

    const starting = startNgrokEndpoint({
      adapter: new FakeNgrokAdapter(listener),
      authtoken: "private-ngrok-token",
      approvedDomain,
      webhook: { host: "127.0.0.1", port: 54321 },
    });

    const error = await starting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NgrokEndpointError);
    expect(error).toMatchObject({ code: "ngrok_domain_mismatch" });
    expect(await (error as NgrokEndpointError).pendingOwnershipRelease).toBe(
      false,
    );
    expect(listener.close).toHaveBeenCalledOnce();
  });

  it("preserves ownership when transport failure wins the startup race", async () => {
    vi.useFakeTimers();
    try {
      const listener: NgrokListener = {
        url: () => `https://${approvedDomain}`,
        close: vi.fn(async () => {
          throw new Error("synthetic close failure");
        }),
      };
      const forward = deferred<NgrokListener>();
      let publish: ((status: string) => void) | undefined;
      const adapter: NgrokAdapter = {
        forward: vi.fn((options) => {
          publish = options.onStatusChange;
          return forward.promise;
        }),
      };
      const starting = startNgrokEndpoint({
        adapter,
        authtoken: "private-ngrok-token",
        approvedDomain,
        reconnectTimeoutMs: 5,
        startupTimeoutMs: 100,
        webhook: { host: "127.0.0.1", port: 54321 },
      });

      await vi.waitFor(() => expect(publish).toBeTypeOf("function"));
      publish?.("closed");
      await vi.advanceTimersByTimeAsync(5);
      forward.resolve(listener);

      const error = await starting.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NgrokEndpointError);
      expect(error).toMatchObject({ code: "ngrok_start_failed" });
      expect(await (error as NgrokEndpointError).pendingOwnershipRelease).toBe(
        false,
      );
      expect(listener.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves ownership when reading the native listener URL throws", async () => {
    const listener: NgrokListener = {
      url: () => {
        throw new Error("synthetic native URL failure");
      },
      close: vi.fn(async () => {
        throw new Error("synthetic close failure");
      }),
    };

    const starting = startNgrokEndpoint({
      adapter: new FakeNgrokAdapter(listener),
      authtoken: "private-ngrok-token",
      approvedDomain,
      webhook: { host: "127.0.0.1", port: 54321 },
    });

    const error = await starting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NgrokEndpointError);
    expect(error).toMatchObject({ code: "ngrok_start_failed" });
    expect(await (error as NgrokEndpointError).pendingOwnershipRelease).toBe(
      false,
    );
    expect(listener.close).toHaveBeenCalledOnce();
  });
});

class FakeNgrokAdapter implements NgrokAdapter {
  readonly forward = vi.fn(async (_options: NgrokForwardOptions) =>
    Promise.resolve(this.listener),
  );

  constructor(private readonly listener: NgrokListener) {}

  publish(status: string): void {
    const options = this.forward.mock.calls[0]?.[0];
    options?.onStatusChange?.(status);
  }
}

class FakeNgrokListener implements NgrokListener {
  readonly close = vi.fn(async () => undefined);

  constructor(private readonly publicUrl: string) {}

  url(): string {
    return this.publicUrl;
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
