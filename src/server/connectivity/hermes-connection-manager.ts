import { createServer } from "node:net";
import { spawn } from "node:child_process";
import type {
  HermesIdentityRejection,
  HermesIdentityResult,
} from "./hermes-identity.js";
import { probeHermesIdentity } from "./hermes-identity.js";
import { isHermesSshTarget } from "./hermes-ssh-target.js";
import { parseHermesEndpoint } from "./hermes-endpoint.js";
import type { HermesEndpoint } from "./hermes-endpoint.js";

export type SshProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export interface OwnedSshProcess {
  readonly exited: Promise<SshProcessExit>;
  readonly forwardReady?: Promise<boolean>;
  terminate(): Promise<void>;
}

export interface SshProcessAdapter {
  spawn(input: { executable: "/usr/bin/ssh"; args: string[] }): OwnedSshProcess;
}

export type HermesConnectionDiagnostic =
  | "hermes_unavailable"
  | "hermes_health_mismatch"
  | "hermes_authentication_rejected"
  | "hermes_models_malformed"
  | "hermes_profile_not_advertised"
  | "hermes_transport_mismatch"
  | "ssh_forward_unavailable"
  | "ssh_start_failed"
  | "ssh_exited_before_ready"
  | "ssh_owned_forward_exited";

export type HermesConnectionStatus =
  | { state: "starting" }
  | { state: "local" }
  | { state: "reused" }
  | { state: "owned" }
  | { state: "unavailable"; diagnostic: HermesConnectionDiagnostic }
  | { state: "failed"; diagnostic: HermesConnectionDiagnostic };

export type HermesConnectionListener = (status: HermesConnectionStatus) => void;

export type HermesConnectionManager = {
  readonly settled: Promise<void>;
  snapshot(): HermesConnectionStatus;
  subscribe(listener: HermesConnectionListener): () => void;
  close(): Promise<void>;
};

type CommonOptions = {
  requireOwnedForward?: boolean;
  isPortAvailable?: (port: number) => Promise<boolean>;
  baseUrl: string;
  apiKey: string;
  profile: string;
  localPort: number;
  remotePort: number;
  processAdapter?: SshProcessAdapter;
  probeIdentity?: () => Promise<HermesIdentityResult>;
  delay?: (delayMs: number) => Promise<void>;
  readinessAttempts?: number;
  reconnectAttempts?: number;
  monitorIntervalMs?: number;
  monitorDelay?: (delayMs: number) => Promise<void>;
};

export type StartHermesConnectionManagerOptions = CommonOptions &
  ({ mode: "local"; sshTarget?: never } | { mode: "ssh"; sshTarget: string });

export function startHermesConnectionManager(
  options: StartHermesConnectionManagerOptions,
): HermesConnectionManager {
  return new DefaultHermesConnectionManager(options);
}

export function hermesSshArguments(input: {
  localPort: number;
  remotePort: number;
  sshTarget: string;
}): string[] {
  const localPort = validPort(input.localPort, "Hermes local port");
  const remotePort = validPort(input.remotePort, "Hermes remote port");
  if (!isHermesSshTarget(input.sshTarget)) {
    throw new Error("Hermes SSH target has an invalid format.");
  }
  return [
    "-F",
    "none",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "GatewayPorts=no",
    "-o",
    "RemoteCommand=none",
    "-o",
    "RequestTTY=no",
    "-o",
    "SessionType=none",
    "-o",
    "Tunnel=no",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-N",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    input.sshTarget,
  ];
}

class DefaultHermesConnectionManager implements HermesConnectionManager {
  readonly settled: Promise<void>;
  readonly #options: StartHermesConnectionManagerOptions;
  readonly #processAdapter: SshProcessAdapter;
  readonly #probeIdentity: () => Promise<HermesIdentityResult>;
  readonly #delay: (delayMs: number) => Promise<void>;
  readonly #readinessAttempts: number;
  readonly #reconnectAttempts: number;
  readonly #monitorIntervalMs: number;
  readonly #monitorDelay: (delayMs: number) => Promise<void>;
  readonly #listeners = new Set<HermesConnectionListener>();
  readonly #activeProbes = new Set<Promise<HermesIdentityResult>>();
  #status: HermesConnectionStatus = { state: "starting" };
  #ownedProcess: OwnedSshProcess | null = null;
  #reconnecting = false;
  #reconnectFailure: HermesConnectionStatus | null = null;
  #closed = false;

