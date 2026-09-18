export class HermesDispatchAuthority {
  readonly #inFlight = new Set<Promise<unknown>>();
  #state: "unavailable" | "ready" | "closing" = "unavailable";
  #closePromise: Promise<void> | null = null;

  static readyForUnmanagedConnection(): HermesDispatchAuthority {
    const authority = new HermesDispatchAuthority();
    authority.markReady();
    return authority;
  }

  markReady(): void {
    if (this.#state === "closing") {
      throw new Error("Closed Hermes dispatch authority cannot become ready.");
    }
    this.#state = "ready";
  }

  markUnavailable(): void {
    if (this.#state !== "closing") {
      this.#state = "unavailable";
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#state !== "ready") {
      return Promise.reject(
        new Error(
          "Assistant is unavailable while the Hermes connection is not ready.",
        ),
      );
    }
    const accepted = Promise.resolve().then(operation);
    this.#inFlight.add(accepted);
    void accepted
      .finally(() => {
        this.#inFlight.delete(accepted);
      })
      .catch(() => undefined);
    return accepted;
  }

  drain(): Promise<void> {
    return Promise.allSettled([...this.#inFlight]).then(() => undefined);
  }

  closeAndDrain(): Promise<void> {
    this.#state = "closing";
    this.#closePromise ??= Promise.allSettled([...this.#inFlight]).then(
      () => undefined,
    );
    return this.#closePromise;
  }
}
