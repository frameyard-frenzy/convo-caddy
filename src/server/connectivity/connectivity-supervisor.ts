import type { SessionState } from "../../domain/types.js";
import type {
  RecallReconciliationResult,
  SessionListener,
} from "../session-service.js";
import {
  startHermesConnectionManager,
  type HermesConnectionManager,
  type HermesConnectionStatus,
  type StartHermesConnectionManagerOptions,
} from "./hermes-connection-manager.js";
import type { HermesDispatchAuthority } from "../marty/hermes-dispatch-authority.js";
import {
  NgrokEndpointError,
  startNgrokEndpoint,
  type NgrokEndpoint,
  type NgrokEndpointStatus,
  type StartNgrokEndpointOptions,
} from "./ngrok-endpoint-manager.js";
import {
  RuntimeReadinessStore,
  type RuntimeDiagnosticCode,
} from "./readiness.js";

export type ConnectivityConfig = {
  ngrok: {
    authtoken: string;
    approvedDomain: string;
  };
  hermes:
    | { kind: "unavailable" }
    | {
        kind: "configured";
        mode: "local" | "ssh";
        baseUrl: string;
        apiKey: string;
        profile: string;
        localPort: number;
        remotePort: number;
        sshTarget: string | null;
        dispatchAuthority: HermesDispatchAuthority;
      };
};

export interface ConnectivitySession {
  getSnapshot(): SessionState;
  subscribe(listener: SessionListener): () => void;
  setRecallCaptureAvailable(available: boolean): void;
  reconcileRecallCapture(): Promise<RecallReconciliationResult>;
}

export type ConnectivityDependencies = {
  startNgrokEndpoint?: (
    options: StartNgrokEndpointOptions,
  ) => Promise<NgrokEndpoint>;
  startHermesConnectionManager?: (
    options: StartHermesConnectionManagerOptions,
  ) => HermesConnectionManager;
};

export type StartConnectivitySupervisorOptions = {
  config: ConnectivityConfig;
  webhook: { host: "127.0.0.1"; port: number };
  session: ConnectivitySession;
  dependencies?: ConnectivityDependencies;
};

export type ConnectivitySupervisor = {
  readiness: RuntimeReadinessStore;
  settled: Promise<void>;
  retryHermes(): Promise<void>;
  close(): Promise<void>;
};

export function startConnectivitySupervisor(
  options: StartConnectivitySupervisorOptions,
): ConnectivitySupervisor {
  return new DefaultConnectivitySupervisor(options);
}

