export type NgrokForwardOptions = {
  addr: string;
  authtoken: string;
  domain: string;
  onStatusChange?: (status: string) => void;
};

export interface NgrokListener {
  url(): string | null;
  close(): Promise<void>;
}

export interface NgrokAdapter {
  forward(options: NgrokForwardOptions): Promise<NgrokListener>;
}

export type NgrokEndpoint = {
  url: string;
  snapshot(): NgrokEndpointStatus;
  subscribe(listener: NgrokEndpointListener): () => void;
  close(): Promise<void>;
};

export type NgrokEndpointStatus = "ready" | "reconnecting" | "failed";
export type NgrokEndpointListener = (status: NgrokEndpointStatus) => void;

export class NgrokEndpointError extends Error {
  readonly code: "ngrok_start_failed" | "ngrok_domain_mismatch";
  readonly pendingOwnershipRelease: Promise<boolean> | null;

  constructor(
    code: NgrokEndpointError["code"],
    message: string,
    pendingOwnershipRelease: Promise<boolean> | null = null,
  ) {
    super(message);
    this.name = "NgrokEndpointError";
    this.code = code;
    this.pendingOwnershipRelease = pendingOwnershipRelease;
  }
}

export type StartNgrokEndpointOptions = {
  adapter?: NgrokAdapter;
  authtoken: string;
  approvedDomain: string;
  reconnectTimeoutMs?: number;
  startupTimeoutMs?: number;
  webhook: { host: "127.0.0.1"; port: number };
};

export async function startNgrokEndpoint(
  options: StartNgrokEndpointOptions,
): Promise<NgrokEndpoint> {
  const authtoken = requireValue(options.authtoken, "ngrok auth token");
  const approvedDomain = validateDomain(options.approvedDomain);
  const reconnectTimeoutMs = positiveInteger(
    options.reconnectTimeoutMs ?? 30_000,
    "ngrok reconnect timeout",
  );
  const startupTimeoutMs = positiveInteger(
    options.startupTimeoutMs ?? 30_000,
    "ngrok startup timeout",
  );
  if (
    options.webhook.host !== "127.0.0.1" ||
    !Number.isInteger(options.webhook.port) ||
    options.webhook.port < 1 ||
    options.webhook.port > 65_535
  ) {
    throw new Error("ngrok must forward to an assigned loopback webhook port.");
  }

  const adapter = options.adapter ?? (await loadDefaultNgrokAdapter());
  let listener: NgrokListener | null = null;
  const status: { current: NgrokEndpointStatus } = { current: "ready" };
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closePromise: Promise<void> | null = null;
  const subscribers = new Set<NgrokEndpointListener>();
  const publish = (nextStatus: NgrokEndpointStatus) => {
    if (closed) {
      return;
    }
    status.current = nextStatus;
    for (const subscriber of subscribers) {
      subscriber(status.current);
    }
  };
  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  const closeListener = () => {
    if (closePromise) {
      return closePromise;
    }
    if (!listener) {
      return Promise.resolve();
    }
    closePromise = listener.close();
    return closePromise;
  };
  const releaseListenerOwnership = (): Promise<boolean> => {
    try {
      return closeListener().then(
        () => true,
        () => false,
      );
    } catch {
      return Promise.resolve(false);
    }
  };
  const onStatusChange = (nextStatus: string) => {
    if (closed || status.current === "failed") {
      return;
    }
    if (nextStatus === "connected") {
      clearReconnectTimer();
      publish("ready");
      return;
    }
    if (nextStatus !== "closed") {
      return;
    }
    publish("reconnecting");
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      publish("failed");
      void closeListener().catch(() => undefined);
    }, reconnectTimeoutMs);
    reconnectTimer.unref?.();
  };
  try {
    const forwardPromise = adapter.forward({
      addr: `http://127.0.0.1:${options.webhook.port}`,
      authtoken,
      domain: approvedDomain,
      onStatusChange,
    });
    listener = await withStartupTimeout(
      forwardPromise,
      startupTimeoutMs,
      async (lateListener) => {
        await lateListener.close();
      },
    );
    if (status.current === "failed") {
      throw new NgrokEndpointError(
        "ngrok_start_failed",
        "Convo Caddy could not establish the Recall webhook endpoint.",
        releaseListenerOwnership(),
      );
    }
  } catch (error) {
    closed = true;
    clearReconnectTimer();
    if (error instanceof NgrokEndpointError) {
      throw error;
    }
    throw new NgrokEndpointError(
      "ngrok_start_failed",
      "Convo Caddy could not establish the Recall webhook endpoint.",
      error instanceof NgrokStartupTimeoutError
        ? error.pendingOwnershipRelease
        : null,
    );
  }

  let publicUrl: string | null;
  try {
    publicUrl = listener.url();
  } catch {
    closed = true;
    clearReconnectTimer();
    subscribers.clear();
    throw new NgrokEndpointError(
      "ngrok_start_failed",
      "Convo Caddy could not inspect the Recall webhook endpoint.",
      releaseListenerOwnership(),
    );
  }
  if (!isExactApprovedUrl(publicUrl, approvedDomain)) {
    closed = true;
    clearReconnectTimer();
    subscribers.clear();
    throw new NgrokEndpointError(
      "ngrok_domain_mismatch",
      "ngrok returned an unexpected public endpoint.",
      releaseListenerOwnership(),
    );
  }

  return {
    url: publicUrl as string,
    snapshot: () => status.current,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    async close() {
      if (closed) {
        return closePromise ?? Promise.resolve();
      }
      closed = true;
      clearReconnectTimer();
      subscribers.clear();
      await closeListener();
    },
  };
}

