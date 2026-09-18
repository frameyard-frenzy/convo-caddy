import { relocateWorkspace } from "./workspace-relocation.js";
import { recoverWorkspaceMove } from "../server/desktop/workspace-move.js";
import { startConnectivitySupervisor } from "../server/connectivity/connectivity-supervisor.js";
import { assertDefaultNgrokRuntimeAvailable } from "../server/connectivity/ngrok-endpoint-manager.js";
import { buildDesktopConfig } from "../server/desktop/config.js";
import {
  ConnectionStorage,
  type ConnectionStorageStatus,
} from "../server/desktop/connection-storage.js";
import { MacosKeychainSecretStore } from "../server/desktop/macos-keychain-secret-store.js";
import type { DesktopPaths } from "../server/desktop/paths.js";
import {
  createDesktopPreferences,
  loadDesktopPreferences,
  selectWorkspaceRoot,
} from "../server/desktop/preferences.js";
import { startServerRuntime } from "../server/runtime.js";
import type { LocalApiAccess } from "../server/security/local-api-access.js";
import { createProductionSessionResources } from "../server/session-resources.js";
import type { DesktopRuntimePort } from "./application.js";
import { classifyQuitRisk } from "./application.js";
import { DesktopStartupError } from "./application.js";
import type { WorkspaceDialogPort } from "./workspace-dialog.js";
import {
  startDesktopSetupRuntime,
  type SetupConnectionStoragePort,
} from "./setup-runtime.js";

type DesktopConnectionStoragePort = SetupConnectionStoragePort & {
  loadActiveAuthority(): ReturnType<ConnectionStorage["loadActiveAuthority"]>;
};

export async function startOwnedDesktopRuntime(options: {
  paths: DesktopPaths;
  clientDirectory: string;
  localApiAccess: LocalApiAccess;
  workspaceDialog?: WorkspaceDialogPort;
  forceSetup?: boolean;
  requestReload(): Promise<"blocked" | "reloaded">;
  connectionStorage?: DesktopConnectionStoragePort;
  verifyNgrokRuntime?: () => Promise<void>;
}): Promise<DesktopRuntimePort> {
  const connectionStorage =
    options.connectionStorage ??
    new ConnectionStorage({
      paths: options.paths,
      secretStore: new MacosKeychainSecretStore(),
    });
  let connectionStatus: ConnectionStorageStatus;
  try {
    connectionStatus = await connectionStorage.initialize();
  } catch {
    throw new DesktopStartupError("needs_attention");
  }
  if (options.forceSetup || connectionStatus.kind !== "ready") {
    return startDesktopSetupRuntime({
      localApiAccess: options.localApiAccess,
      storage: connectionStorage,
      initialStatus: connectionStatus,
      requestReload: options.requestReload,
    });
  }

  const authority = await connectionStorage.loadActiveAuthority();
  if (authority === null) {
    return startDesktopSetupRuntime({
      localApiAccess: options.localApiAccess,
      storage: connectionStorage,
      initialStatus: { ...connectionStatus, kind: "setup_required" },
      requestReload: options.requestReload,
    });
  }
  const desktopConfig = buildDesktopConfig(authority);
  createDesktopPreferences(options.paths);
  try {
    recoverWorkspaceMove(options.paths);
  } catch (error) {
    await options.workspaceDialog?.showError?.(
      `Workspace recovery stopped. Keep both workspace folders. ${error instanceof Error ? error.message : "The move could not be verified."}`,
    );
    throw error;
  }
  const selectedWorkspace = loadDesktopPreferences(options.paths).workspaceRoot;
  const activeCheckpointExists = existsSync(
    `${options.paths.applicationRoot}/active-session.json`,
  );
  if (
    !selectedWorkspace ||
    (!existsSync(selectedWorkspace) && !activeCheckpointExists)
  ) {
    if (!options.workspaceDialog)
      throw new DesktopStartupError("needs_attention");
    const selected = await options.workspaceDialog.chooseWorkspace({
      title: selectedWorkspace
        ? "Your workspace is unavailable — choose a parent for its replacement"
        : "Choose a parent for your Convo Caddy workspace",
      buttonLabel: "Create Workspace Here",
    });
    if (!selected) throw new DesktopStartupError("needs_attention");
    try {
      selectWorkspaceRoot(options.paths, selected);
    } catch (error) {
      await options.workspaceDialog.showError?.(
        error instanceof Error
          ? error.message
          : "Choose a writable parent folder outside private app state.",
      );
      throw error;
    }
  }
  try {
    await (options.verifyNgrokRuntime ?? assertDefaultNgrokRuntimeAvailable)();
  } catch {
    throw new DesktopStartupError("needs_attention");
  }
  const resources = createProductionSessionResources({
    paths: options.paths,
    desktopConfig,
  });

  const connectivityConfig = resources.connectivity;
  let runtimeStartAttempted = false;
  try {
    runtimeStartAttempted = true;
    const runtime = await startServerRuntime({
      client: { kind: "production", directory: options.clientDirectory },
      config: resources.config,
      session: {
        service: resources.service,
      },
      localApiAccess: options.localApiAccess,
      choosePrep: options.workspaceDialog?.choosePrep,
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
    });
    return {
      mode: "normal",
      applicationUrl: runtime.application.url,
      getQuitRisk: () => classifyQuitRisk(resources.service.getSnapshot()),
      moveWorkspace: async () => {
        if (!options.workspaceDialog)
          throw new Error("Workspace dialog unavailable.");
        await relocateWorkspace(
          options.paths,
          resources.service,
          options.workspaceDialog,
        );
      },
      close: runtime.close,
    };
  } catch (error) {
    if (!runtimeStartAttempted) {
      resources.service.close();
    }
    if (error instanceof DesktopStartupError) {
      throw error;
    }
    throw new DesktopStartupError("needs_attention");
  }
}
import { existsSync } from "node:fs";
