import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  deliverClosed: () => {},
  deferred: false,
  response: 2,
  veto: false,
  closed: false,
  scripts: [] as string[],
  event: { preventDefault: vi.fn() },
  dialog: vi.fn(),
}));
vi.mock("electron", () => ({
  dialog: { showMessageBox: native.dialog, showOpenDialog: vi.fn() },
  session: {},
  BrowserWindow: class extends EventEmitter {
    contents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => {},
      getURL: () => "http://127.0.0.1:4999/",
      isDestroyed: () => native.closed,
      executeJavaScript: async (script: string) => {
        native.scripts.push(script);
        return script.includes('"status"') ? "dirty" : "ready";
      },
    });
    get webContents() {
      if (native.closed) throw Error("Object has been destroyed");
      return this.contents;
    }
    async loadURL() {}
    show() {}
    isDestroyed() {
      return native.closed;
    }
    close() {
      if (native.veto)
        this.webContents.emit("will-prevent-unload", native.event);
      else {
        native.closed = true;
        native.deliverClosed = () => {
          this.emit("closed");
        };
        if (!native.deferred) native.deliverClosed();
      }
    }
  },
}));

import { startDesktopApplication } from "../../src/desktop/application.js";
import { createElectronWindow } from "../../src/desktop/electron-adapters.js";
import { NavigationPolicy } from "../../src/desktop/window-security.js";
import { LocalApiAccess } from "../../src/server/security/local-api-access.js";

it("production native adapter offers safe-default Save/Discard/Cancel and never overrides an unrelated veto", async () => {
  native.dialog.mockImplementation(async () => ({ response: native.response }));
  const policy = new NavigationPolicy();
  policy.allow("http://127.0.0.1:4999");
  const window = createElectronWindow({
    partition: "synthetic",
    navigationPolicy: policy,
  });
  expect(await window.closeForQuit(async () => true)).toBe(false);
  expect(native.closed).toBe(false);
  expect(native.dialog).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      buttons: ["Save", "Discard", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    }),
  );
  native.response = 0;
  native.veto = true;
  expect(await window.closeForQuit(async () => true)).toBe(false);
  expect(native.scripts.some((x) => x.includes('"save"'))).toBe(true);
  expect(native.event.preventDefault).not.toHaveBeenCalled();
  expect(native.closed).toBe(false);
  native.response = 1;
  native.veto = false;
  expect(await window.closeForQuit(async () => true)).toBe(true);
  expect(native.scripts.some((x) => x.includes('"discard"'))).toBe(true);
});

beforeEach(() => {
  native.closed = false;
  native.veto = false;
  native.deferred = false;
  native.response = 2;
  native.scripts = [];
  vi.clearAllMocks();
  native.dialog.mockImplementation(async () => ({ response: native.response }));
});

it("asynchronous native closed settles after window destruction before controller drains runtime", async () => {
  native.response = 1;
  native.deferred = true;
  const drain = vi.fn(async () => {}),
    quit = vi.fn();
  const controller = await startDesktopApplication({
    app: {
      requestSingleInstanceLock: () => true,
      enableSandbox() {},
      whenReady: async () => {},
      quit,
      onSecondInstance() {},
      onActivate() {},
      onBeforeQuit() {},
    },
    localApiAccess: new LocalApiAccess(),
    createBootstrap: async () => ({
      url: "http://127.0.0.1:4999",
      update() {},
      close: async () => {},
    }),
    createBrowserSession: () => ({
      setCookie: async () => {},
      clear: async () => {},
    }),
    createWindow: createElectronWindow,
    startRuntime: async () => ({
      mode: "normal",
      applicationUrl: "http://127.0.0.1:4999",
      getQuitRisk: () => null,
      close: drain,
    }),
    confirmForceQuit: async () => false,
  });
  if (!controller) throw Error("Missing synthetic controller");
  await controller.startupSettled;
  const result = controller.requestQuit();
  await vi.waitFor(() => expect(native.closed).toBe(true));
  expect(drain).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
  expect(() => native.deliverClosed()).not.toThrow();
  expect(await result).toBe("quit");
  native.deliverClosed();
  expect(drain).toHaveBeenCalledOnce();
  expect(quit).toHaveBeenCalledOnce();
});
