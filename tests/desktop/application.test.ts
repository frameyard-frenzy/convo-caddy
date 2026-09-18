import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../../src/domain/types.js";
import {
  classifyQuitRisk,
  startDesktopApplication,
  type DesktopAppPort,
  type StartDesktopApplicationOptions,
  type DesktopBootstrapPort,
  type DesktopBrowserSessionPort,
  type DesktopRuntimePort,
  type DesktopWindowPort,
  type PreventableEvent,
} from "../../src/desktop/application.js";
import { LocalApiAccess } from "../../src/server/security/local-api-access.js";
import { createSessionState } from "../helpers/session-state.js";

describe("desktop application lifecycle", () => {
  it("quits a second process and focuses the first window on later launches", async () => {
    const secondary = createHarness({ primary: false });
    expect(await startDesktopApplication(secondary.options)).toBeNull();
    expect(secondary.app.quit).toHaveBeenCalledOnce();
    expect(secondary.createWindow).not.toHaveBeenCalled();

    const primary = createHarness();
    const controller = await startDesktopApplication(primary.options);
    expect(controller).not.toBeNull();
    primary.app.emitSecondInstance();
    expect(primary.window.show).toHaveBeenCalled();
    expect(primary.window.focus).toHaveBeenCalled();
    expect(primary.reportSecondInstanceFocus).toHaveBeenCalledOnce();

    const destroyed = createHarness();
    const destroyedController = await startDesktopApplication(
      destroyed.options,
    );
    expect(destroyedController).not.toBeNull();
    vi.mocked(destroyed.window.isDestroyed).mockReturnValue(true);
    destroyed.app.emitSecondInstance();
    expect(destroyed.reportSecondInstanceFocus).not.toHaveBeenCalled();
  });

  it("shows the bootstrap window while dependencies are still starting", async () => {
    let resolveRuntime: (runtime: DesktopRuntimePort) => void = () => undefined;
    const runtimePending = new Promise<DesktopRuntimePort>((resolve) => {
      resolveRuntime = resolve;
    });
    const harness = createHarness({ startRuntime: () => runtimePending });
    const controller = await startDesktopApplication(harness.options);

    expect(harness.window.loadURL).toHaveBeenCalledWith(harness.bootstrap.url);
    expect(harness.window.show).toHaveBeenCalledOnce();
    expect(harness.browserSession.setCookie).not.toHaveBeenCalled();

    resolveRuntime(harness.runtime);
    await controller?.startupSettled;
    expect(harness.browserSession.setCookie).toHaveBeenCalledOnce();
    expect(harness.window.loadURL).toHaveBeenLastCalledWith(
      harness.runtime.applicationUrl,
    );
  });

  it("routes window close through the active-interview quit guard", async () => {
    const harness = createHarness({ state: activeState() });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    const closeEvent = preventableEvent();
    harness.window.emitClose(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(harness.confirmForceQuit).toHaveBeenCalledWith("active_interview"),
    );
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect(harness.app.quit).not.toHaveBeenCalled();
  });

  it("quits an idle application when its window is closed", async () => {
    const harness = createHarness();
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    const closeEvent = preventableEvent();
    harness.window.emitClose(closeEvent);

    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce());
    expect(harness.runtime.close).toHaveBeenCalledOnce();
    expect(harness.browserSession.clear).toHaveBeenCalledOnce();
  });

  it("closes owned resources before approving an idle quit", async () => {
    const harness = createHarness();
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    expect(await controller?.requestQuit()).toBe("quit");
    expect(harness.runtime.close).toHaveBeenCalledOnce();
    expect(harness.browserSession.clear).toHaveBeenCalledOnce();
    expect(harness.app.quit).toHaveBeenCalledOnce();
  });

  it("blocks quit while Recall finalization is still incomplete", async () => {
    const state = createSessionState({
      sessionId: "finalizing",
      startedAt: "2026-08-26T12:00:00.000Z",
    });
    state.lifecycle.finalization = {
      state: "waiting_for_provider",
      missing: ["bot_done"],
    };
    const harness = createHarness({ state });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    expect(await controller?.requestQuit()).toBe("blocked");
    expect(harness.confirmForceQuit).toHaveBeenCalledWith("finalizing");
    expect(harness.runtime.close).not.toHaveBeenCalled();
  });

  it("rolls back acquired shell resources when initial navigation fails", async () => {
    const harness = createHarness();
    harness.window.loadURL.mockRejectedValueOnce(
      new Error("navigation failed"),
    );

    await expect(startDesktopApplication(harness.options)).rejects.toThrow(
      "navigation failed",
    );
    expect(harness.window.destroy).toHaveBeenCalledOnce();
    expect(harness.bootstrap.close).toHaveBeenCalledOnce();
    expect(harness.browserSession.clear).toHaveBeenCalledOnce();
    expect(harness.app.quit).toHaveBeenCalledOnce();
  });

  it("continues initial rollback when window destruction fails", async () => {
    const harness = createHarness();
    harness.window.loadURL.mockRejectedValueOnce(
      new Error("navigation failed"),
    );
    harness.window.destroy.mockImplementationOnce(() => {
      throw new Error("destroy failed");
    });

    await expect(startDesktopApplication(harness.options)).rejects.toThrow(
      "Desktop shell startup and rollback failed",
    );
    expect(harness.bootstrap.close).toHaveBeenCalledOnce();
    expect(harness.browserSession.clear).toHaveBeenCalledOnce();
    expect(harness.app.quit).toHaveBeenCalledOnce();
  });

  it("does not re-enter lifecycle cleanup while quitting after startup rollback", async () => {
    const harness = createHarness({ quitEmitsBeforeQuit: true });
    harness.window.loadURL.mockRejectedValueOnce(
      new Error("navigation failed"),
    );

    await expect(startDesktopApplication(harness.options)).rejects.toThrow(
      "navigation failed",
    );
    expect(harness.app.quit).toHaveBeenCalledOnce();
    expect(harness.confirmForceQuit).not.toHaveBeenCalled();
  });

  it("retains a runtime whose failed startup cleanup must be retried", async () => {
    const harness = createHarness();
    harness.browserSession.setCookie.mockRejectedValueOnce(
      new Error("cookie failed"),
    );
    harness.runtime.close.mockRejectedValueOnce(new Error("close failed"));
    const controller = await startDesktopApplication(harness.options);

    await controller?.startupSettled;
    await expect(controller?.requestQuit()).resolves.toBe("quit");
    expect(harness.runtime.close).toHaveBeenCalledTimes(2);
    expect(harness.reportLifecycleFailure).toHaveBeenCalledWith(
      "startup",
      expect.any(Error),
    );
    expect(harness.app.quit).toHaveBeenCalledOnce();
  });

  it("reopens authenticated setup when replacement bootstrap navigation fails", async () => {
    const requestedModes: string[] = [];
    const harness = createHarness({
      startRuntime: async (_window, lifecycle) => {
        requestedModes.push(lifecycle.mode);
        return { ...harness.runtime, mode: lifecycle.mode };
      },
    });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;
    harness.window.loadURL
      .mockRejectedValueOnce(new Error("replacement navigation failed"))
      .mockResolvedValue(undefined);

    await expect(controller?.reloadConfiguration()).resolves.toBe("blocked");
    expect(requestedModes).toEqual(["normal", "setup"]);
    expect(harness.window.loadURL).toHaveBeenLastCalledWith(
      harness.runtime.applicationUrl,
    );
  });

  it("reports a failed startup recovery without an unhandled rejection", async () => {
    const harness = createHarness({
      startRuntime: async () => {
        throw new Error("runtime failed");
      },
    });
    harness.window.loadURL
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("recovery navigation failed"));
    const controller = await startDesktopApplication(harness.options);

    await expect(controller?.startupSettled).resolves.toBeUndefined();
    expect(harness.reportLifecycleFailure).toHaveBeenCalledWith(
      "startup",
      expect.any(Error),
    );
  });

  it("waits for startup before applying the active-interview quit guard", async () => {
    const pending = deferred<DesktopRuntimePort>();
    const harness = createHarness({
      state: activeState(),
      startRuntime: () => pending.promise,
    });
    const controller = await startDesktopApplication(harness.options);
    const quit = controller?.requestQuit();

    pending.resolve(harness.runtime);
    await expect(quit).resolves.toBe("blocked");
    expect(harness.confirmForceQuit).toHaveBeenCalledOnce();
    expect(harness.runtime.close).not.toHaveBeenCalled();
  });

  it("coalesces concurrent active-session quit requests", async () => {
    const confirmation = deferred<boolean>();
    const harness = createHarness({
      state: activeState(),
      confirmForceQuit: () => confirmation.promise,
    });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    const first = controller?.requestQuit();
    const second = controller?.requestQuit();
    confirmation.resolve(false);

    await expect(first).resolves.toBe("blocked");
    await expect(second).resolves.toBe("blocked");
    expect(harness.confirmForceQuit).toHaveBeenCalledOnce();
  });

  it("allows quit retry after confirmation fails", async () => {
    const confirmForceQuit = vi
      .fn<
        (
          risk: Parameters<
            StartDesktopApplicationOptions["confirmForceQuit"]
          >[0],
        ) => Promise<boolean>
      >()
      .mockRejectedValueOnce(new Error("dialog failed"))
      .mockResolvedValueOnce(false);
    const harness = createHarness({
      state: activeState(),
      confirmForceQuit,
    });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    await expect(controller?.requestQuit()).rejects.toThrow("dialog failed");
    await expect(controller?.requestQuit()).resolves.toBe("blocked");
    expect(harness.confirmForceQuit).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent configuration reloads", async () => {
    const harness = createHarness();
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    const first = controller?.reloadConfiguration();
    const second = controller?.reloadConfiguration();
    await expect(first).resolves.toBe("reloaded");
    await expect(second).resolves.toBe("reloaded");
    expect(harness.runtime.close).toHaveBeenCalledOnce();
    expect(harness.browserSession.clear).toHaveBeenCalledOnce();
  });

  it("focuses existing setup without replacing its unsaved renderer", async () => {
    const harness = createHarness();
    harness.runtime.mode = "setup";
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;
    const loads = harness.window.loadURL.mock.calls.length;
    await expect(controller?.openConnectionSettings()).resolves.toBe("opened");
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect(harness.window.loadURL).toHaveBeenCalledTimes(loads);
    await controller?.requestQuit();
  });

  it("opens the authenticated connection setup runtime while idle and returns through its reload callback", async () => {
    const modes: string[] = [];
    const setupLifecycle: {
      requestReload?: () => Promise<"blocked" | "reloaded">;
    } = {};
    const harness = createHarness({
      startRuntime: async (_window, lifecycle) => {
        modes.push(lifecycle.mode);
        if (lifecycle.mode === "setup") {
          setupLifecycle.requestReload = lifecycle.requestReload;
        }
        return harness.runtime;
      },
    });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    await expect(controller?.openConnectionSettings()).resolves.toBe("opened");
    expect(modes).toEqual(["normal", "setup"]);
    expect(setupLifecycle.requestReload).toBeTypeOf("function");

    await expect(setupLifecycle.requestReload?.()).resolves.toBe("reloaded");
    expect(modes).toEqual(["normal", "setup", "normal"]);
  });

  it("reopens authenticated setup when a setup reload cannot start the normal runtime", async () => {
    const requestedModes: string[] = [];
    let attempt = 0;
    const harness = createHarness({
      startRuntime: async (_window, lifecycle) => {
        requestedModes.push(lifecycle.mode);
        attempt += 1;
        if (attempt === 2) {
          throw new Error("normal runtime failed");
        }
        return { ...harness.runtime, mode: "setup" };
      },
    });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    await expect(controller?.reloadConfiguration()).resolves.toBe("reloaded");
    await controller?.startupSettled;

    expect(requestedModes).toEqual(["normal", "normal", "setup"]);
    expect(harness.window.loadURL).toHaveBeenLastCalledWith(
      harness.runtime.applicationUrl,
    );
    expect(harness.bootstrap.update).not.toHaveBeenLastCalledWith({
      kind: "needs_attention",
    });
  });

  it("reopens authenticated setup when replacement bootstrap staging fails", async () => {
    const requestedModes: string[] = [];
    const harness = createHarness({
      startRuntime: async (_window, lifecycle) => {
        requestedModes.push(lifecycle.mode);
        return { ...harness.runtime, mode: lifecycle.mode };
      },
    });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;
    harness.createBootstrap.mockRejectedValueOnce(
      new Error("replacement bootstrap failed"),
    );

    await expect(controller?.reloadConfiguration()).resolves.toBe("blocked");

    expect(requestedModes).toEqual(["normal", "setup"]);
    expect(harness.window.loadURL).toHaveBeenLastCalledWith(
      harness.runtime.applicationUrl,
    );
  });

  it("does not open connection settings during an active interview", async () => {
    const harness = createHarness({ state: activeState() });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    await expect(controller?.openConnectionSettings()).resolves.toBe("blocked");
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect(harness.browserSession.clear).not.toHaveBeenCalled();
  });

  it("retains the maintenance lock until process exit when runtime drain fails", async () => {
    const harness = createHarness();
    const releaseMaintenanceLock = vi.fn();
    harness.runtime.close.mockRejectedValueOnce(new Error("close failed"));
    const controller = await startDesktopApplication({
      ...harness.options,
      releaseMaintenanceLock,
    });
    await controller?.startupSettled;
    await expect(controller?.requestQuit()).resolves.toBe("quit");
    expect(harness.app.quit).toHaveBeenCalledOnce();
    expect(releaseMaintenanceLock).not.toHaveBeenCalled();
  });

  it("reports cleanup failure and still completes an explicit quit", async () => {
    const harness = createHarness();
    harness.runtime.close.mockRejectedValueOnce(new Error("close failed"));
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    await expect(controller?.requestQuit()).resolves.toBe("quit");
    expect(harness.reportLifecycleFailure).toHaveBeenCalledWith(
      "quit",
      expect.any(AggregateError),
    );
    expect(harness.app.quit).toHaveBeenCalledOnce();
  });

  it("still quits when cleanup failure reporting also fails", async () => {
    const harness = createHarness();
    harness.runtime.close.mockRejectedValueOnce(new Error("close failed"));
    harness.reportLifecycleFailure.mockImplementationOnce(() => {
      throw new Error("logging failed");
    });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    await expect(controller?.requestQuit()).resolves.toBe("quit");
    expect(harness.app.quit).toHaveBeenCalledOnce();
  });

  it("bounds a hung cleanup and still completes an explicit quit", async () => {
    const pendingClose = deferred<void>();
    const harness = createHarness({ quitCleanupTimeoutMs: 5 });
    harness.runtime.close.mockReturnValueOnce(pendingClose.promise);
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;
    vi.useFakeTimers();

    try {
      let settled = false;
      const quit = controller?.requestQuit().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(10);
      const settledAfterTimeout = settled;
      pendingClose.resolve();

      await expect(quit).resolves.toBe("quit");
      expect(settledAfterTimeout).toBe(true);
      expect(harness.reportLifecycleFailure).toHaveBeenCalledWith(
        "quit",
        expect.objectContaining({ message: "Desktop shutdown timed out." }),
      );
      expect(harness.app.quit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports rejected before-quit cleanup instead of dropping it", async () => {
    const harness = createHarness();
    harness.runtime.close.mockRejectedValueOnce(new Error("close failed"));
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    harness.app.emitBeforeQuit(preventableEvent());
    await vi.waitFor(() =>
      expect(harness.reportLifecycleFailure).toHaveBeenCalledWith(
        "quit",
        expect.any(AggregateError),
      ),
    );
  });

  it("does not reload owned connections during an active interview", async () => {
    const harness = createHarness({ state: activeState() });
    const controller = await startDesktopApplication(harness.options);
    await controller?.startupSettled;

    expect(await controller?.reloadConfiguration()).toBe("blocked");
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect(harness.browserSession.clear).not.toHaveBeenCalled();
  });
});