async function loadDefaultNgrokAdapter(): Promise<NgrokAdapter> {
  const ngrok = await loadDefaultNgrokRuntime();
  return {
    async forward(options) {
      return ngrok.forward(options);
    },
  };
}

export async function assertDefaultNgrokRuntimeAvailable(): Promise<void> {
  await loadDefaultNgrokRuntime();
}

async function loadDefaultNgrokRuntime(): Promise<{
  forward(options: NgrokForwardOptions): Promise<NgrokListener>;
}> {
  const ngrok = await import("@ngrok/ngrok");
  if (typeof ngrok.forward !== "function") {
    throw new Error("The packaged ngrok runtime is unavailable.");
  }
  return ngrok;
}

function withStartupTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onLateResult: (result: T) => void | Promise<void>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let resolveOwnershipRelease: (released: boolean) => void = () => undefined;
    const pendingOwnershipRelease = new Promise<boolean>((release) => {
      resolveOwnershipRelease = release;
    });
    const timer = setTimeout(() => {
      settled = true;
      reject(new NgrokStartupTimeoutError(pendingOwnershipRelease));
    }, timeoutMs);
    timer.unref?.();
    void operation.then(
      (result) => {
        if (settled) {
          void Promise.resolve(onLateResult(result)).then(
            () => resolveOwnershipRelease(true),
            () => resolveOwnershipRelease(false),
          );
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) {
          resolveOwnershipRelease(true);
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class NgrokStartupTimeoutError extends Error {
  readonly pendingOwnershipRelease: Promise<boolean>;

  constructor(pendingOwnershipRelease: Promise<boolean>) {
    super("ngrok startup timed out.");
    this.pendingOwnershipRelease = pendingOwnershipRelease;
  }
}

function validateDomain(value: string): string {
  const domain = value.trim().toLocaleLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) {
    throw new Error("The approved ngrok domain is invalid.");
  }
  return domain;
}

function isExactApprovedUrl(
  value: string | null,
  approvedDomain: string,
): boolean {
  if (value === null) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === approvedDomain &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function requireValue(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty.`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}
