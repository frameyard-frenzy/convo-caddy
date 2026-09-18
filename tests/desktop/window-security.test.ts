import { describe, expect, it, vi } from "vitest";
import { secureBrowserSession } from "../../src/desktop/electron-adapters.js";
import {
  createEphemeralPartition,
  createSecureWindowOptions,
  isBlockedWindowAccelerator,
  NavigationPolicy,
} from "../../src/desktop/window-security.js";

describe("secure desktop window", () => {
  it("uses an isolated ephemeral browser session with no renderer privileges", () => {
    const partition = createEphemeralPartition(
      () => "11111111-2222-4333-8444-555555555555",
    );
    const options = createSecureWindowOptions(partition);

    expect(partition).toBe("convo-caddy-11111111-2222-4333-8444-555555555555");
    expect(partition.startsWith("persist:")).toBe(false);
    expect(options.webPreferences).toMatchObject({
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
    });
    expect(options.webPreferences).not.toHaveProperty("preload");
  });

  it("denies renderer permissions and native downloads", () => {
    const permissionChecks: Array<() => boolean> = [];
    const permissionRequests: Array<
      (
        contents: unknown,
        permission: string,
        callback: (allowed: boolean) => void,
      ) => void
    > = [];
    const downloads: Array<(event: { preventDefault(): void }) => void> = [];
    secureBrowserSession({
      setPermissionCheckHandler: (handler) => {
        permissionChecks.push(handler);
      },
      setPermissionRequestHandler: (handler) => {
        permissionRequests.push(handler);
      },
      on: (_event, listener) => {
        downloads.push(listener);
      },
    });

    expect(permissionChecks[0]?.()).toBe(false);
    const callback = vi.fn<(allowed: boolean) => void>();
    permissionRequests[0]?.(null, "notifications", callback);
    expect(callback).toHaveBeenCalledWith(false);
    const event = { preventDefault: vi.fn() };
    downloads[0]?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("allows only exact registered loopback origins and denies child windows", () => {
    const policy = new NavigationPolicy();
    policy.allow("http://127.0.0.1:4317");

    expect(policy.allows("http://127.0.0.1:4317/interview")).toBe(true);
    expect(policy.allows("http://127.0.0.1:4318/")).toBe(false);
    expect(policy.allows("https://example.com/")).toBe(false);
    expect(policy.openWindow()).toEqual({ action: "deny" });
  });

  it("uses a new nonpersistent session on every full application launch", () => {
    const first = createEphemeralPartition(
      () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    const second = createEphemeralPartition(
      () => "ffffffff-1111-4222-8333-444444444444",
    );

    expect(first).not.toBe(second);
    expect(first.startsWith("persist:")).toBe(false);
    expect(second.startsWith("persist:")).toBe(false);
  });

  it("blocks release reload and DevTools accelerators", () => {
    expect(isBlockedWindowAccelerator({ key: "r", meta: true })).toBe(true);
    expect(isBlockedWindowAccelerator({ key: "F5" })).toBe(true);
    expect(
      isBlockedWindowAccelerator({ key: "i", meta: true, alt: true }),
    ).toBe(true);
    expect(
      isBlockedWindowAccelerator({ key: "i", control: true, shift: true }),
    ).toBe(true);
    expect(isBlockedWindowAccelerator({ key: "c", meta: true })).toBe(false);
  });
});
