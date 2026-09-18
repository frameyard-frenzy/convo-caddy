import type { SessionState } from "../domain/types.js";
import type {
  ElectronSessionCookie,
  LocalApiAccess,
} from "../server/security/local-api-access.js";
import type {
  DesktopBootstrapServer,
  DesktopBootstrapView,
} from "./bootstrap-server.js";
import type { WorkspaceDialogPort } from "./workspace-dialog.js";
import {
  createEphemeralPartition,
  NavigationPolicy,
} from "./window-security.js";

export type PreventableEvent = { preventDefault(): void };

export interface DesktopAppPort {
  requestSingleInstanceLock(): boolean;
  enableSandbox(): void;
  whenReady(): Promise<void>;
  quit(): void;
  onSecondInstance(listener: () => void): void;
  onActivate(listener: () => void): void;
  onBeforeQuit(listener: (event: PreventableEvent) => void): void;
}

export interface DesktopWindowPort {
  readonly workspaceDialog?: WorkspaceDialogPort;
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  restore(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  onClose(listener: (event: PreventableEvent) => void): void;
  destroy(): void;
  closeForQuit(approveClose: () => Promise<boolean>): Promise<boolean>;
}

export interface DesktopBrowserSessionPort {
  setCookie(cookie: ElectronSessionCookie): Promise<void>;
  clear(): Promise<void>;
}

export interface DesktopRuntimePort {
  mode: "normal" | "setup";
  applicationUrl: string;
  getQuitRisk(): QuitRisk | null;
  moveWorkspace?(): Promise<void>;
  close(): Promise<void>;
}

export type DesktopBootstrapPort = DesktopBootstrapServer;
export type QuitRisk = "active_interview" | "finalizing" | "needs_attention";

export type StartDesktopApplicationOptions = {
  app: DesktopAppPort;
  localApiAccess: LocalApiAccess;
  createBootstrap(): Promise<DesktopBootstrapPort>;
  createBrowserSession(partition: string): DesktopBrowserSessionPort;
  createWindow(input: {
    partition: string;
    navigationPolicy: NavigationPolicy;
  }): DesktopWindowPort;
  startRuntime(
    window: DesktopWindowPort,
    lifecycle: {
      mode: "normal" | "setup";
      requestReload(): Promise<"blocked" | "reloaded">;
    },
  ): Promise<DesktopRuntimePort>;
  confirmForceQuit(risk: QuitRisk): Promise<boolean>;
  releaseMaintenanceLock?(): void;
  quitCleanupTimeoutMs?: number;
  reportStartupFailure?(
    kind: Exclude<DesktopBootstrapView["kind"], "starting">,
  ): void;
  reportLifecycleFailure?(
    operation: "quit" | "reload" | "startup",
    error: unknown,
  ): void;
  reportRuntimeReady?(mode: "normal" | "setup"): void;
  reportSecondInstanceFocus?(): void;
};

export class DesktopStartupError extends Error {
  readonly kind: Exclude<DesktopBootstrapView["kind"], "starting">;

  constructor(kind: Exclude<DesktopBootstrapView["kind"], "starting">) {
    super("Desktop startup needs attention.");
    this.name = "DesktopStartupError";
    this.kind = kind;
  }
}

export async function startDesktopApplication(
  options: StartDesktopApplicationOptions,
): Promise<DesktopApplicationController | null> {
  if (!options.app.requestSingleInstanceLock()) {
    options.app.quit();
    return null;
  }

  options.app.enableSandbox();
  let controller: DesktopApplicationController | null = null;
  options.app.onSecondInstance(() => {
    if (controller?.focusWindow()) {
      options.reportSecondInstanceFocus?.();
    }
  });
  options.app.onActivate(() => controller?.focusWindow());
  options.app.onBeforeQuit((event) => controller?.handleBeforeQuit(event));

  let bootstrap: DesktopBootstrapPort | null = null;
  let browserSession: DesktopBrowserSessionPort | null = null;
  let window: DesktopWindowPort | null = null;
  try {
    await options.app.whenReady();
    bootstrap = await options.createBootstrap();
    const navigationPolicy = new NavigationPolicy();
    navigationPolicy.allow(bootstrap.url);
    const partition = createEphemeralPartition();
    browserSession = options.createBrowserSession(partition);
    window = options.createWindow({ partition, navigationPolicy });
    controller = new DesktopApplicationController({
      ...options,
      bootstrap,
      browserSession,
      navigationPolicy,
      window,
    });
    window.onClose((event) => controller?.handleWindowClose(event));
    bootstrap.update({ kind: "starting" });
    await window.loadURL(bootstrap.url);
    window.show();
    controller.beginStartup();
    return controller;
  } catch (error) {
    controller = null;
    const rollbackErrors: unknown[] = [];
    try {
      window?.destroy();
    } catch (caught) {
      rollbackErrors.push(caught);
    }
    rollbackErrors.push(
      ...(await collectCloseErrors([
        () => bootstrap?.close() ?? Promise.resolve(),
        () => browserSession?.clear() ?? Promise.resolve(),
      ])),
    );
    options.app.quit();
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Desktop shell startup and rollback failed.",
      );
    }
    throw error;
  }
}

