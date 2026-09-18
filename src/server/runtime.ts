import { existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import express from "express";
import type { ViteDevServer } from "vite";
import { createApp } from "./app.js";
import { createRecallWebhookServer } from "./capture/recall/recall-webhook-server.js";
import type { ServerConfig } from "./config.js";
import type { ConnectivitySupervisor } from "./connectivity/connectivity-supervisor.js";
import type { RuntimeReadinessStore } from "./connectivity/readiness.js";
import type { LocalApiAccess } from "./security/local-api-access.js";
import {
  closeHttpServer,
  type ListenerAddress,
  listenOnLoopback,
} from "./server-lifecycle.js";
import type { SessionService } from "./session-service.js";

export type RuntimeClient =
  | { kind: "development" }
  | { kind: "production"; directory: string };

export type StartServerRuntimeOptions = {
  client: RuntimeClient;
  choosePrep?: (directory: string) => Promise<string | null>;
  config: ServerConfig;
  session: {
    service: SessionService;
    beforeClose?: () => void | Promise<void>;
    release?: () => void | Promise<void>;
  };
  connectivity?: {
    start(input: {
      application: ListenerAddress;
      webhook: ListenerAddress | null;
    }): ConnectivitySupervisor;
  };
  localApiAccess?: LocalApiAccess;
};

export type ServerRuntime = {
  application: ListenerAddress;
  webhook: ListenerAddress | null;
  readiness: RuntimeReadinessStore | null;
  connectivitySettled: Promise<void>;
  close(): Promise<void>;
};

type RuntimeResources = {
  applicationServer: Server | null;
  webhookServer: Server | null;
  vite: ViteDevServer | null;
  service: SessionService;
  beforeClose?: () => void | Promise<void>;
  release?: () => void | Promise<void>;
  connectivity: ConnectivitySupervisor | null;
};

export async function startServerRuntime(
  options: StartServerRuntimeOptions,
): Promise<ServerRuntime> {
  const service = options.session.service;
  let readiness: RuntimeReadinessStore | null = null;
  let applicationServer: Server | null = null;
  let webhookServer: Server | null = null;
  let vite: ViteDevServer | null = null;
  const resources: RuntimeResources = {
    applicationServer,
    webhookServer,
    vite,
    service,
    beforeClose: options.session.beforeClose,
    release: options.session.release,
    connectivity: null,
  };

  try {
    const app = createApp({
      exposeTestControls: options.config.testMode,
      allowViteInlineStyles: options.client.kind === "development",
      service,
      choosePrep: options.choosePrep,
      localApiAccess: options.localApiAccess,
      readiness: () => readiness?.snapshot() ?? null,
      retryHermes: async () => {
        await resources.connectivity?.retryHermes();
      },
    });
    applicationServer = createServer(app);
    resources.applicationServer = applicationServer;
    webhookServer =
      options.config.capture.kind === "recall"
        ? createRecallWebhookServer({
            service,
            verificationSecret: options.config.capture.verificationSecret,
          })
        : null;
    resources.webhookServer = webhookServer;
    validateRuntimeConfig(options.config);
    validateClient(options.client);
    vite = await attachClient(app, options.client);
    resources.vite = vite;

    const webhook =
      webhookServer && options.config.capture.kind === "recall"
        ? await listenOnLoopback(
            webhookServer,
            options.config.capture.port,
            options.config.capture.host,
          )
        : null;
    const application = await listenOnLoopback(
      applicationServer,
      options.config.port,
      options.config.host,
    );
    const connectivity = options.connectivity?.start({
      application,
      webhook,
    });
    resources.connectivity = connectivity ?? null;
    readiness = connectivity?.readiness ?? null;
    options.localApiAccess?.bindOrigin(application.url);
    const close = createIdempotentClose(resources);

    return {
      application,
      webhook,
      readiness,
      connectivitySettled: connectivity?.settled ?? Promise.resolve(),
      close,
    };
  } catch (startupError) {
    const rollbackErrors = await closeRuntimeResources(resources);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...rollbackErrors],
        "Convo Caddy startup failed and runtime rollback was incomplete.",
      );
    }
    throw startupError;
  }
}

async function attachClient(
  app: ReturnType<typeof createApp>,
  client: RuntimeClient,
): Promise<ViteDevServer | null> {
  if (client.kind === "development") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    return vite;
  }

  app.use(express.static(client.directory));
  app.get("*splat", (_request, response) => {
    response.sendFile(path.join(client.directory, "index.html"));
  });
  return null;
}

function validateClient(client: RuntimeClient): void {
  if (client.kind !== "production") {
    return;
  }

  if (!path.isAbsolute(client.directory)) {
    throw new Error("Production client directory must be absolute.");
  }

  const indexPath = path.join(client.directory, "index.html");
  if (!isFile(indexPath)) {
    throw new Error(
      `Production client assets are missing from ${client.directory}. Build the client and pass its directory explicitly.`,
    );
  }
}

function validateRuntimeConfig(config: ServerConfig): void {
  if (!isLoopbackHost(config.host)) {
    throw new Error("The application server must bind to a loopback host.");
  }
  if (config.capture.kind === "recall" && config.capture.host !== "127.0.0.1") {
    throw new Error("The Recall webhook server must bind to 127.0.0.1.");
  }
}

function isLoopbackHost(value: string): value is ServerConfig["host"] {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function isFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function createIdempotentClose(
  resources: RuntimeResources,
): () => Promise<void> {
  let closePromise: Promise<void> | null = null;
  let closed = false;
  return () => {
    if (closed) {
      return Promise.resolve();
    }
    closePromise ??= closeRuntimeResources(resources)
      .then((errors) => {
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            "Convo Caddy runtime shutdown failed.",
          );
        }
        closed = true;
      })
      .finally(() => {
        if (!closed) {
          closePromise = null;
        }
      });
    return closePromise;
  };
}

async function closeRuntimeResources(
  resources: RuntimeResources,
): Promise<unknown[]> {
  const errors: unknown[] = [];

  for (const close of [
    () => resources.connectivity?.close() ?? Promise.resolve(),
    () => closeHttpServer(resources.applicationServer),
    () => closeHttpServer(resources.webhookServer),
    () => resources.vite?.close() ?? Promise.resolve(),
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }

  let canRelease = true;
  try {
    await resources.beforeClose?.();
  } catch (error) {
    errors.push(error);
    canRelease = false;
  }

  try {
    resources.service.close();
  } catch (error) {
    errors.push(error);
  }

  if (canRelease) {
    try {
      await resources.release?.();
    } catch (error) {
      errors.push(error);
    }
  }

  return errors;
}