  constructor(options: StartHermesConnectionManagerOptions) {
    this.#options = options;
    requireValue(options.apiKey, "Hermes API key");
    requireValue(options.profile, "Hermes profile");
    validPort(options.localPort, "Hermes local port");
    validPort(options.remotePort, "Hermes remote port");
    assertMatchingLoopbackBaseUrl(options.baseUrl, options.localPort);
    if (options.mode === "ssh") {
      hermesSshArguments(options);
    }
    this.#processAdapter =
      options.processAdapter ?? new NodeSshProcessAdapter();
    this.#probeIdentity =
      options.probeIdentity ??
      (() =>
        probeHermesIdentity({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          model: options.profile,
          timeoutMs: 1_500,
        }));
    this.#delay = options.delay ?? defaultDelay;
    this.#readinessAttempts = positiveInteger(
      options.readinessAttempts ?? 20,
      "Hermes readiness attempts",
    );
    this.#reconnectAttempts = nonnegativeInteger(
      options.reconnectAttempts ?? 3,
      "Hermes reconnect attempts",
    );
    this.#monitorIntervalMs = positiveInteger(
      options.monitorIntervalMs ?? 15_000,
      "Hermes monitor interval",
    );
    this.#monitorDelay = options.monitorDelay ?? unrefDelay;
    this.settled = this.#connectInitial();
  }

  snapshot(): HermesConnectionStatus {
    return { ...this.#status };
  }

  subscribe(listener: HermesConnectionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const ownedProcess = this.#ownedProcess;
    this.#ownedProcess = null;
    if (ownedProcess) {
      await ownedProcess.terminate();
    }
    await this.settled;
    await Promise.allSettled([...this.#activeProbes]);
    this.#listeners.clear();
  }

  async #connectInitial(): Promise<void> {
    if (this.#options.mode === "local") {
      await this.#connectLocal();
      return;
    }
    await this.#connectSsh();
  }

  async #connectLocal(): Promise<void> {
    this.#publish({ state: "starting" });
    const identity = await this.#safeProbe();
    if (this.#closed) {
      return;
    }
    this.#publishLocalIdentity(identity);
    void this.#monitorLocal();
  }

  #publishLocalIdentity(identity: HermesIdentityResult): void {
    if (identity.kind === "verified") {
      this.#publish({ state: "local" });
      return;
    }
    if (identity.kind === "absent") {
      this.#publish({
        state: "unavailable",
        diagnostic: "hermes_unavailable",
      });
      return;
    }
    this.#publish({
      state: "failed",
      diagnostic: diagnosticForRejection(identity.reason),
    });
  }

  async #monitorLocal(): Promise<void> {
    while (!this.#closed && this.#options.mode === "local") {
      await this.#monitorDelay(this.#monitorIntervalMs);
      if (this.#closed) {
        return;
      }
      this.#publishLocalIdentity(await this.#safeProbe());
    }
  }

  async #connectSsh(): Promise<void> {
    if (this.#closed || this.#options.mode !== "ssh") {
      return;
    }
    this.#publish({ state: "starting" });
    if (this.#options.requireOwnedForward) {
      const available = await (
        this.#options.isPortAvailable ?? isLoopbackPortAvailable
      )(this.#options.localPort);
      if (this.#closed) return;
      if (!available) {
        this.#publish({
          state: "failed",
          diagnostic: "ssh_forward_unavailable",
        });
        return;
      }
    } else {
      const identity = await this.#safeProbe();
      if (this.#closed) return;
      if (identity.kind === "verified") {
        this.#publish({ state: "reused" });
        void this.#monitorReused();
        return;
      }
      if (identity.kind === "rejected") {
        this.#publish({
          state: "failed",
          diagnostic: diagnosticForRejection(identity.reason),
        });
        return;
      }
    }

    let child: OwnedSshProcess;
    try {
      child = this.#processAdapter.spawn({
        executable: "/usr/bin/ssh",
        args: this.#options.requireOwnedForward
          ? ["-v", ...hermesSshArguments(this.#options)]
          : hermesSshArguments(this.#options),
      });
    } catch {
      this.#publish({ state: "failed", diagnostic: "ssh_start_failed" });
      return;
    }
    let childExited = false;
    const childExit = child.exited.then((exit) => {
      childExited = true;
      return exit;
    });
    this.#ownedProcess = child;
    const ready = await this.#waitForOwnedForward(
      child,
      childExit,
      () => childExited,
    );
    if (!ready || this.#closed) {
      if (this.#ownedProcess === child) {
        this.#ownedProcess = null;
      }
      if (!this.#closed) {
        await child.terminate();
      }
      return;
    }
    void childExit.then(() => this.#handleOwnedExit(child));
    this.#publish({ state: "owned" });
    void this.#monitorOwned(child);
  }

  async #waitForOwnedForward(
    child: OwnedSshProcess,
    childExit: Promise<SshProcessExit>,
    hasExited: () => boolean,
  ): Promise<boolean> {
    let bound = false;
    let bindFailed = false;
    void child.forwardReady?.then((ready) => {
      bound = ready;
      bindFailed = !ready;
    });
    for (let attempt = 0; attempt < this.#readinessAttempts; attempt += 1) {
      const outcome = await Promise.race([
        childExit.then(() => "exited" as const),
        this.#delay(Math.min(100 * 2 ** attempt, 1_000)).then(
          () => "probe" as const,
        ),
      ]);
      if (outcome === "exited") {
        this.#publish({
          state: "failed",
          diagnostic: "ssh_exited_before_ready",
        });
        return false;
      }
      if (this.#closed) {
        return false;
      }
      if (this.#options.requireOwnedForward && !bound) {
        if (bindFailed) {
          this.#publish({
            state: "failed",
            diagnostic: "ssh_exited_before_ready",
          });
          return false;
        }
        continue;
      }
      const identity = await this.#safeProbe();
      if (this.#closed || this.#ownedProcess !== child) {
        return false;
      }
      if (hasExited()) {
        this.#publish({
          state: "failed",
          diagnostic: "ssh_exited_before_ready",
        });
        return false;
      }
      if (identity.kind === "verified") {
        return true;
      }
      if (identity.kind === "rejected") {
        this.#publish({
          state: "failed",
          diagnostic: diagnosticForRejection(identity.reason),
        });
        return false;
      }
    }
    this.#publish({ state: "failed", diagnostic: "ssh_start_failed" });
    return false;
  }

  async #monitorReused(): Promise<void> {
    while (!this.#closed && this.#status.state === "reused") {
      await this.#monitorDelay(this.#monitorIntervalMs);
      if (this.#closed || this.#status.state !== "reused") {
        return;
      }
      const identity = await this.#safeProbe();
      if (identity.kind === "verified") {
        continue;
      }
      if (identity.kind === "rejected") {
        this.#publish({
          state: "failed",
          diagnostic: diagnosticForRejection(identity.reason),
        });
        return;
      }
      this.#publish({
        state: "unavailable",
        diagnostic: "hermes_unavailable",
      });
      await this.#reconnect();
      return;
    }
  }

  async #monitorOwned(child: OwnedSshProcess): Promise<void> {
    while (!this.#closed && this.#ownedProcess === child) {
      await this.#monitorDelay(this.#monitorIntervalMs);
      if (this.#closed || this.#ownedProcess !== child) {
        return;
      }
      const identity = await this.#safeProbe();
      if (this.#closed || this.#ownedProcess !== child) {
        return;
      }
      if (identity.kind === "verified") {
        this.#publish({ state: "owned" });
      } else if (identity.kind === "absent") {
        this.#publish({
          state: "unavailable",
          diagnostic: "hermes_unavailable",
        });
      } else {
        this.#publish({
          state: "failed",
          diagnostic: diagnosticForRejection(identity.reason),
        });
      }
    }
  }

  async #reconnect(): Promise<void> {
    if (this.#reconnecting || this.#closed) return;
    this.#reconnecting = true;
    this.#reconnectFailure = null;
    try {
      this.#publish({ state: "starting" });
      for (let attempt = 0; attempt < this.#reconnectAttempts; attempt += 1) {
        await this.#delay(Math.min(500 * 2 ** attempt, 5_000));
        if (this.#closed) return;
        await this.#connectSsh();
        if (this.#status.state === "owned" || this.#status.state === "reused")
          return;
      }
    } finally {
      this.#reconnecting = false;
      if (
        !this.#closed &&
        this.#status.state !== "owned" &&
        this.#status.state !== "reused"
      ) {
        this.#publish(
          this.#reconnectFailure ?? {
            state: "failed",
            diagnostic: "ssh_owned_forward_exited",
          },
        );
      }
    }
  }

  async #handleOwnedExit(child: OwnedSshProcess): Promise<void> {
    if (this.#closed || this.#ownedProcess !== child) {
      return;
    }
    this.#ownedProcess = null;
    this.#publish({
      state: "unavailable",
      diagnostic: "ssh_owned_forward_exited",
    });
    await this.#reconnect();
  }

  async #safeProbe(): Promise<HermesIdentityResult> {
    const probe = this.#probeIdentity();
    this.#activeProbes.add(probe);
    try {
      return await probe;
    } catch {
      return { kind: "rejected", reason: "transport_mismatch" };
    } finally {
      this.#activeProbes.delete(probe);
    }
  }

  #publish(status: HermesConnectionStatus): void {
    if (this.#closed) {
      return;
    }
    if (
      this.#reconnecting &&
      (status.state === "failed" || status.state === "unavailable")
    ) {
      this.#reconnectFailure = status;
      return;
    }
    this.#status = status;
    for (const listener of this.#listeners) {
      listener(this.snapshot());
    }
  }
}

