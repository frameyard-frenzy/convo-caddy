import { describe, expect, it } from "vitest";
import { HermesDispatchAuthority } from "../../src/server/marty/hermes-dispatch-authority.js";

describe("Hermes dispatch authority", () => {
  it("rejects new operations unless the current connection is ready", async () => {
    const authority = new HermesDispatchAuthority();

    await expect(authority.run(async () => "unexpected")).rejects.toThrow(
      "Assistant is unavailable while the Hermes connection is not ready.",
    );

    authority.markReady();
    await expect(authority.run(async () => "accepted")).resolves.toBe(
      "accepted",
    );

    authority.markUnavailable();
    await expect(authority.run(async () => "unexpected")).rejects.toThrow(
      "Assistant is unavailable while the Hermes connection is not ready.",
    );
  });

  it("stops accepting work and drains an already accepted operation before closing", async () => {
    const authority = new HermesDispatchAuthority();
    const operation = deferred<string>();
    authority.markReady();
    const accepted = authority.run(() => operation.promise);

    let drained = false;
    const closing = authority.closeAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(authority.run(async () => "late")).rejects.toThrow(
      "Assistant is unavailable while the Hermes connection is not ready.",
    );

    operation.resolve("complete");
    await expect(accepted).resolves.toBe("complete");
    await closing;
    expect(drained).toBe(true);
    expect(() => authority.markReady()).toThrow(
      "Closed Hermes dispatch authority cannot become ready.",
    );
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
