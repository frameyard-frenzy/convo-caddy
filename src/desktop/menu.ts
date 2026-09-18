import path from "node:path";
import { existsSync } from "node:fs";
import {
  Menu,
  app,
  dialog,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import type { DesktopApplicationController } from "./application.js";
import type { DesktopPaths } from "../server/desktop/paths.js";
import type { DesktopLogger } from "./logging.js";
import { assertManagedPathHasNoSymlinks } from "../server/persistence/atomic-write.js";
import { loadDesktopPreferences } from "../server/desktop/preferences.js";

export function installDesktopMenu(options: {
  controller: DesktopApplicationController;
  paths: DesktopPaths;
  logger: DesktopLogger;
}): void {
  const open = async (target: string, boundary: string, event: string) => {
    const fallback = nearestExistingDirectory(target);
    try {
      assertManagedPathHasNoSymlinks(fallback, boundary);
    } catch (error) {
      options.logger.error(event, error);
      await showOpenFailure();
      return;
    }
    const failure = await shell.openPath(fallback);
    if (failure) {
      options.logger.error(event, new Error("OpenPathError"));
      await showOpenFailure();
    }
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        {
          label: "Quit Convo Caddy",
          accelerator: "CmdOrCtrl+Q",
          click: () =>
            void options.controller
              .requestQuit()
              .catch((error) =>
                options.logger.error("desktop_quit_failed", error),
              ),
        },
      ],
    },
    {
      label: "Configuration",
      submenu: [
        {
          label: "Connection Settings…",
          click: () =>
            void options.controller
              .openConnectionSettings()
              .then((result) => {
                if (result === "blocked") {
                  return dialog.showMessageBox({
                    type: "warning",
                    message:
                      "Connection settings cannot open during an interview.",
                    detail:
                      "Finish capture and saving before changing Convo Caddy's connections.",
                  });
                }
              })
              .catch((error) =>
                options.logger.error("open_connection_settings_failed", error),
              ),
        },
      ],
    },
    {
      label: "Workspace",
      submenu: [
        {
          label: "Show Workspace in Finder",
          click: () =>
            void open(
              loadDesktopPreferences(options.paths).workspaceRoot ??
                options.paths.applicationRoot,
              loadDesktopPreferences(options.paths).workspaceRoot ??
                options.paths.applicationRoot,
              "open_workspace_failed",
            ),
        },
        {
          label: "Move workspace…",
          click: () =>
            void options.controller.moveWorkspace().catch(async (error) => {
              await dialog.showMessageBox({
                type: "error",
                message: "Workspace move needs attention",
                detail:
                  error instanceof Error
                    ? error.message
                    : "The workspace could not be moved.",
              });
            }),
        },
        {
          label: "Show Logs in Finder",
          click: () =>
            void open(
              options.paths.logsDirectory,
              options.paths.logsDirectory,
              "open_logs_failed",
            ),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showOpenFailure(): Promise<void> {
  await dialog.showMessageBox({
    type: "error",
    message: "That Convo Caddy location could not be opened.",
    detail: "Open the application logs for more information.",
  });
}

function nearestExistingDirectory(target: string): string {
  let current = path.resolve(target);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return target;
    }
    current = parent;
  }
  return current;
}
