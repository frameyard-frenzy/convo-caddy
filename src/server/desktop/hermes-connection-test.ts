import { randomUUID } from "node:crypto";
import {
  startHermesConnectionManager,
  type HermesConnectionManager,
  type HermesConnectionStatus,
  type StartHermesConnectionManagerOptions,
} from "../connectivity/hermes-connection-manager.js";
import {
  discoverHermesProfiles,
  type HermesIdentityResult,
  type HermesProfileDiscoveryResult,
} from "../connectivity/hermes-identity.js";
import { HermesDispatchAuthority } from "../marty/hermes-dispatch-authority.js";
import { HermesMartyProvider } from "../marty/hermes-marty-provider.js";
import type { MartyContext, MartyProvider } from "../marty/marty-provider.js";

export type HermesSetupConnection = {
  generation: string;
  mode: "local" | "ssh";
  baseUrl: string;
  localPort: number;
  remotePort: number;
  sshTarget: string | null;
  apiKey: string;
};

export type HermesProfileDiscoveryTestResult =
  | { generation: string; state: "profiles_advertised"; profiles: string[] }
  | {
      generation: string;
      state:
        | "authentication_rejected"
        | "identity_rejected"
        | "models_rejected"
        | "unavailable"
        | "ssh_failed"
        | "forwarding_unavailable"
        | "transport_unknown";
    };

export type HermesAssistantConnectionTestResult = {
  generation: string;
  state:
    | "assistant_verified_synthetic"
    | "profile_not_advertised"
    | "response_rejected"
    | "authentication_rejected"
    | "identity_rejected"
    | "models_rejected"
    | "unavailable"
    | "ssh_failed"
    | "forwarding_unavailable"
    | "transport_unknown";
};

export class HermesConnectionTestError extends Error {
  constructor(
    readonly code: "test_in_progress" | "cleanup_failed",
    message: string,
  ) {
    super(message);
    this.name = "HermesConnectionTestError";
  }
}

export type HermesConnectionTesterDependencies = {
  startConnectionManager?: (
    options: StartHermesConnectionManagerOptions,
  ) => HermesConnectionManager;
  discoverProfiles?: typeof discoverHermesProfiles;
  createProvider?: (
    options: ConstructorParameters<typeof HermesMartyProvider>[0],
  ) => Pick<MartyProvider, "ask">;
};

export class HermesConnectionTester {
  readonly #dependencies: HermesConnectionTesterDependencies;
  #running = false;
  #cleanupBlocked = false;

  constructor(dependencies: HermesConnectionTesterDependencies = {}) {
    this.#dependencies = dependencies;
  }

  discover(
    input: HermesSetupConnection,
  ): Promise<HermesProfileDiscoveryTestResult> {
    return this.#exclusive(async (ownManager) => {
      const observed: { discovery: HermesProfileDiscoveryResult } = {
        discovery: { kind: "absent" },
      };
      const manager = ownManager(
        this.#managerOptions(input, "setup-discovery", async () => {
          observed.discovery = await (
            this.#dependencies.discoverProfiles ?? discoverHermesProfiles
          )({
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            timeoutMs: 1_500,
          });
          return identityFromDiscovery(observed.discovery);
        }),
      );
      await manager.settled;
      if (
        isReady(manager.snapshot()) &&
        observed.discovery.kind === "advertised"
      ) {
        return {
          generation: input.generation,
          state: "profiles_advertised",
          profiles: observed.discovery.profiles,
        };
      }
      return discoveryFailure(
        input.generation,
        observed.discovery,
        manager.snapshot(),
      );
    });
  }

  testAssistant(
    input: HermesSetupConnection & { profile: string },
  ): Promise<HermesAssistantConnectionTestResult> {
    return this.#exclusive(async (ownManager) => {
      const authority = new HermesDispatchAuthority();
      const manager = ownManager(this.#managerOptions(input, input.profile));
      await manager.settled;
      const status = manager.snapshot();
      if (!isReady(status)) {
        return assistantFailure(input.generation, status);
      }
      authority.markReady();
      const unsubscribe = manager.subscribe((nextStatus) => {
        if (isReady(nextStatus)) {
          authority.markReady();
        } else {
          authority.markUnavailable();
        }
      });
      const provider = (
        this.#dependencies.createProvider ??
        ((options) => new HermesMartyProvider(options))
      )({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.profile,
        maxInputBytes: 4_096,
        timeoutMs: 30_000,
        dispatchAuthority: authority,
      });
      try {
        await provider.ask(
          "Confirm this synthetic Convo Caddy connection check with no citations.",
          SYNTHETIC_CONTEXT,
          { idempotencyKey: `setup-${randomUUID()}` },
        );
      } catch {
        return {
          generation: input.generation,
          state: "response_rejected",
        };
      } finally {
        unsubscribe();
        authority.markUnavailable();
        await authority.closeAndDrain();
      }
      return {
        generation: input.generation,
        state: "assistant_verified_synthetic",
      };
    });
  }

  async #exclusive<T>(
    operation: (
      ownManager: (
        options: StartHermesConnectionManagerOptions,
      ) => HermesConnectionManager,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.#running) {
      throw new HermesConnectionTestError(
        "test_in_progress",
        "A Hermes connection operation is already in progress.",
      );
    }
    if (this.#cleanupBlocked) {
      throw new HermesConnectionTestError(
        "cleanup_failed",
        "Hermes connection cleanup is not confirmed.",
      );
    }
    this.#running = true;
    const owned: { manager: HermesConnectionManager | null } = {
      manager: null,
    };
    let outcome:
      | { kind: "success"; value: T }
      | { kind: "failure"; error: unknown };
    try {
      const value = await operation((options) => {
        if (owned.manager !== null) {
          throw new Error(
            "A setup operation may own only one Hermes connection.",
          );
        }
        owned.manager = (
          this.#dependencies.startConnectionManager ??
          startHermesConnectionManager
        )(options);
        return owned.manager;
      });
      outcome = { kind: "success", value };
    } catch (error) {
      outcome = { kind: "failure", error };
    }
    try {
      await owned.manager?.close();
    } catch {
      this.#cleanupBlocked = true;
      this.#running = false;
      throw new HermesConnectionTestError(
        "cleanup_failed",
        "Hermes connection cleanup could not be confirmed.",
      );
    }
    this.#running = false;
    if (outcome.kind === "failure") {
      throw outcome.error;
    }
    return outcome.value;
  }

  #managerOptions(
    input: HermesSetupConnection,
    profile: string,
    probeIdentity?: () => Promise<HermesIdentityResult>,
  ): StartHermesConnectionManagerOptions {
    const common = {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      profile,
      localPort: input.localPort,
      remotePort: input.remotePort,
      ...(probeIdentity ? { probeIdentity } : {}),
    };
    return input.mode === "local"
      ? { ...common, mode: "local" }
      : {
          ...common,
          mode: "ssh",
          requireOwnedForward: true,
          reconnectAttempts: 0,
          sshTarget: input.sshTarget ?? "",
        };
  }
}

