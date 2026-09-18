export type RuntimeComponentStates = {
  configuration: "missing" | "invalid" | "ready";
  workspace: "locked" | "migrating" | "ready" | "failed";
  appServer: "starting" | "ready" | "failed";
  webhookServer: "starting" | "ready" | "failed";
  ngrok: "starting" | "ready" | "reconnecting" | "failed";
  hermesTunnel:
    | "starting"
    | "local"
    | "reused"
    | "owned"
    | "unavailable"
    | "failed";
  hermes: "ready" | "unavailable";
  capture: "disabled" | "ready" | "active" | "finalizing" | "needs_attention";
};

export type RuntimeApplicationState =
  | "setup_required"
  | "starting"
  | "ready"
  | "ready_without_marty"
  | "needs_attention"
  | "interview_active"
  | "finalizing";

const diagnosticCatalog = {
  hermes_unavailable: {
    severity: "warning",
    message:
      "Assistant is unavailable. Capture and deterministic interview controls remain available.",
    action: "Check the configured Hermes connection and selected profile.",
  },
  hermes_health_mismatch: {
    severity: "error",
    message:
      "The local Hermes port did not return the expected service identity.",
    action:
      "Inspect the configured local port; Convo Caddy did not stop its occupant.",
  },
  hermes_authentication_rejected: {
    severity: "error",
    message: "The local Hermes service rejected Convo Caddy authentication.",
    action: "Replace or verify the Hermes API key in Connection Settings.",
  },
  hermes_models_malformed: {
    severity: "error",
    message: "Hermes returned an unsupported profile list.",
    action: "Inspect Hermes Agent; Convo Caddy did not change it.",
  },
  hermes_profile_not_advertised: {
    severity: "error",
    message: "Hermes no longer advertises the selected profile.",
    action:
      "Open Connection Settings and explicitly select an advertised profile.",
  },
  hermes_transport_mismatch: {
    severity: "error",
    message: "Another process is using the local Hermes forward port.",
    action:
      "Inspect the configured local port; Convo Caddy did not stop its occupant.",
  },
  ssh_forward_unavailable: {
    severity: "warning",
    message: "The local forwarding port is unavailable.",
    action:
      "Choose another free local port in Connection Settings; the existing listener was preserved.",
  },
  ssh_start_failed: {
    severity: "warning",
    message: "Convo Caddy could not start its laptop-side Hermes SSH forward.",
    action: "Check SSH host access, keys, and known-host configuration.",
  },
  ssh_exited_before_ready: {
    severity: "warning",
    message:
      "The laptop-side Hermes SSH forward exited before it became ready.",
    action: "Check SSH host access, keys, and known-host configuration.",
  },
  ssh_owned_forward_exited: {
    severity: "warning",
    message: "The established Hermes SSH forward exited.",
    action:
      "Wait for bounded reconnection or check SSH host access, keys, and network connectivity.",
  },
  ngrok_start_failed: {
    severity: "error",
    message: "Convo Caddy could not establish the Recall webhook endpoint.",
    action: "Check the ngrok account, token, network, and reserved domain.",
  },
  ngrok_reconnecting: {
    severity: "warning",
    message: "The Recall webhook endpoint is reconnecting.",
    action: "Wait for capture readiness before starting another interview.",
  },
  ngrok_transport_failed: {
    severity: "error",
    message: "The Recall webhook endpoint did not reconnect in time.",
    action: "Check the network and ngrok account before starting capture.",
  },
  ngrok_domain_mismatch: {
    severity: "error",
    message:
      "ngrok returned a public URL other than the approved Recall domain.",
    action: "Inspect the reserved domain; the unexpected listener was closed.",
  },
  recall_bot_id_missing: {
    severity: "error",
    message: "A prior Recall operation has no stored bot identity.",
    action: "Inspect the Recall dashboard before any new capture attempt.",
  },
  recall_reconciliation_failed: {
    severity: "error",
    message: "Convo Caddy could not reconcile the stored Recall bot.",
    action: "Inspect the Recall dashboard before any recovery action.",
  },
  recall_reconciliation_conflict: {
    severity: "error",
    message: "Recall recovery information conflicts with the saved interview.",
    action: "Inspect the Recall dashboard before any recovery action.",
  },
} as const;

export type RuntimeDiagnosticCode = keyof typeof diagnosticCatalog;
export type RuntimeDiagnosticComponent =
  | "ngrok"
  | "hermesTunnel"
  | "hermes"
  | "capture";

export type RuntimeDiagnostic = {
  component: RuntimeDiagnosticComponent;
  code: RuntimeDiagnosticCode;
  severity: "warning" | "error";
  message: string;
  action: string;
};

export type RuntimeReadiness = {
  state: RuntimeApplicationState;
  components: RuntimeComponentStates;
  diagnostics: RuntimeDiagnostic[];
};

export type RuntimeReadinessListener = (readiness: RuntimeReadiness) => void;

export class RuntimeReadinessStore {
  #components: RuntimeComponentStates;
  readonly #diagnostics = new Map<string, RuntimeDiagnostic>();
  readonly #listeners = new Set<RuntimeReadinessListener>();

  constructor(components: RuntimeComponentStates) {
    this.#components = structuredClone(components);
  }

  snapshot(): RuntimeReadiness {
    return {
      state: deriveApplicationState(this.#components),
      components: structuredClone(this.#components),
      diagnostics: [...this.#diagnostics.values()].map((diagnostic) => ({
        ...diagnostic,
      })),
    };
  }

  update(patch: Partial<RuntimeComponentStates>): void {
    this.#components = { ...this.#components, ...patch };
    this.#publish();
  }

  report(
    component: RuntimeDiagnosticComponent,
    code: RuntimeDiagnosticCode,
  ): void {
    const definition = diagnosticCatalog[code];
    if (!definition) {
      throw new Error("Unknown runtime diagnostic code.");
    }
    this.#diagnostics.set(`${component}:${code}`, {
      component,
      code,
      ...definition,
    });
    this.#publish();
  }

  clear(component: RuntimeDiagnosticComponent): void {
    for (const key of this.#diagnostics.keys()) {
      if (key.startsWith(`${component}:`)) {
        this.#diagnostics.delete(key);
      }
    }
    this.#publish();
  }

  subscribe(listener: RuntimeReadinessListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}

function deriveApplicationState(
  components: RuntimeComponentStates,
): RuntimeApplicationState {
  if (components.configuration !== "ready") {
    return "setup_required";
  }
  if (
    components.workspace === "failed" ||
    components.appServer === "failed" ||
    components.webhookServer === "failed" ||
    components.ngrok === "failed" ||
    components.capture === "needs_attention"
  ) {
    return "needs_attention";
  }
  if (components.capture === "active") {
    return "interview_active";
  }
  if (components.capture === "finalizing") {
    return "finalizing";
  }
  if (
    components.workspace !== "ready" ||
    components.appServer !== "ready" ||
    components.webhookServer !== "ready" ||
    components.ngrok === "starting" ||
    components.ngrok === "reconnecting"
  ) {
    return "starting";
  }
  if (components.capture !== "ready") {
    return "needs_attention";
  }
  return components.hermes === "ready" ? "ready" : "ready_without_marty";
}