class DefaultConnectivitySupervisor implements ConnectivitySupervisor {
  readonly readiness: RuntimeReadinessStore;
  readonly settled: Promise<void>;
  readonly #options: StartConnectivitySupervisorOptions;
  readonly #startNgrokEndpoint: NonNullable<
    ConnectivityDependencies["startNgrokEndpoint"]
  >;
  readonly #unsubscribeSession: () => void;
  #unsubscribeHermes: (() => void) | null = null;
  #unsubscribeNgrok: (() => void) | null = null;
  #ngrokEndpoint: NgrokEndpoint | null = null;
  #ngrokPendingOwnershipRelease: Promise<boolean> | null = null;
  #hermesManager: HermesConnectionManager | null = null;
  #ngrokReady = false;
  #reconciliationComplete = false;
  #reconciliationBlocked = false;
  #reconciliationStarted = false;
  #reconciliationPromise: Promise<void> | null = null;
  #hermesRevision = 0;
  #retryPromise: Promise<void> | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: StartConnectivitySupervisorOptions) {
    if (
      options.webhook.host !== "127.0.0.1" ||
      !Number.isInteger(options.webhook.port) ||
      options.webhook.port <= 0
    ) {
      throw new Error(
        "Connectivity supervision requires the assigned loopback webhook listener.",
      );
    }
    this.#options = options;
    options.session.setRecallCaptureAvailable(false);
    this.#startNgrokEndpoint =
      options.dependencies?.startNgrokEndpoint ?? startNgrokEndpoint;
    this.readiness = new RuntimeReadinessStore({
      configuration: "ready",
      workspace: "ready",
      appServer: "ready",
      webhookServer: "ready",
      ngrok: "starting",
      hermesTunnel:
        options.config.hermes.kind === "configured"
          ? "starting"
          : "unavailable",
      hermes: "unavailable",
      capture: captureComponent(options.session.getSnapshot(), false),
    });
    this.#unsubscribeSession = options.session.subscribe((state) => {
      this.#updateCapture(state);
    });

    const ngrokStartup = this.#startNgrok();
    const hermesStartup = this.#startHermes();
    this.settled = Promise.allSettled([ngrokStartup, hermesStartup]).then(
      () => undefined,
    );
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  retryHermes(): Promise<void> {
    if (this.#retryPromise) return this.#retryPromise;
    const state = this.readiness.snapshot().components.hermesTunnel;
    if (
      this.#closed ||
      this.#options.config.hermes.kind !== "configured" ||
      !["failed", "unavailable"].includes(state)
    )
      return Promise.resolve();
    this.#retryPromise = this.#retryHermes().finally(() => {
      this.#retryPromise = null;
    });
    return this.#retryPromise;
  }

  async #retryHermes(): Promise<void> {
    const config = this.#options.config.hermes;
    if (config.kind !== "configured") return;
    this.#hermesRevision++;
    config.dispatchAuthority.markUnavailable();
    this.readiness.update({ hermesTunnel: "starting", hermes: "unavailable" });
    this.#unsubscribeHermes?.();
    this.#unsubscribeHermes = null;
    const previous = this.#hermesManager;
    try {
      await config.dispatchAuthority.drain();
      await previous?.close();
      if (this.#hermesManager === previous) this.#hermesManager = null;
      if (!this.#closed) await this.#startHermes();
    } catch {
      if (!this.#closed) {
        this.readiness.update({
          hermesTunnel: "failed",
          hermes: "unavailable",
        });
        this.readiness.report("hermesTunnel", "ssh_start_failed");
      }
    }
  }

  async #startNgrok(): Promise<void> {
    try {
      const endpoint = await this.#startNgrokEndpoint({
        authtoken: this.#options.config.ngrok.authtoken,
        approvedDomain: this.#options.config.ngrok.approvedDomain,
        webhook: {
          host: "127.0.0.1",
          port: this.#options.webhook.port,
        },
      });
      if (this.#closed) {
        await endpoint.close();
        return;
      }
      this.#ngrokEndpoint = endpoint;
      this.#unsubscribeNgrok = endpoint.subscribe((status) => {
        this.#applyNgrokStatus(status);
      });
      this.#applyNgrokStatus(endpoint.snapshot());
      await (this.#reconciliationPromise ?? Promise.resolve());
    } catch (error) {
      if (
        error instanceof NgrokEndpointError &&
        error.pendingOwnershipRelease !== null
      ) {
        this.#ngrokPendingOwnershipRelease = error.pendingOwnershipRelease;
      }
      if (this.#closed) {
        return;
      }
      this.#ngrokReady = false;
      this.readiness.update({ ngrok: "failed", capture: "disabled" });
      this.readiness.report("ngrok", ngrokDiagnostic(error));
    }
  }

  async #startHermes(): Promise<void> {
    const revision = ++this.#hermesRevision;
    const config = this.#options.config.hermes;
    if (config.kind === "unavailable") {
      this.readiness.update({
        hermesTunnel: "unavailable",
        hermes: "unavailable",
      });
      this.readiness.report("hermes", "hermes_unavailable");
      return;
    }

    config.dispatchAuthority.markUnavailable();

    try {
      const createManager =
        this.#options.dependencies?.startHermesConnectionManager ??
        startHermesConnectionManager;
      const common = {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        profile: config.profile,
        localPort: config.localPort,
        remotePort: config.remotePort,
      };
      const manager =
        config.mode === "local"
          ? createManager({ ...common, mode: "local" })
          : createManager({
              ...common,
              mode: "ssh",
              sshTarget: config.sshTarget ?? "",
            });
      this.#hermesManager = manager;
      this.#applyHermesStatus(manager.snapshot());
      this.#unsubscribeHermes = manager.subscribe((status) => {
        if (revision === this.#hermesRevision) this.#applyHermesStatus(status);
      });
      await manager.settled;
      if (revision === this.#hermesRevision)
        this.#applyHermesStatus(manager.snapshot());
    } catch {
      if (revision !== this.#hermesRevision || this.#closed) return;
      config.dispatchAuthority.markUnavailable();
      this.readiness.update({
        hermesTunnel: "failed",
        hermes: "unavailable",
      });
      this.readiness.report("hermesTunnel", "ssh_start_failed");
    }
  }

  async #reconcileRecall(): Promise<void> {
    try {
      const result = await this.#options.session.reconcileRecallCapture();
      if (result.kind !== "needs_attention") {
        this.#reconciliationComplete = true;
        this.#updateCapture(this.#options.session.getSnapshot());
        return;
      }
      this.#reconciliationBlocked = true;
      this.#options.session.setRecallCaptureAvailable(false);
      this.readiness.update({ capture: "needs_attention" });
      this.readiness.report("capture", result.diagnostic);
    } catch {
      this.#reconciliationBlocked = true;
      this.#options.session.setRecallCaptureAvailable(false);
      this.readiness.update({ capture: "needs_attention" });
      this.readiness.report("capture", "recall_reconciliation_failed");
    }
  }

  #ensureRecallReconciliation(): Promise<void> {
    if (!this.#reconciliationStarted) {
      this.#reconciliationStarted = true;
      this.#reconciliationPromise = this.#reconcileRecall();
    }
    return this.#reconciliationPromise ?? Promise.resolve();
  }

  #applyNgrokStatus(status: NgrokEndpointStatus): void {
    if (this.#closed) {
      return;
    }
    if (status === "ready") {
      this.#ngrokReady = true;
      this.readiness.clear("ngrok");
      this.readiness.update({ ngrok: "ready" });
      this.#updateCapture(this.#options.session.getSnapshot());
      void this.#ensureRecallReconciliation().then(() => {
        if (!this.#closed && this.#ngrokReady && !this.#reconciliationBlocked) {
          this.#options.session.setRecallCaptureAvailable(true);
        }
      });
      return;
    }
    this.#ngrokReady = false;
    this.#options.session.setRecallCaptureAvailable(false);
    if (status === "reconnecting") {
      this.readiness.update({ ngrok: "reconnecting" });
      this.readiness.report("ngrok", "ngrok_reconnecting");
      this.#updateCapture(this.#options.session.getSnapshot());
      return;
    }
    this.readiness.clear("ngrok");
    this.readiness.update({ ngrok: "failed", capture: "disabled" });
    this.readiness.report("ngrok", "ngrok_transport_failed");
  }

  #applyHermesStatus(status: HermesConnectionStatus): void {
    if (this.#closed) {
      return;
    }
    const config = this.#options.config.hermes;
    if (
      status.state === "local" ||
      status.state === "owned" ||
      status.state === "reused"
    ) {
      if (config.kind === "configured") {
        config.dispatchAuthority.markReady();
      }
      this.readiness.clear("hermesTunnel");
      this.readiness.clear("hermes");
      this.readiness.update({
        hermesTunnel: status.state,
        hermes: "ready",
      });
      return;
    }
    if (config.kind === "configured") {
      config.dispatchAuthority.markUnavailable();
    }
    if (status.state === "starting") {
      this.readiness.update({
        hermesTunnel: "starting",
        hermes: "unavailable",
      });
      return;
    }
    this.readiness.update({
      hermesTunnel: status.state,
      hermes: "unavailable",
    });
    this.readiness.report("hermesTunnel", status.diagnostic);
  }

  #updateCapture(state: SessionState): void {
    this.readiness.update({
      capture: this.#reconciliationBlocked
        ? "needs_attention"
        : captureComponent(
            state,
            this.#ngrokReady,
            this.#reconciliationComplete,
          ),
    });
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#options.session.setRecallCaptureAvailable(false);
    this.#unsubscribeSession();
    this.#unsubscribeHermes?.();
    this.#unsubscribeNgrok?.();
    const errors: unknown[] = [];
    const hermesConfig = this.#options.config.hermes;
    if (hermesConfig.kind === "configured") {
      try {
        await hermesConfig.dispatchAuthority.closeAndDrain();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const close of [
      () => this.#hermesManager?.close() ?? Promise.resolve(),
      () => this.#ngrokEndpoint?.close() ?? Promise.resolve(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    await this.settled;
    await this.#retryPromise;
    if (this.#ngrokPendingOwnershipRelease !== null) {
      const released = await this.#ngrokPendingOwnershipRelease;
      if (!released) {
        errors.push(
          new Error("ngrok endpoint ownership release could not be confirmed."),
        );
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Connectivity shutdown failed.");
    }
  }
}

function captureComponent(
  state: SessionState,
  ngrokReady: boolean,
  reconciliationComplete = true,
): "disabled" | "ready" | "active" | "finalizing" | "needs_attention" {
  const finalization = state.lifecycle.finalization.state;
  if (!reconciliationComplete) {
    return "disabled";
  }
  if (finalization === "needs_attention") {
    return "needs_attention";
  }
  if (finalization === "complete") {
    return ngrokReady ? "ready" : "disabled";
  }
  if (state.capture.mode === "recall") {
    if (state.capture.status === "failed") {
      return "needs_attention";
    }
    if (
      finalization === "waiting_for_provider" ||
      finalization === "finalizing" ||
      state.capture.status === "ended"
    ) {
      return "finalizing";
    }
    return "active";
  }
  return ngrokReady ? "ready" : "disabled";
}

function ngrokDiagnostic(error: unknown): RuntimeDiagnosticCode {
  return error instanceof Error &&
    "code" in error &&
    error.code === "ngrok_domain_mismatch"
    ? "ngrok_domain_mismatch"
    : "ngrok_start_failed";
}
