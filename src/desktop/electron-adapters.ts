import { BrowserWindow, dialog, type Input, session } from "electron";
import type {
  DesktopBrowserSessionPort,
  DesktopWindowPort,
} from "./application.js";
import { closeWindowForQuit } from "./close-window.js";
import {
  createSecureWindowOptions,
  isBlockedWindowAccelerator,
  type NavigationPolicy,
} from "./window-security.js";
import { createWorkspaceDialogPort } from "./workspace-dialog.js";

export function createElectronBrowserSession(
  partition: string,
): DesktopBrowserSessionPort {
  const browserSession = session.fromPartition(partition, { cache: false });
  secureBrowserSession(browserSession);
  return {
    setCookie: (cookie) => browserSession.cookies.set(cookie),
    clear: async () => {
      await browserSession.clearStorageData();
      await browserSession.clearCache();
    },
  };
}

export function createElectronWindow(input: {
  partition: string;
  navigationPolicy: NavigationPolicy;
}): DesktopWindowPort {
  const window = new BrowserWindow(createSecureWindowOptions(input.partition));
  // Electron destroys the BrowserWindow wrapper before emitting closed.
  // Retain the live contents reference; never reacquire it during cleanup.
  const contents = window.webContents;
  let generation = 0;
  contents.on("did-start-navigation", () => {
    generation++;
  });
  contents.setWindowOpenHandler(() => input.navigationPolicy.openWindow());
  contents.on("will-navigate", (event, url) => {
    if (!input.navigationPolicy.allows(url)) {
      event.preventDefault();
    }
  });
  contents.on("will-redirect", (event, url) => {
    if (!input.navigationPolicy.allows(url)) {
      event.preventDefault();
    }
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("before-input-event", (event, accelerator) => {
    if (isBlockedWindowAccelerator(normalizeInput(accelerator))) {
      event.preventDefault();
    }
  });

  return {
    workspaceDialog: createWorkspaceDialogPort(window, {
      showOpenDialog: (owner, options) =>
        dialog.showOpenDialog(owner as BrowserWindow, options),
    }),
    loadURL: (url) => window.loadURL(url).then(() => undefined),
    show: () => window.show(),
    focus: () => window.focus(),
    restore: () => window.restore(),
    isDestroyed: () => window.isDestroyed(),
    isMinimized: () => window.isMinimized(),
    onClose: (listener) => {
      window.on("close", listener);
    },
    destroy: () => window.destroy(),
    closeForQuit: (approveClose) =>
      window.isDestroyed()
        ? Promise.resolve(true)
        : closeWindowForQuit(
            {
              url: () => contents.getURL(),
              generation: () => generation,
              evaluate: (script) => contents.executeJavaScript(script),
              choose: async () => {
                const result = await dialog.showMessageBox(window, {
                  type: "question",
                  message: "Save changes before quitting?",
                  detail:
                    "Save keeps your latest edits. Discard closes without saving the remaining draft.",
                  buttons: ["Save", "Discard", "Cancel"],
                  defaultId: 0,
                  cancelId: 2,
                  noLink: true,
                });
                return (
                  (["save", "discard", "cancel"] as const)[result.response] ??
                  "cancel"
                );
              },
              report: async (message) => {
                await dialog.showMessageBox(window, {
                  type: "warning",
                  message,
                  buttons: ["Keep Open"],
                  noLink: true,
                });
              },
              close: () => window.close(),
              onClosed: (listener) => {
                window.once("closed", listener);
                return () => {
                  window.removeListener("closed", listener);
                };
              },
              onVeto: (listener) => {
                contents.once("will-prevent-unload", listener);
                return () => {
                  if (!contents.isDestroyed())
                    contents.removeListener("will-prevent-unload", listener);
                };
              },
            },
            input.navigationPolicy,
            approveClose,
          ),
  };
}

export interface SecureElectronSessionPort {
  setPermissionCheckHandler(handler: () => boolean): void;
  setPermissionRequestHandler(
    handler: (
      contents: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
    ) => void,
  ): void;
  on(
    event: "will-download",
    listener: (event: { preventDefault(): void }) => void,
  ): void;
}

export function secureBrowserSession(
  browserSession: SecureElectronSessionPort,
): void {
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => {
      callback(false);
    },
  );
  browserSession.on("will-download", (event) => event.preventDefault());
}

function normalizeInput(input: Input): {
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
} {
  return {
    key: input.key,
    control: input.control,
    meta: input.meta,
    alt: input.alt,
    shift: input.shift,
  };
}
