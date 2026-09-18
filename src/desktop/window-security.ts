import { randomUUID } from "node:crypto";

export type SecureWindowOptions = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  show: false;
  title: string;
  backgroundColor: string;
  webPreferences: {
    partition: string;
    nodeIntegration: false;
    nodeIntegrationInWorker: false;
    nodeIntegrationInSubFrames: false;
    contextIsolation: true;
    sandbox: true;
    webSecurity: true;
    allowRunningInsecureContent: false;
    experimentalFeatures: false;
    webviewTag: false;
    devTools: false;
    navigateOnDragDrop: false;
  };
};

export function createEphemeralPartition(
  createId: () => string = randomUUID,
): string {
  return `convo-caddy-${createId()}`;
}

export function createSecureWindowOptions(
  partition: string,
): SecureWindowOptions {
  if (!partition || partition.startsWith("persist:")) {
    throw new Error("The desktop browser partition must be ephemeral.");
  }
  return {
    width: 1220,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    show: false,
    title: "Convo Caddy",
    backgroundColor: "#eeece5",
    webPreferences: {
      partition,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      devTools: false,
      navigateOnDragDrop: false,
    },
  };
}

export class NavigationPolicy {
  #origin: string | null = null;

  allow(value: string): void {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !isLoopbackHostname(url.hostname) ||
      url.username ||
      url.password
    ) {
      throw new Error("Desktop navigation is limited to loopback origins.");
    }
    this.#origin = url.origin;
  }

  allows(value: string): boolean {
    try {
      return this.#origin === new URL(value).origin;
    } catch {
      return false;
    }
  }

  openWindow(): { action: "deny" } {
    return { action: "deny" };
  }
}

export function isBlockedWindowAccelerator(input: {
  key: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}): boolean {
  const key = input.key.toLowerCase();
  return Boolean(
    key === "f5" ||
      key === "f12" ||
      ((input.meta || input.control) && key === "r") ||
      (((input.meta && input.alt) || (input.control && input.shift)) &&
        key === "i"),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}
