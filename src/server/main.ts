import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type RuntimeClient,
  type ServerRuntime,
  startServerRuntime,
} from "./runtime.js";
import { createDevelopmentSessionResources } from "./session-resources.js";
import { startConnectivitySupervisor } from "./connectivity/connectivity-supervisor.js";

const resources = createDevelopmentSessionResources({
  environment: process.env,
  dataRoot: path.resolve(
    process.env.CONVO_CADDY_DATA_DIR?.trim() || "var/sessions",
  ),
});
const connectivityConfig = resources.connectivity;
let runtime: ServerRuntime | null = null;
let startupComplete: Promise<void> | null = null;
let shutdownStarted = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    void (startupComplete ?? Promise.resolve())
      .then(() => runtime?.close())
      .catch((error: unknown) => {
        console.error("Convo Caddy shutdown failed.", error);
        process.exitCode = 1;
      });
  });
}

startupComplete = startServerRuntime({
  client: resolveClient(),
  config: resources.config,
  session: { service: resources.service },
  ...(connectivityConfig
    ? {
        connectivity: {
          start: ({ webhook }) => {
            if (webhook?.host !== "127.0.0.1") {
              throw new Error(
                "Desktop connectivity requires the dedicated Recall webhook listener.",
              );
            }
            return startConnectivitySupervisor({
              config: connectivityConfig,
              webhook: { ...webhook, host: "127.0.0.1" },
              session: resources.service,
            });
          },
        },
      }
    : {}),
}).then((startedRuntime) => {
  runtime = startedRuntime;
});
await startupComplete;
const startedRuntime = runtime as ServerRuntime | null;
if (startedRuntime === null) {
  throw new Error("Convo Caddy runtime did not start.");
}
if (startedRuntime.webhook) {
  console.log(`Recall webhook listener on ${startedRuntime.webhook.url}`);
}
console.log(`Convo Caddy listening on ${startedRuntime.application.url}`);

function resolveClient(): RuntimeClient {
  if (process.env.NODE_ENV !== "production") {
    return { kind: "development" };
  }

  const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
  return {
    kind: "production",
    directory: path.resolve(rootDirectory, "../../dist/client"),
  };
}
