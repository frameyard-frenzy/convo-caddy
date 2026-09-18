import type { Server } from "node:http";
import type { ServerConfig } from "./config.js";

export type LoopbackHost = ServerConfig["host"];

export type ListenerAddress = {
  host: LoopbackHost;
  port: number;
  url: string;
};

const DEFAULT_DRAIN_TIMEOUT_MS = 1_000;

export async function listenOnLoopback(
  server: Server,
  port: number,
  host: LoopbackHost,
): Promise<ListenerAddress> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("The HTTP server did not expose a TCP listener address.");
  }

  return {
    host,
    port: address.port,
    url: `http://${formatUrlHost(host)}:${address.port}`,
  };
}

export function closeHttpServer(
  server: Server | null,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
): Promise<void> {
  if (!server?.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const forceClose = setTimeout(() => {
      server.closeAllConnections();
    }, drainTimeoutMs);
    forceClose.unref();

    server.close((error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(forceClose);
      error ? reject(error) : resolve();
    });
  });
}

function formatUrlHost(host: LoopbackHost): string {
  return host === "::1" ? `[${host}]` : host;
}
