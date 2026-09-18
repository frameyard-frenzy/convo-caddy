import {
  createConfiguredCaptureProvider,
  createConfiguredMartyProvider,
  loadServerConfig,
  type ServerConfig,
} from "./config.js";
import type { ConnectivityConfig } from "./connectivity/connectivity-supervisor.js";
import type { DesktopConfig } from "./desktop/config.js";
import { type DesktopPaths, resolveDesktopPaths } from "./desktop/paths.js";
import {
  createDesktopPreferences,
  loadDesktopPreferences,
} from "./desktop/preferences.js";
import { FileSessionRepository } from "./persistence/file-session-repository.js";
import {
  createDevelopmentSessionService,
  createLiveSessionService,
  type SessionService,
} from "./session-service.js";
import { initializeUserWorkspace } from "./workspace/user-workspace.js";

export type SessionRuntimeResources = {
  config: ServerConfig;
  connectivity?: ConnectivityConfig;
  service: SessionService;
};

export function createDevelopmentSessionResources(options: {
  environment: NodeJS.ProcessEnv;
  dataRoot: string;
}): SessionRuntimeResources {
  const config = loadServerConfig(options.environment);
  return {
    config,
    service: createDevelopmentSessionService({
      provider: createConfiguredMartyProvider(config.marty),
      captureProvider: createConfiguredCaptureProvider(config.capture),
      repository: new FileSessionRepository(options.dataRoot),
    }),
  };
}

export function createProductionSessionResources(options: {
  paths?: DesktopPaths;
  desktopConfig: DesktopConfig;
}): SessionRuntimeResources {
  const paths = options.paths ?? resolveDesktopPaths();
  createDesktopPreferences(paths);
  const selected = loadDesktopPreferences(paths).workspaceRoot;
  const repository = new FileSessionRepository(paths.applicationRoot);
  const persisted = repository.load();
  const root = persisted?.workspace?.workspaceRoot ?? selected;
  if (!root)
    throw new Error("Choose a workspace folder before using Convo Caddy.");
  if (
    persisted?.workspace?.workspaceRoot &&
    selected !== persisted.workspace.workspaceRoot
  )
    throw new Error(
      "The active interview is bound to its original workspace. Make that workspace available again.",
    );
  initializeUserWorkspace(root);
  return {
    config: options.desktopConfig.server,
    connectivity: options.desktopConfig.connectivity,
    service: createLiveSessionService({
      provider: createConfiguredMartyProvider(
        options.desktopConfig.server.marty,
      ),
      captureProvider: createConfiguredCaptureProvider(
        options.desktopConfig.server.capture,
      ),
      repository,
      userWorkspaceRoot: root,
      recallCaptureAvailable: false,
    }),
  };
}
