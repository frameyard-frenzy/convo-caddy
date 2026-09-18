import path from "node:path";
import { app, dialog } from "electron";
import { resolveDesktopPaths } from "../server/desktop/paths.js";
import {
  assertManagedPathHasNoSymlinks,
  ensurePrivateDirectory,
} from "../server/persistence/atomic-write.js";
import { LocalApiAccess } from "../server/security/local-api-access.js";
import {
  type DesktopAppPort,
  type QuitRisk,
  startDesktopApplication,
} from "./application.js";
import { startDesktopBootstrapServer } from "./bootstrap-server.js";
import {
  createElectronBrowserSession,
  createElectronWindow,
} from "./electron-adapters.js";
import { createDesktopLogger } from "./logging.js";
import { installDesktopMenu } from "./menu.js";
import { acquireMaintenanceLock } from "./maintenance-lock.js";
import { startOwnedDesktopRuntime } from "./runtime-owner.js";

// This is intentionally the first filesystem mutation in normal startup. The
// descriptor remains in this Electron MAIN process, independent of helpers.
const maintenanceLock = acquireMaintenanceLock();
app.setName("Convo Caddy");
const paths = resolveDesktopPaths();
ensurePrivateDirectory(paths.applicationRoot);
assertManagedPathHasNoSymlinks(paths.electronDirectory, paths.applicationRoot);
ensurePrivateDirectory(paths.electronDirectory);
ensurePrivateDirectory(paths.logsDirectory);
app.setPath("userData", paths.electronDirectory);
app.setAppLogsPath(paths.logsDirectory);

const logger = createDesktopLogger(paths.logsDirectory);
process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", error);
});
process.on("unhandledRejection", (error) => {
  logger.error("unhandled_rejection", error);
});
const localApiAccess = new LocalApiAccess();
void launchDesktopMain();

async function launchDesktopMain(): Promise<void> {
  try {
    const controller = await startDesktopApplication({
      app: electronAppPort(),
      localApiAccess,
      createBootstrap: startDesktopBootstrapServer,
      createBrowserSession: createElectronBrowserSession,
      createWindow: createElectronWindow,
      startRuntime: (window, lifecycle) => {
        if (!window.workspaceDialog) {
          throw new Error("Desktop workspace dialog is unavailable.");
        }
        return startOwnedDesktopRuntime({
          paths,
          clientDirectory: path.join(app.getAppPath(), "dist", "client"),
          localApiAccess,
          workspaceDialog: window.workspaceDialog,
          forceSetup: lifecycle.mode === "setup",
          requestReload: lifecycle.requestReload,
        });
      },
      confirmForceQuit,
      releaseMaintenanceLock: () => maintenanceLock.release(),
      reportStartupFailure: (kind) =>
        logger.error(
          `desktop_startup_${kind}`,
          new Error("DesktopStartupError"),
        ),
      reportLifecycleFailure: (operation, error) =>
        logger.error(`desktop_${operation}_failed`, error),
      reportRuntimeReady: (mode) =>
        logger.info(`desktop_runtime_${mode}_ready`),
      reportSecondInstanceFocus: () =>
        logger.info("desktop_second_instance_focused"),
    });

    if (controller) {
      installDesktopMenu({ controller, paths, logger });
      logger.info("desktop_started");
    }
  } catch (error) {
    logger.error("desktop_main_failed", error);
    maintenanceLock.release();
    app.quit();
  }
}

function electronAppPort(): DesktopAppPort {
  return {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    enableSandbox: () => app.enableSandbox(),
    whenReady: () => app.whenReady(),
    quit: () => app.quit(),
    onSecondInstance: (listener) => {
      app.on("second-instance", listener);
    },
    onActivate: (listener) => {
      app.on("activate", listener);
    },
    onBeforeQuit: (listener) => {
      app.on("before-quit", listener);
    },
  };
}

async function confirmForceQuit(risk: QuitRisk): Promise<boolean> {
  const copy = {
    active_interview: {
      message: "Keep Convo Caddy open during the interview?",
      detail:
        "Quitting now can interrupt capture. Convo Caddy will not remove the meeting bot or change Hermes when it quits.",
    },
    finalizing: {
      message: "Keep Convo Caddy open while it saves?",
      detail:
        "Recall is still finishing this interview. Quitting now can leave it needing recovery on the next launch.",
    },
    needs_attention: {
      message: "This interview still needs attention.",
      detail:
        "Quitting will preserve the local recovery state, but it will not resolve or remove the meeting bot.",
    },
  }[risk];
  const result = await dialog.showMessageBox({
    type: "warning",
    message: copy.message,
    detail: copy.detail,
    buttons: ["Keep Convo Caddy Running", "Quit Anyway"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}
