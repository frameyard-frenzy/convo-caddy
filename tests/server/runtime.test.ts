import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../src/server/config.js";
import type { ConnectivitySupervisor } from "../../src/server/connectivity/connectivity-supervisor.js";
import { RuntimeReadinessStore } from "../../src/server/connectivity/readiness.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { startServerRuntime } from "../../src/server/runtime.js";
import {
  LOCAL_API_COOKIE_NAME,
  LocalApiAccess,
} from "../../src/server/security/local-api-access.js";
import { closeHttpServer } from "../../src/server/server-lifecycle.js";
import { createDevelopmentSessionService } from "../../src/server/session-service.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("server runtime", () => {
  it("returns the loopback ports assigned to both owned listeners", async () => {
    const runtime = await startServerRuntime({
      client: createProductionClient(),
      config: createConfig({ capture: createRecallConfig(0), port: 0 }),
      session: createRuntimeSession(),
    });

    try {
      expect(runtime.application).toMatchObject({
        host: "127.0.0.1",
        url: `http://127.0.0.1:${runtime.application.port}`,
      });
      expect(runtime.application.port).toBeGreaterThan(0);
      expect(runtime.webhook).toMatchObject({
        host: "127.0.0.1",
        url: `http://127.0.0.1:${runtime.webhook?.port}`,
      });
      expect(runtime.webhook?.port).toBeGreaterThan(0);

      const health = await fetch(`${runtime.application.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const client = await fetch(runtime.application.url);
      expect(client.status).toBe(200);
      expect(await client.text()).toContain("<title>Test</title>");
    } finally {
      await runtime.close();
    }
  });

  it("does not leave an application listener when webhook startup fails", async () => {
    const blockedWebhook = await occupyLoopbackPort();
    const applicationPort = await findAvailablePort();

    try {
      await expect(
        startServerRuntime({
          client: createProductionClient(),
          config: createConfig({
            capture: createRecallConfig(blockedWebhook.port),
            port: applicationPort,
          }),
          session: createRuntimeSession(),
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      await expectPortCanBind(applicationPort);
    } finally {
      await closeServer(blockedWebhook.server);
    }
  });

  it("closes the webhook listener when application startup fails", async () => {
    const blockedApplication = await occupyLoopbackPort();
    const webhookPort = await findAvailablePort();

    try {
      await expect(
        startServerRuntime({
          client: createProductionClient(),
          config: createConfig({
            capture: createRecallConfig(webhookPort),
            port: blockedApplication.port,
          }),
          session: createRuntimeSession(),
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      await expectPortCanBind(webhookPort);
    } finally {
      await closeServer(blockedApplication.server);
    }
  });

  it("makes repeated and concurrent close calls safe", async () => {
    const release = vi.fn();
    const runtime = await startServerRuntime({
      client: createProductionClient(),
      config: createConfig(),
      session: { ...createRuntimeSession(), release },
    });

    await Promise.all([runtime.close(), runtime.close()]);
    await expect(runtime.close()).resolves.toBeUndefined();
    await expectPortCanBind(runtime.application.port);
    expect(release).toHaveBeenCalledOnce();
  });

  it("drains delivery work before closing the session and releasing workspace ownership", async () => {
    const events: string[] = [];
    const session = createRuntimeSession();
    vi.spyOn(session.service, "close").mockImplementation(() => {
      events.push("service");
    });
    const runtime = await startServerRuntime({
      client: createProductionClient(),
      config: createConfig(),
      session: {
        ...session,
        beforeClose: async () => {
          events.push("delivery");
        },
        release: () => {
          events.push("workspace");
        },
      },
    });

    await runtime.close();
    expect(events).toEqual(["delivery", "service", "workspace"]);
  });

  it("allows cleanup retry after a transient release failure", async () => {
    const release = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error("release failed");
      })
      .mockImplementationOnce(() => undefined);
    const runtime = await startServerRuntime({
      client: createProductionClient(),
      config: createConfig(),
      session: { ...createRuntimeSession(), release },
    });

    await expect(runtime.close()).rejects.toThrow(
      "Convo Caddy runtime shutdown failed",
    );
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("releases session ownership when application construction fails", async () => {
    const access = new LocalApiAccess("f".repeat(43));
    vi.spyOn(access, "hostMiddleware").mockImplementation(() => {
      throw new Error("application construction failed");
    });
    const session = createRuntimeSession();
    const close = vi.spyOn(session.service, "close");
    const release = vi.fn();

    await expect(
      startServerRuntime({
        client: createProductionClient(),
        config: createConfig(),
        session: { ...session, release },
        localApiAccess: access,
      }),
    ).rejects.toThrow("application construction failed");
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("closes acquired connectivity when later startup publication fails", async () => {
    const access = new LocalApiAccess("g".repeat(43));
    vi.spyOn(access, "bindOrigin").mockImplementation(() => {
      throw new Error("origin publication failed");
    });
    const connectivity = fakeConnectivitySupervisor();

    await expect(
      startServerRuntime({
        client: createProductionClient(),
        config: createConfig(),
        session: createRuntimeSession(),
        connectivity: { start: () => connectivity },
        localApiAccess: access,
      }),
    ).rejects.toThrow("origin publication failed");
    expect(connectivity.close).toHaveBeenCalledOnce();
  });

  it("owns and closes the injected connectivity supervisor with the server runtime", async () => {
    const connectivity = fakeConnectivitySupervisor();
    const runtime = await startServerRuntime({
      client: createProductionClient(),
      config: createConfig(),
      session: createRuntimeSession(),
      connectivity: {
        start: () => connectivity,
      },
    });

    expect(runtime.readiness).toBe(connectivity.readiness);
    await runtime.connectivitySettled;
    await runtime.close();
    expect(connectivity.close).toHaveBeenCalledOnce();
  });

  it("exposes current readiness only through authenticated desktop API access", async () => {
    const connectivity = fakeConnectivitySupervisor();
    const access = new LocalApiAccess("c".repeat(43));
    const runtime = await startServerRuntime({
      client: createProductionClient(),
      config: createConfig(),
      session: createRuntimeSession(),
      connectivity: { start: () => connectivity },
      localApiAccess: access,
    });

    try {
      await expect(
        fetch(`${runtime.application.url}/api/runtime/readiness`),
      ).resolves.toMatchObject({ status: 401 });
      const response = await fetch(
        `${runtime.application.url}/api/runtime/readiness`,
        {
          headers: {
            Cookie: `${LOCAL_API_COOKIE_NAME}=${access.createElectronCookie().value}`,
          },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        readiness: connectivity.readiness.snapshot(),
        workspaceRoot: null,
      });
    } finally {
      await runtime.close();
    }
  });

  it("keeps the public webhook listener isolated from authenticated app routes", async () => {
    const access = new LocalApiAccess("d".repeat(43));
    const runtime = await startServerRuntime({
      client: createProductionClient(),
      config: createConfig({ capture: createRecallConfig(0) }),
      session: createRuntimeSession(),
      localApiAccess: access,
    });

    try {
      if (!runtime.webhook) {
        throw new Error("Expected a dedicated webhook listener.");
      }
      const cookie = `${LOCAL_API_COOKIE_NAME}=${access.createElectronCookie().value}`;
      const response = await fetch(`${runtime.webhook.url}/api/session`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it("rolls back both listeners when connectivity ownership cannot start", async () => {
    const applicationPort = await findAvailablePort();
    const webhookPort = await findAvailablePort();

    await expect(
      startServerRuntime({
        client: createProductionClient(),
        config: createConfig({
          capture: createRecallConfig(webhookPort),
          port: applicationPort,
        }),
        session: createRuntimeSession(),
        connectivity: {
          start: ({ application, webhook }) => {
            expect(application.port).toBe(applicationPort);
            expect(webhook?.port).toBe(webhookPort);
            throw new Error("connectivity start failed");
          },
        },
      }),
    ).rejects.toThrow("connectivity start failed");

    await expectPortCanBind(applicationPort);
    await expectPortCanBind(webhookPort);
  });

  it("releases injected session ownership when startup fails", async () => {
    const release = vi.fn();
    await expect(
      startServerRuntime({
        client: { kind: "production", directory: "dist/client" },
        config: createConfig(),
        session: { ...createRuntimeSession(), release },
      }),
    ).rejects.toThrow("Production client directory must be absolute.");

    expect(release).toHaveBeenCalledOnce();
  });

  it("does not let an active SSE client hold shutdown open", async () => {
    const runtime = await startServerRuntime({
      client: createProductionClient(),
      config: createConfig(),
      session: createRuntimeSession(),
    });
    const response = await fetch(`${runtime.application.url}/api/events`);
    const reader = response.body?.getReader();
    await reader?.read();

    const outcome = await Promise.race([
      runtime.close().then(() => "closed"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 2_000),
      ),
    ]);

    expect(outcome).toBe("closed");
    await expectPortCanBind(runtime.application.port);
  });

  it("lets an ordinary request finish during the bounded drain", async () => {
    const releaseResponse = deferred<void>();
    const observed = deferred<void>();
    const server = createServer(async (_request, response) => {
      observed.resolve();
      await releaseResponse.promise;
      response.end("finished");
    });
    await listen(server, 0);

    const responsePromise = fetch(`http://127.0.0.1:${getPort(server)}`);
    await observed.promise;
    const closePromise = closeHttpServer(server, 1_000);
    releaseResponse.resolve();

    expect(await (await responsePromise).text()).toBe("finished");
    await expect(closePromise).resolves.toBeUndefined();
  });

  it("forces a stuck connection closed after the bounded drain", async () => {
    const observed = deferred<void>();
    const server = createServer((_request, _response) => {
      observed.resolve();
    });
    await listen(server, 0);

    const responsePromise = fetch(`http://127.0.0.1:${getPort(server)}`);
    await observed.promise;
    const startedAt = performance.now();
    await closeHttpServer(server, 50);

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(40);
    await expect(responsePromise).rejects.toThrow();
  });

  it("requires an explicit production client directory with built assets", async () => {
    await expect(
      startServerRuntime({
        client: { kind: "production", directory: "dist/client" },
        config: createConfig(),
        session: createRuntimeSession(),
      }),
    ).rejects.toThrow("Production client directory must be absolute.");

    const missingDirectory = path.join(createTemporaryDirectory(), "missing");

    await expect(
      startServerRuntime({
        client: { kind: "production", directory: missingDirectory },
        config: createConfig(),
        session: createRuntimeSession(),
      }),
    ).rejects.toThrow(
      `Production client assets are missing from ${missingDirectory}`,
    );

    const emptyDirectory = path.join(createTemporaryDirectory(), "empty");
    mkdirSync(emptyDirectory);
    await expect(
      startServerRuntime({
        client: { kind: "production", directory: emptyDirectory },
        config: createConfig(),
        session: createRuntimeSession(),
      }),
    ).rejects.toThrow(
      `Production client assets are missing from ${emptyDirectory}`,
    );
  });

  it("rejects an injected non-loopback host before binding", async () => {
    await expect(
      startServerRuntime({
        client: createProductionClient(),
        config: createConfig({
          host: "0.0.0.0" as ServerConfig["host"],
        }),
        session: createRuntimeSession(),
      }),
    ).rejects.toThrow("The application server must bind to a loopback host.");
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    capture: { kind: "unavailable" },
    host: "127.0.0.1",
    marty: { kind: "unavailable" },
    port: 0,
    testMode: false,
    ...overrides,
  };
}

function fakeConnectivitySupervisor(): ConnectivitySupervisor & {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    retryHermes: async () => undefined,
    readiness: new RuntimeReadinessStore({
      configuration: "ready",
      workspace: "ready",
      appServer: "ready",
      webhookServer: "ready",
      ngrok: "ready",
      hermesTunnel: "reused",
      hermes: "ready",
      capture: "ready",
    }),
    settled: Promise.resolve(),
    close: vi.fn(async () => undefined),
  };
}

function createRecallConfig(
  port: number,
): Extract<ServerConfig["capture"], { kind: "recall" }> {
  return {
    kind: "recall",
    region: "us-west-2",
    apiKey: "runtime-test-recall-key",
    webhookUrl:
      "https://interviews.example.ngrok-free.dev/api/capture/recall/webhook",
    verificationSecret: "whsec_cnVudGltZS10ZXN0LXNlY3JldA==",
    host: "127.0.0.1",
    port,
    timeoutMs: 1_000,
  };
}

function createProductionClient(): {
  kind: "production";
  directory: string;
} {
  const directory = path.join(createTemporaryDirectory(), "client");
  mkdirSync(directory);
  writeFileSync(
    path.join(directory, "index.html"),
    "<!doctype html><title>Test</title>",
  );
  return { kind: "production", directory };
}

function createDataRoot(): string {
  return path.join(createTemporaryDirectory(), "sessions");
}

function createRuntimeSession(): {
  service: ReturnType<typeof createDevelopmentSessionService>;
} {
  return {
    service: createDevelopmentSessionService({
      repository: new FileSessionRepository(createDataRoot()),
    }),
  };
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "convo-caddy-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function occupyLoopbackPort(): Promise<{
  port: number;
  server: Server;
}> {
  const server = createServer();
  await listen(server, 0);
  return { port: getPort(server), server };
}

async function findAvailablePort(): Promise<number> {
  const occupied = await occupyLoopbackPort();
  await closeServer(occupied.server);
  return occupied.port;
}

async function expectPortCanBind(port: number): Promise<void> {
  const server = createServer();
  try {
    await listen(server, port);
  } finally {
    await closeServer(server);
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function getPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address.");
  }
  return address.port;
}