type ControllerOptions = StartDesktopApplicationOptions & {
  bootstrap: DesktopBootstrapPort;
  browserSession: DesktopBrowserSessionPort;
  navigationPolicy: NavigationPolicy;
  window: DesktopWindowPort;
};

export class DesktopApplicationController {
  readonly #options: ControllerOptions;
  readonly #quitCleanupTimeoutMs: number;
  #bootstrap: DesktopBootstrapPort | null;
  #runtime: DesktopRuntimePort | null = null;
  #startupSettled: Promise<void> = Promise.resolve();
  #quitPromise: Promise<"blocked" | "quit"> | null = null;
  #reloadPromise: Promise<"blocked" | "reloaded"> | null = null;
  #connectionSettingsPromise: Promise<"blocked" | "opened"> | null = null;
  #lifecycleQueue: Promise<void> = Promise.resolve();
  #quitApproved = false;
  #closingWindow = false;
  #shuttingDown = false;

  constructor(options: ControllerOptions) {
    this.#options = options;
    this.#bootstrap = options.bootstrap;
    this.#quitCleanupTimeoutMs = positiveTimeout(
      options.quitCleanupTimeoutMs ?? 5_000,
    );
  }

  get startupSettled(): Promise<void> {
    return this.#startupSettled;
  }

  beginStartup(mode: "normal" | "setup" = "normal"): void {
    this.#startupSettled = this.#launchRuntime(mode).catch((error) => {
      this.#options.reportLifecycleFailure?.("startup", error);
    });
  }

  focusWindow(): boolean {
    if (this.#options.window.isDestroyed()) {
      return false;
    }
    if (this.#options.window.isMinimized()) {
      this.#options.window.restore();
    }
    this.#options.window.show();
    this.#options.window.focus();
    return true;
  }

  handleWindowClose(event: PreventableEvent): void {
    if (this.#quitApproved || this.#closingWindow) {
      return;
    }
    event.preventDefault();
    void this.requestQuit().catch((error) =>
      this.#options.reportLifecycleFailure?.("quit", error),
    );
  }

  handleBeforeQuit(event: PreventableEvent): void {
    if (this.#quitApproved) {
      return;
    }
    event.preventDefault();
    void this.requestQuit().catch((error) =>
      this.#options.reportLifecycleFailure?.("quit", error),
    );
  }

  async moveWorkspace(): Promise<void> {
    if (this.#shuttingDown || this.#quitPromise)
      throw new Error("Wait for the current application operation.");
    return this.#enqueueLifecycle(async () => {
      await this.#startupSettled;
      if (!this.#runtime?.moveWorkspace)
        throw new Error("Finish connection setup before moving the workspace.");
      if (this.#runtime.getQuitRisk())
        throw new Error(
          "Finish capture and saving before moving the workspace.",
        );
      await this.#runtime.moveWorkspace();
    });
  }

  async reloadConfiguration(): Promise<"blocked" | "reloaded"> {
    if (this.#shuttingDown || this.#quitPromise) {
      return "blocked";
    }
    this.#reloadPromise ??= this.#enqueueLifecycle(() =>
      this.#reloadConfiguration(),
    );
    try {
      return await this.#reloadPromise;
    } finally {
      this.#reloadPromise = null;
    }
  }

  async #reloadConfiguration(): Promise<"blocked" | "reloaded"> {
    return (await this.#replaceRuntime("normal")) ? "reloaded" : "blocked";
  }

  async openConnectionSettings(): Promise<"blocked" | "opened"> {
    if (this.#shuttingDown || this.#quitPromise) {
      return "blocked";
    }
    this.#connectionSettingsPromise ??= this.#enqueueLifecycle(() =>
      this.#openConnectionSettings(),
    );
    try {
      return await this.#connectionSettingsPromise;
    } finally {
      this.#connectionSettingsPromise = null;
    }
  }

  async #openConnectionSettings(): Promise<"blocked" | "opened"> {
    await this.#startupSettled;
    if (this.#runtime?.mode === "setup") {
      this.focusWindow();
      return "opened";
    }
    return (await this.#replaceRuntime("setup")) ? "opened" : "blocked";
  }

  async #replaceRuntime(mode: "normal" | "setup"): Promise<boolean> {
    await this.#startupSettled;
    if (this.#runtime?.getQuitRisk() !== null) {
      return false;
    }
    let setupRecoveryReady = false;
    try {
      await this.#runtime?.close();
      this.#runtime = null;
      await this.#bootstrap?.close();
      this.#bootstrap = null;
      await this.#options.browserSession.clear();
      setupRecoveryReady = true;
      const bootstrap = await this.#options.createBootstrap();
      this.#bootstrap = bootstrap;
      bootstrap.update({ kind: "starting" });
      this.#options.navigationPolicy.allow(bootstrap.url);
      await this.#options.window.loadURL(bootstrap.url);
      this.focusWindow();
      this.beginStartup(mode);
      return true;
    } catch (error) {
      if (setupRecoveryReady && this.#runtime === null) {
        let setupRecoveryAvailable = true;
        if (this.#bootstrap !== null) {
          try {
            await this.#bootstrap.close();
            this.#bootstrap = null;
          } catch (cleanupError) {
            setupRecoveryAvailable = false;
            this.#options.reportLifecycleFailure?.("startup", cleanupError);
          }
        }
        if (setupRecoveryAvailable) {
          try {
            await this.#startRuntime("setup");
            return false;
          } catch (setupError) {
            await this.#discardFailedRuntime();
            this.#options.reportLifecycleFailure?.("startup", setupError);
          }
        }
      }
      const bootstrap = await this.#ensureBootstrap();
      bootstrap.update({ kind: "needs_attention" });
      this.#options.navigationPolicy.allow(bootstrap.url);
      await this.#options.window.loadURL(bootstrap.url);
      this.focusWindow();
      this.#options.reportLifecycleFailure?.("startup", error);
      return false;
    }
  }

  async requestQuit(): Promise<"blocked" | "quit"> {
    if (this.#quitPromise) {
      return this.#quitPromise;
    }
    this.#quitPromise = this.#enqueueLifecycle(() => this.#requestQuit());
    try {
      const result = await this.#quitPromise;
      if (result === "blocked") {
        this.#quitPromise = null;
      }
      return result;
    } catch (error) {
      this.#quitPromise = null;
      throw error;
    }
  }

  async #requestQuit(): Promise<"blocked" | "quit"> {
    await this.#startupSettled;
    const risk = this.#runtime?.getQuitRisk() ?? null;
    if (risk && !(await this.#options.confirmForceQuit(risk))) {
      return "blocked";
    }
    // Resolve renderer drafts and actual unload BEFORE stopping its backend.
    try {
      if (
        (await this.#options.window.closeForQuit(async () => {
          const latestRisk = this.#runtime?.getQuitRisk() ?? null;
          if (
            latestRisk &&
            latestRisk !== risk &&
            !(await this.#options.confirmForceQuit(latestRisk))
          )
            return false;
          this.#closingWindow = true;
          return true;
        })) === false
      )
        return "blocked";
    } finally {
      this.#closingWindow = false;
    }
    this.#shuttingDown = true;
    try {
      await withTimeout(this.#shutdown(), this.#quitCleanupTimeoutMs);
      // A failed or timed-out drain keeps exclusion until the OS closes the
      // main-process descriptor. Requesting app.quit() is not process exit.
      this.#options.releaseMaintenanceLock?.();
    } catch (error) {
      try {
        this.#options.reportLifecycleFailure?.("quit", error);
      } catch {
        // An explicit, approved Quit must not be trapped by its reporting path.
      }
    }
    this.#quitApproved = true;
    this.#options.app.quit();
    return "quit";
  }

  async #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#lifecycleQueue.then(operation, operation);
    this.#lifecycleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #launchRuntime(mode: "normal" | "setup"): Promise<void> {
    try {
      await this.#startRuntime(mode);
    } catch (error) {
      if (this.#shuttingDown) {
        return;
      }
      const recovered = await this.#discardFailedRuntime();
      const kind =
        error instanceof DesktopStartupError ? error.kind : "needs_attention";
      this.#options.reportStartupFailure?.(kind);
      if (mode === "normal" && recovered) {
        try {
          await this.#startRuntime("setup");
          return;
        } catch (setupError) {
          if (this.#shuttingDown) {
            return;
          }
          await this.#discardFailedRuntime();
          this.#options.reportLifecycleFailure?.("startup", setupError);
        }
      }
      const bootstrap = await this.#ensureBootstrap();
      bootstrap.update({ kind });
      await this.#options.window.loadURL(bootstrap.url);
      this.focusWindow();
    }
  }

  async #startRuntime(mode: "normal" | "setup"): Promise<void> {
    const runtime = await this.#options.startRuntime(this.#options.window, {
      mode,
      requestReload: () => this.reloadConfiguration(),
    });
    if (this.#shuttingDown) {
      await runtime.close();
      return;
    }
    this.#runtime = runtime;
    this.#options.localApiAccess.bindOrigin(runtime.applicationUrl);
    this.#options.navigationPolicy.allow(runtime.applicationUrl);
    await this.#options.browserSession.setCookie(
      this.#options.localApiAccess.createElectronCookie(),
    );
    await this.#options.window.loadURL(runtime.applicationUrl);
    await this.#bootstrap?.close();
    this.#bootstrap = null;
    this.#options.reportRuntimeReady?.(runtime.mode);
  }

  async #discardFailedRuntime(): Promise<boolean> {
    if (!this.#runtime) {
      return true;
    }
    let runtimeClosed = false;
    try {
      await this.#runtime.close();
      runtimeClosed = true;
    } catch (cleanupError) {
      this.#options.reportLifecycleFailure?.("startup", cleanupError);
      // The fixed needs-attention view remains available after cleanup errors.
    }
    if (runtimeClosed) {
      this.#runtime = null;
    }
    try {
      await this.#options.browserSession.clear();
    } catch {
      // The failed runtime origin is closed and navigation is reset below.
    }
    return runtimeClosed;
  }

  async #ensureBootstrap(): Promise<DesktopBootstrapPort> {
    if (this.#bootstrap) {
      this.#options.navigationPolicy.allow(this.#bootstrap.url);
      return this.#bootstrap;
    }
    const bootstrap = await this.#options.createBootstrap();
    this.#bootstrap = bootstrap;
    this.#options.navigationPolicy.allow(bootstrap.url);
    return bootstrap;
  }

  async #shutdown(): Promise<void> {
    await this.#startupSettled;
    const errors: unknown[] = [];
    for (const close of [
      () => this.#runtime?.close() ?? Promise.resolve(),
      () => this.#bootstrap?.close() ?? Promise.resolve(),
      () => this.#options.browserSession.clear(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Desktop shutdown was incomplete.");
    }
  }
}

async function withTimeout(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Desktop shutdown timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function positiveTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Desktop quit cleanup timeout must be positive.");
  }
  return timeoutMs;
}

async function collectCloseErrors(
  closes: Array<() => Promise<void>>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const close of closes) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function classifyQuitRisk(state: SessionState): QuitRisk | null {
  const finalization = state.lifecycle.finalization.state;
  if (
    finalization === "waiting_for_provider" ||
    finalization === "finalizing"
  ) {
    return "finalizing";
  }
  if (finalization === "needs_attention") {
    return "needs_attention";
  }
  if (state.capture.mode === "recall") {
    if (state.capture.status === "failed") {
      return "needs_attention";
    }
    if (state.lifecycle.finalization.state !== "complete") {
      return state.capture.status === "ended"
        ? "finalizing"
        : "active_interview";
    }
  }
  return null;
}