function identityFromDiscovery(
  discovery: HermesProfileDiscoveryResult,
): HermesIdentityResult {
  if (discovery.kind === "advertised") {
    return { kind: "verified" };
  }
  return discovery;
}

function isReady(status: HermesConnectionStatus): boolean {
  return ["local", "reused", "owned"].includes(status.state);
}

function discoveryFailure(
  generation: string,
  discovery: HermesProfileDiscoveryResult,
  status: HermesConnectionStatus,
): HermesProfileDiscoveryTestResult {
  if (discovery.kind === "rejected") {
    return {
      generation,
      state: discoveryState(discovery.reason),
    };
  }
  return {
    generation,
    state:
      "diagnostic" in status
        ? diagnosticState(status.diagnostic)
        : "unavailable",
  };
}

function assistantFailure(
  generation: string,
  status: HermesConnectionStatus,
): HermesAssistantConnectionTestResult {
  return {
    generation,
    state:
      "diagnostic" in status
        ? assistantDiagnosticState(status.diagnostic)
        : "unavailable",
  };
}

function discoveryState(
  reason: Exclude<
    HermesIdentityResult,
    { kind: "absent" } | { kind: "verified" }
  >["reason"],
): Exclude<HermesProfileDiscoveryTestResult["state"], "profiles_advertised"> {
  return {
    health_mismatch: "identity_rejected",
    authentication_rejected: "authentication_rejected",
    models_malformed: "models_rejected",
    profile_not_advertised: "models_rejected",
    transport_mismatch: "transport_unknown",
  }[reason] as Exclude<
    HermesProfileDiscoveryTestResult["state"],
    "profiles_advertised"
  >;
}

function diagnosticState(
  diagnostic: Extract<
    HermesConnectionStatus,
    { state: "failed" | "unavailable" }
  >["diagnostic"],
): Exclude<HermesProfileDiscoveryTestResult["state"], "profiles_advertised"> {
  return {
    hermes_authentication_rejected: "authentication_rejected",
    hermes_health_mismatch: "identity_rejected",
    hermes_models_malformed: "models_rejected",
    hermes_profile_not_advertised: "models_rejected",
    hermes_transport_mismatch: "transport_unknown",
    ssh_forward_unavailable: "forwarding_unavailable",
    hermes_unavailable: "unavailable",
    ssh_exited_before_ready: "ssh_failed",
    ssh_owned_forward_exited: "ssh_failed",
    ssh_start_failed: "ssh_failed",
  }[diagnostic] as Exclude<
    HermesProfileDiscoveryTestResult["state"],
    "profiles_advertised"
  >;
}

function assistantDiagnosticState(
  diagnostic: Extract<
    HermesConnectionStatus,
    { state: "failed" | "unavailable" }
  >["diagnostic"],
): HermesAssistantConnectionTestResult["state"] {
  if (diagnostic === "hermes_profile_not_advertised") {
    return "profile_not_advertised";
  }
  return diagnosticState(diagnostic);
}

const SYNTHETIC_CONTEXT: MartyContext = {
  elapsedMs: 0,
  topics: [],
  revisit: [],
  questions: [],
  notes: [],
  transcript: [],
};