type TestPreventableEvent = PreventableEvent & {
  preventDefault: ReturnType<typeof vi.fn<() => void>>;
};

function preventableEvent(): TestPreventableEvent {
  return { preventDefault: vi.fn<() => void>() };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function activeState(): SessionState {
  const state = createSessionState({
    sessionId: "active",
    startedAt: "2026-08-26T12:00:00.000Z",
    capture: {
      mode: "recall",
      operationId: "11111111-2222-4333-8444-555555555555",
      status: "recording",
      authorization: {
        method: "operator_admission",
        state: "confirmed",
        admittedAt: "2026-08-26T12:00:10.000Z",
      },
      notice: {
        text: "Convo Caddy is recording and transcribing this conversation.",
        displayDurationMs: 10_000,
        delivery: "video_with_chat_fallback",
        state: "cleared",
        displayedAt: "2026-08-26T12:00:10.000Z",
        clearedAt: "2026-08-26T12:00:20.000Z",
        error: null,
      },
      provider: {
        name: "recall_ai",
        region: "us-west-2",
        botId: "bot-active",
        recordingId: "recording-active",
      },
      meetingPlatform: "microsoft_teams_personal",
      recording: {
        location: "recall_ai",
        retention: {
          requestedMedia: "none",
          providerConfirmed: false,
          accountMetadata: "unknown",
        },
      },
      lastEventAt: "2026-08-26T12:00:20.000Z",
      error: null,
    },
  });
  return state;
}

function createHarness(
  options: {
    primary?: boolean;
    state?: SessionState;
    startRuntime?: StartDesktopApplicationOptions["startRuntime"];
    confirmForceQuit?: (
      risk: Parameters<StartDesktopApplicationOptions["confirmForceQuit"]>[0],
    ) => Promise<boolean>;
    quitEmitsBeforeQuit?: boolean;
    quitCleanupTimeoutMs?: number;
  } = {},
) {
  const secondInstanceListeners: Array<() => void> = [];
  const activateListeners: Array<() => void> = [];
  const beforeQuitListeners: Array<(event: PreventableEvent) => void> = [];
  const quit = vi.fn<() => void>(() => {
    if (options.quitEmitsBeforeQuit) {
      for (const listener of beforeQuitListeners) listener(preventableEvent());
    }
  });
  const app: DesktopAppPort & {
    quit: typeof quit;
    emitSecondInstance(): void;
    emitBeforeQuit(event: PreventableEvent): void;
  } = {
    requestSingleInstanceLock: vi.fn(() => options.primary ?? true),
    enableSandbox: vi.fn(),
    whenReady: vi.fn(async () => undefined),
    quit,
    onSecondInstance: (listener) => secondInstanceListeners.push(listener),
    onActivate: (listener) => activateListeners.push(listener),
    onBeforeQuit: (listener) => beforeQuitListeners.push(listener),
    emitSecondInstance: () => {
      for (const listener of secondInstanceListeners) listener();
    },
    emitBeforeQuit: (event) => {
      for (const listener of beforeQuitListeners) listener(event);
    },
  };
  const closeListeners: Array<(event: PreventableEvent) => void> = [];
  const loadURL = vi.fn<(url: string) => Promise<void>>(async () => undefined);
  const show = vi.fn<() => void>();
  const focus = vi.fn<() => void>();
  const destroy = vi.fn<() => void>();
  const window: DesktopWindowPort & {
    loadURL: typeof loadURL;
    show: typeof show;
    focus: typeof focus;
    destroy: typeof destroy;
    emitClose(event: PreventableEvent): void;
  } = {
    loadURL,
    show,
    focus,
    restore: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    onClose: (listener) => closeListeners.push(listener),
    destroy,
    closeForQuit: vi.fn(async () => true),
    emitClose: (event) => {
      for (const listener of closeListeners) listener(event);
    },
  };
  const setCookie = vi.fn<DesktopBrowserSessionPort["setCookie"]>(
    async () => undefined,
  );
  const clear = vi.fn<DesktopBrowserSessionPort["clear"]>(
    async () => undefined,
  );
  const browserSession: DesktopBrowserSessionPort & {
    setCookie: typeof setCookie;
    clear: typeof clear;
  } = {
    setCookie,
    clear,
  };
  const update = vi.fn<DesktopBootstrapPort["update"]>();
  const closeBootstrap = vi.fn<DesktopBootstrapPort["close"]>(
    async () => undefined,
  );
  const bootstrap: DesktopBootstrapPort & {
    update: typeof update;
    close: typeof closeBootstrap;
  } = {
    url: "http://127.0.0.1:4301",
    update,
    close: closeBootstrap,
  };
  const createBootstrap = vi.fn(async () => bootstrap);
  const closeRuntime = vi.fn<DesktopRuntimePort["close"]>(
    async () => undefined,
  );
  const runtime: DesktopRuntimePort & {
    close: typeof closeRuntime;
  } = {
    mode: "normal",
    applicationUrl: "http://127.0.0.1:4317",
    getQuitRisk: () => {
      const state =
        options.state ??
        createSessionState({
          sessionId: "idle",
          startedAt: "2026-08-26T12:00:00.000Z",
        });
      return classifyQuitRisk(state);
    },
    close: closeRuntime,
  };
  const createWindow = vi.fn(() => window);
  const confirmForceQuit = vi.fn(
    options.confirmForceQuit ?? (async () => false),
  );
  const reportLifecycleFailure = vi.fn();
  const reportSecondInstanceFocus = vi.fn();
  const localApiAccess = new LocalApiAccess("b".repeat(43));

  return {
    app,
    bootstrap,
    browserSession,
    createBootstrap,
    runtime,
    window,
    createWindow,
    confirmForceQuit,
    reportLifecycleFailure,
    reportSecondInstanceFocus,
    options: {
      app,
      localApiAccess,
      createBootstrap,
      createBrowserSession: () => browserSession,
      createWindow,
      startRuntime: options.startRuntime ?? (async () => runtime),
      confirmForceQuit,
      quitCleanupTimeoutMs: options.quitCleanupTimeoutMs,
      reportLifecycleFailure,
      reportSecondInstanceFocus,
    },
  };
}

it("rechecks newly active capture before native close and keeps runtime on decline", async () => {
  const h = createHarness();
  const controller = await startDesktopApplication(h.options);
  await controller!.startupSettled;
  h.window.closeForQuit = async (...args: unknown[]) => {
    h.runtime.getQuitRisk = () => "active_interview";
    return args[0] ? await (args[0] as () => Promise<boolean>)() : true;
  };
  expect(await controller!.requestQuit()).toBe("blocked");
  expect(h.confirmForceQuit).toHaveBeenCalledWith("active_interview");
  expect(h.runtime.close).not.toHaveBeenCalled();
});
it("an extra window close during the draft decision is still intercepted", async () => {
  const h = createHarness();
  const controller = await startDesktopApplication(h.options);
  await controller!.startupSettled;
  h.window.closeForQuit = async () => {
    const event = preventableEvent();
    h.window.emitClose(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    return false;
  };
  expect(await controller!.requestQuit()).toBe("blocked");
  expect(h.runtime.close).not.toHaveBeenCalled();
});