class NodeSshProcessAdapter implements SshProcessAdapter {
  spawn(input: {
    executable: "/usr/bin/ssh";
    args: string[];
  }): OwnedSshProcess {
    const child = spawn(input.executable, input.args, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let exited = false;
    let confirmForward!: (ready: boolean) => void;
    const forwardReady = new Promise<boolean>((resolve) => {
      confirmForward = resolve;
    });
    const bindProof = input.args.includes("-v");
    const forward = input.args[input.args.indexOf("-L") + 1] ?? "";
    const localPort = forward.split(":")[1];
    let pendingLine = "",
      sawAddress = false;
    const exitPromise = new Promise<SshProcessExit>((resolve) => {
      child.once("error", () => {
        exited = true;
        confirmForward(false);
        resolve({ code: null, signal: null });
      });
      child.once("exit", (code, signal) => {
        exited = true;
        confirmForward(false);
        resolve({ code, signal });
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!bindProof) return;
      // Only a bounded line buffer; never log or expose stderr. OpenSSH emits
      // the address before bind(), then the port-listener channel AFTER listen().
      for (const character of chunk.toString("utf8")) {
        if (character !== "\n") {
          pendingLine = (pendingLine + character).slice(-1024);
          continue;
        }
        if (
          pendingLine.trim() ===
          `debug1: Local forwarding listening on 127.0.0.1 port ${localPort}.`
        )
          sawAddress = true;
        if (
          sawAddress &&
          /^debug1: channel [0-9]+: new port-listener \[port listener\]/.test(
            pendingLine,
          )
        )
          confirmForward(true);
        pendingLine = "";
      }
    });
    return {
      exited: exitPromise,
      ...(bindProof ? { forwardReady } : {}),
      async terminate() {
        if (exited) {
          return;
        }
        child.kill("SIGTERM");
        const outcome = await Promise.race([
          exitPromise.then(() => "exited" as const),
          defaultDelay(2_000).then(() => "timed_out" as const),
        ]);
        if (outcome === "timed_out" && !exited) {
          child.kill("SIGKILL");
          await exitPromise;
        }
      },
    };
  }
}

function diagnosticForRejection(
  rejection: HermesIdentityRejection,
): HermesConnectionDiagnostic {
  return {
    health_mismatch: "hermes_health_mismatch",
    authentication_rejected: "hermes_authentication_rejected",
    models_malformed: "hermes_models_malformed",
    profile_not_advertised: "hermes_profile_not_advertised",
    transport_mismatch: "hermes_transport_mismatch",
  }[rejection] as HermesConnectionDiagnostic;
}

function defaultDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function unrefDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function requireValue(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty.`);
  }
  return value;
}

function validPort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be an integer from 1 through 65535.`);
  }
  return value;
}

function assertMatchingLoopbackBaseUrl(value: string, localPort: number): void {
  let url: HermesEndpoint;
  try {
    url = parseHermesEndpoint(value);
  } catch {
    throw new Error("Hermes base URL must match the configured loopback port.");
  }
  if (url.hostname !== "127.0.0.1" || url.port !== localPort) {
    throw new Error("Hermes base URL must match the configured loopback port.");
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => resolve(!error));
    });
  });
}
