import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import type { DesktopRuntimePort } from "../../src/desktop/application.js";
import { closeWindowForQuit } from "../../src/desktop/close-window.js";
import type { ConnectionStorage } from "../../src/server/desktop/connection-storage.js";

export const canaries = {
  "recall-api-key": "synthetic-recall-canary",
  "recall-webhook-verification-secret": "whsec_c3ludGhldGlj",
  "ngrok-authtoken": "synthetic-ngrok-canary",
  "hermes-api-key": "synthetic-hermes-canary",
};
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Operation =
  | "recall"
  | "discovery"
  | "assistant"
  | "save"
  | "reset"
  | "reload";

async function createFixture(
  page: Page,
  cleanups: Array<() => Promise<void> | void>,
  readySetup = false,
  guardedQuit = false,
) {
  // Install before importing runtime code. All native process calls and all
  // server-side network requests are forbidden; only injected adapters run.
  const native = { ...childProcess };
  const fetchImpl = globalThis.fetch;
  const forbidden: string[] = [];
  const deny = () => {
    forbidden.push("native subprocess");
    throw new Error("Fixture forbids native subprocesses");
  };
  childProcess.spawn = deny;
  childProcess.exec = deny as unknown as typeof childProcess.exec;
  childProcess.execFile = deny as unknown as typeof childProcess.execFile;
  childProcess.fork = deny;
  childProcess.spawnSync = deny;
  childProcess.execSync = deny;
  childProcess.execFileSync = deny;
  syncBuiltinESMExports();
  globalThis.fetch = async () => {
    forbidden.push("server fetch");
    throw new Error("Fixture forbids server network calls");
  };
  cleanups.push(() => {
    globalThis.fetch = fetchImpl;
    Object.assign(childProcess, native);
    syncBuiltinESMExports();
    expect(forbidden).toEqual([]);
  });
  const root = mkdtempSync(path.join(tmpdir(), "caddy-setup-browser-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ownedOrigins = new Set<string>();
  await page.context().route("**/*", async (route) => {
    if (ownedOrigins.has(new URL(route.request().url()).origin))
      await route.continue();
    else {
      forbidden.push("browser outside fixture");
      await route.abort();
    }
  });
  cleanups.push(() => page.context().unrouteAll({ behavior: "ignoreErrors" }));
  const { startDesktopApplication } = await import(
    "../../src/desktop/application.js"
  );
  const { startDesktopSetupRuntime } = await import(
    "../../src/desktop/setup-runtime.js"
  );
  const { ConnectionStorage } = await import(
    "../../src/server/desktop/connection-storage.js"
  );
  const { resolveDesktopPaths } = await import(
    "../../src/server/desktop/paths.js"
  );
  const { MacosKeychainSecretStore } = await import(
    "../../src/server/desktop/macos-keychain-secret-store.js"
  );
  const { LocalApiAccess } = await import(
    "../../src/server/security/local-api-access.js"
  );
  const paths = resolveDesktopPaths({
    applicationSupportDirectory: root,
    logsDirectory: root,
  });
  const events: string[] = [];
  const holds = new Map<
    Operation,
    { pending: ReturnType<typeof gate>; reject: boolean }
  >();
  const allGates: ReturnType<typeof gate>[] = [];
  const calls: { kind: Operation; input: unknown }[] = [];
  const values = new Map<string, string>();
  let writes = 0,
    commits = 0,
    runtimeStarts = 0;
  let storageFailure = false;
  let callbackDiagnostic:
    | import("../../src/server/desktop/recall-ngrok-connection-test.js").CallbackDiagnostic
    | null = null;
  let nativeFailure: "denied" | "timeout" | "mismatch" | null = null;
  const storage = new ConnectionStorage({
    paths,
    secretStore: new MacosKeychainSecretStore({
      async runner(request) {
        const operation = request.args[0];
        const account = request.args[request.args.indexOf("-a") + 1];
        if (!account) throw new Error("Missing synthetic account");
        const result = {
          exitCode: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          timedOut: false,
          outputExceeded: false,
        };
        if (operation === "add-generic-password") {
          const lines = request.stdin?.split("\n");
          if (!lines?.[0] || lines[0] !== lines[1])
            return { ...result, exitCode: 1 };
          if (nativeFailure === "denied")
            return {
              ...result,
              exitCode: 51,
              stderr: Buffer.from("synthetic-private-native-error"),
            };
          if (nativeFailure === "timeout")
            return { ...result, exitCode: null, timedOut: true };
          writes++;
          values.set(
            account,
            nativeFailure === "mismatch" ? "wrong-synthetic-value" : lines[0],
          );
        } else if (operation === "find-generic-password") {
          const value = values.get(account);
          if (value === undefined) return { ...result, exitCode: 44 };
          return { ...result, stdout: Buffer.from(`${value}\n`) };
        } else if (operation === "delete-generic-password") {
          return { ...result, exitCode: values.delete(account) ? 0 : 44 };
        } else throw new Error("Unexpected synthetic native operation");
        return result;
      },
    }),
    hooks: {
      afterAuthoritySwitch() {
        commits++;
        events.push("committed");
      },
    },
  });
  async function step(kind: Operation, input: unknown = null) {
    calls.push({ kind, input: structuredClone(input) });
    events.push(kind);
    const hold = holds.get(kind);
    if (hold) {
      holds.delete(kind);
      await hold.pending.promise;
      if (hold.reject) throw new Error("Synthetic adapter rejection");
    }
  }
  await storage.initialize();
  if (readySetup)
    await storage.save({
      connection: {
        recall: { region: "us-west-2", language: "en" },
        ngrok: { domain: "fixture.ngrok.app" },
        hermes: {
          mode: "local",
          localPort: 8642,
          remotePort: 8642,
          sshTarget: null,
          endpointPath: "/",
          profile: "everyday",
        },
      },
      replacements: canaries,
    });
  const initial = await storage.initialize();
  const localApiAccess = new LocalApiAccess();
  const servers: DesktopRuntimePort[] = [];
  cleanups.push(async () => {
    for (const port of servers) await port.close().catch(() => undefined);
  });
  async function simpleServer(text: string) {
    const server = createServer((_req, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<h1>${text}</h1>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture address");
    const applicationUrl = `http://127.0.0.1:${address.port}`;
    ownedOrigins.add(applicationUrl);
    const port: DesktopRuntimePort = {
      mode: "normal",
      applicationUrl,
      getQuitRisk: () => null,
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    };
    servers.push(port);
    return port;
  }
  let setupUrl = "";
  let first = true;
  const lifecycleErrors: unknown[] = [];
  let quitChoice: "save" | "discard" | "cancel" = "cancel";
  let windowClosed = false;
  let generation = 0;
  let nativeCloseHold: ReturnType<typeof gate> | null = null;
  const controller = await startDesktopApplication({
    reportLifecycleFailure(_stage, error) {
      lifecycleErrors.push(error);
    },
    app: {
      requestSingleInstanceLock: () => true,
      enableSandbox() {},
      whenReady: async () => {},
      quit() {
        events.push("app-quit");
      },
      onSecondInstance() {},
      onActivate() {},
      onBeforeQuit() {},
    },
    localApiAccess,
    createBootstrap: async () => {
      const port = await simpleServer("Fixture bootstrap");
      return { url: port.applicationUrl, close: port.close, update() {} };
    },
    createBrowserSession: () => ({
      async setCookie(cookie) {
        await page.context().addCookies([
          {
            name: cookie.name,
            value: cookie.value,
            url: cookie.url,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: "Strict",
          },
        ]);
      },
      async clear() {
        events.push("session-cleared");
        await page.context().clearCookies();
      },
    }),
    createWindow: ({ navigationPolicy }) => ({
      async loadURL(url) {
        // Model Electron's unload decision using the actual production script.
        // page.goto alone does not model BrowserWindow.loadURL's native veto.
        if (
          await page.evaluate(
            () =>
              !window.dispatchEvent(
                new Event("beforeunload", { cancelable: true }),
              ),
          )
        ) {
          events.push("navigation-vetoed");
          throw Error(
            "Synthetic native navigation prevented by actual renderer",
          );
        }
        generation++;
        await page.goto(url);
      },
      show() {},
      focus() {},
      restore() {},
      isDestroyed: () => windowClosed,
      isMinimized: () => false,
      onClose() {},
      destroy() {},
      closeForQuit: async (approveClose) => {
        if (!guardedQuit || windowClosed) return true;
        let closed = () => {},
          veto = () => {};
        return closeWindowForQuit(
          {
            url: () => page.url(),
            generation: () => generation,
            evaluate: (script) => page.evaluate(script),
            choose: async () => quitChoice,
            report: async () => {
              events.push("quit-report");
            },
            onClosed: (listener) => {
              closed = listener;
              return () => {};
            },
            onVeto: (listener) => {
              veto = listener;
              return () => {};
            },
            close: () => {
              events.push("native-close-requested");
              void (async () => {
                if (nativeCloseHold) await nativeCloseHold.promise;
                const prevented = await page.evaluate(
                  () =>
                    !window.dispatchEvent(
                      new Event("beforeunload", { cancelable: true }),
                    ),
                );
                if (prevented) {
                  events.push("native-veto");
                  veto();
                } else {
                  windowClosed = true;
                  events.push("native-closed");
                  closed();
                }
              })();
            },
          },
          navigationPolicy,
          approveClose,
        );
      },
    }),
    startRuntime: async (_window, lifecycle) => {
      runtimeStarts++;
      if (!first) {
        events.push("replacement-started");
        return simpleServer("Fixture runtime replaced");
      }
      first = false;
      const runtime = await startDesktopSetupRuntime({
        localApiAccess,
        initialStatus: initial,
        storage: {
          initialize: () => storage.initialize(),
          loadActiveAuthority: () => storage.loadActiveAuthority(),
          async save(input) {
            await step("save", input);
            if (storageFailure)
              throw Object.assign(new Error("synthetic-private-path"), {
                code: "EACCES",
              });
            return storage.save(input);
          },
          async resetCredentials() {
            await step("reset");
            return storage.resetCredentials();
          },
        },
        connectionTester: {
          async test(input) {
            await step("recall", input);
            return {
              generation: input.generation,
              recallCredentials: { state: "authenticated_read_only" },
              localWebhook: { state: "verified_synthetic" },
              ngrokEndpoint: { state: "verified_exact_domain" },
              publicWebhook: callbackDiagnostic
                ? { state: "failed", diagnostic: callbackDiagnostic }
                : { state: "verified_synthetic" },
              webhookAuthenticity: { state: "verified_in_automation" },
              botCreation: { state: "not_attempted" },
              retention: {
                requestedMedia: "none",
                providerConfirmation: "not_observed",
                accountMetadata: "unknown",
                localManagedDays: 7,
              },
            };
          },
        },
        hermesConnectionTester: {
          async discover(input) {
            await step("discovery", input);
            return {
              generation: input.generation,
              state: "profiles_advertised",
              profiles: ["everyday", "backup", "marty"],
            };
          },
          async testAssistant(input) {
            await step("assistant", input);
            return {
              generation: input.generation,
              state: "assistant_verified_synthetic",
            };
          },
        },
        async requestReload() {
          await step("reload");
          return lifecycle.requestReload();
        },
      });
      setupUrl = runtime.applicationUrl;
      ownedOrigins.add(setupUrl);
      return {
        ...runtime,
        async close() {
          events.push("setup-close");
          await runtime.close();
          events.push("setup-closed");
        },
      };
    },
    confirmForceQuit: async () => false,
  });
  if (!controller) throw new Error("No fixture controller");
  cleanups.push(async () => {
    for (const pending of allGates) pending.release();
    quitChoice = "discard";
    nativeCloseHold?.release();
    await controller.requestQuit();
    expect(lifecycleErrors).toEqual([]);
  });
  await controller.startupSettled;
  expect(lifecycleErrors).toEqual([]);
  await expect(page.locator("#recall-api-key")).toBeEnabled();
  return {
    requestQuit(choice: "save" | "discard" | "cancel") {
      quitChoice = choice;
      return controller.requestQuit();
    },
    holdNativeClose() {
      nativeCloseHold = gate();
      allGates.push(nativeCloseHold);
      return nativeCloseHold;
    },
    setStorageFailure(value: boolean) {
      storageFailure = value;
    },
    setCallbackDiagnostic(value: typeof callbackDiagnostic) {
      callbackDiagnostic = value;
    },
    setNativeFailure(value: typeof nativeFailure) {
      nativeFailure = value;
    },
    events,
    calls,
    storage,
    paths,
    setupUrl,
    forbidden,
    get writes() {
      return writes;
    },
    get commits() {
      return commits;
    },
    get runtimeStarts() {
      return runtimeStarts;
    },
    hold(kind: Operation, reject = false) {
      const pending = gate();
      allGates.push(pending);
      holds.set(kind, { pending, reject });
      return pending;
    },
    async waitFor(kind: Operation, count = 1) {
      await expect
        .poll(() => calls.filter((call) => call.kind === kind).length)
        .toBe(count);
    },
    async authority() {
      return storage.loadActiveAuthority();
    },
    secretSlots() {
      return new Map(values);
    },
    settingsBytes() {
      return readFileSync(paths.connectionSettingsFile, "utf8");
    },
  };
}
export const test = base.extend<{
  setup: Awaited<ReturnType<typeof createFixture>>;
  readySetup: boolean;
  guardedQuit: boolean;
}>({
  readySetup: [false, { option: true }],
  guardedQuit: [false, { option: true }],
  setup: async ({ page, readySetup, guardedQuit }, use) => {
    const cleanups: Array<() => Promise<void> | void> = [];
    const errors: unknown[] = [];
    try {
      await use(await createFixture(page, cleanups, readySetup, guardedQuit));
    } catch (error) {
      errors.push(error);
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Fixture test or cleanup failed");
  },
});
export async function enterDraft(page: Page, hermes = true) {
  for (const [role, value] of Object.entries(canaries)) {
    if (hermes || role !== "hermes-api-key")
      await page.locator(`#${role}`).fill(value);
  }
  await page.locator("#ngrok-domain").fill("fixture.ngrok.app");
  if (hermes) await page.locator("#hermes-mode").selectOption("local");
}
export async function checkAll(page: Page) {
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Connection checks passed",
  );
  await page.locator("#discover-hermes-profiles").click();
  await expect(page.locator("#hermes-outcome")).toContainText("models loaded");
  await page.locator("#hermes-profile").selectOption("everyday");
  await page.locator("#test-hermes-assistant").click();
  await expect(page.locator("#assistant-outcome")).toContainText(
    "Assistant test passed",
  );
}
export type SaveInput = Parameters<ConnectionStorage["save"]>[0];
