import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { startDesktopSetupRuntime } from "../../src/desktop/setup-runtime.js";
import { defaultConnectionSettings } from "../../src/server/desktop/connection-settings.js";
import type {
  ActiveConnectionAuthority,
  ConnectionStorageStatus,
} from "../../src/server/desktop/connection-storage.js";
import type { RecallNgrokConnectionTestResult } from "../../src/server/desktop/recall-ngrok-connection-test.js";
import { HermesConnectionTestError } from "../../src/server/desktop/hermes-connection-test.js";
import {
  LOCAL_API_COOKIE_NAME,
  LocalApiAccess,
} from "../../src/server/security/local-api-access.js";

const token = "s".repeat(43);

// Hoisted before runtime imports; setup tests must use injected adapters.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    throw new Error("Setup tests forbid native subprocesses");
  }),
}));

describe("authenticated desktop setup runtime", () => {
  it("Back refuses incomplete setup without requesting runtime teardown", async () => {
    const requestReload = vi.fn(async () => "reloaded" as const);
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage: setupStorage(setupStatus()),
      initialStatus: setupStatus(),
      requestReload,
    });
    try {
      const result = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/reload"),
        { method: "POST", origin: runtime.applicationUrl, json: {} },
      );
      expect(result.status).toBe(409);
      expect(requestReload).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("requires the launch cookie and returns only a redacted Unit 2A overview", async () => {
    const localApiAccess = new LocalApiAccess(token);
    const storage = setupStorage(setupStatus());
    const runtime = await startDesktopSetupRuntime({
      localApiAccess,
      storage,
      initialStatus: setupStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      expect(runtime.mode).toBe("setup");
      expect((await fetch(runtime.applicationUrl)).status).toBe(401);
      const page = await authenticatedFetch(runtime.applicationUrl);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain(
        "default-src 'self'",
      );
      expect(page.headers.get("cache-control")).toBe("no-store");
      const html = await page.text();
      expect(html).toContain("Connection settings");
      expect(html).not.toMatch(/CONVO_CADDY_/);
      expect(html).not.toContain(token);

      const overview = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup"),
      );
      expect(await overview.json()).toEqual({
        mode: "setup_required",
        code: null,
        recallRegion: "us-west-2",
        recallLanguage: "en",
        ngrokDomain: null,
        webhookUrl: null,
        hermesMode: null,
        hermesLocalPort: 8642,
        hermesRemotePort: 8642,
        hermesSshTarget: null,
        hermesEndpointPath: "/",
        hermesProfile: null,
        configured: {
          recallApiKey: false,
          recallWebhookVerificationSecret: false,
          ngrokAuthtoken: false,
          hermesApiKey: false,
        },
        cleanupPending: false,
      });

      const attacked = await requestWithHost(
        endpoint(runtime.applicationUrl, "/api/setup"),
        "attacker.example",
      );
      expect(attacked.status).toBe(421);
      expect(attacked.body).not.toContain("us-west-2");
    } finally {
      await runtime.close();
    }
  });

  it("renders compact Recall/ngrok and Hermes controls without secrets, profile defaults, or personal values", async () => {
    const localApiAccess = new LocalApiAccess(token);
    const runtime = await startDesktopSetupRuntime({
      localApiAccess,
      storage: setupStorage(setupStatus()),
      initialStatus: setupStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const page = await authenticatedFetch(runtime.applicationUrl);
      const html = await page.text();
      expect(html).toContain("Recall");
      expect(html).toContain("ngrok");
      expect(html).toContain("us-west-2");
      expect(html).toContain("English");
      expect(html).toContain('id="ngrok-domain"');
      for (const id of [
        "recall-api-key",
        "recall-webhook-verification-secret",
        "ngrok-authtoken",
      ]) {
        expect(html).toContain(
          `id="${id}" type="password" autocomplete="new-password"`,
        );
      }
      expect(html).toContain('id="test-connections"');
      expect(html).toContain('id="save-connections"');
      expect(html).toContain("Hermes");
      expect(html).toContain('id="hermes-mode"');
      expect(html).toContain('id="hermes-local-port"');
      expect(html).toContain('id="hermes-remote-port"');
      expect(html).toContain('id="hermes-ssh-target"');
      expect(html).toContain('id="hermes-endpoint-path"');
      expect(html).toContain(
        'id="hermes-api-key" type="password" autocomplete="new-password"',
      );
      expect(html).toContain('id="hermes-profile"');
      expect(html).toContain('value="">Load models first</option>');
      expect(html).toContain('id="discover-hermes-profiles"');
      expect(html).toContain('id="test-hermes-assistant"');
      expect(html).toContain("may incur provider cost");
      expect(html).toContain("never accepts SSH host keys");
      expect(html).toContain("workspace verification secret");
      expect(html).toContain("not a per-endpoint Svix secret");
      expect(html).not.toContain("must-not-leak");

      const script = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/setup.js"),
      );
      expect(script.headers.get("content-type")).toContain(
        "application/javascript",
      );
      const javascript = await script.text();
      expect(javascript).toContain("Your unsaved entries are still here");
      expect(javascript).not.toContain("clearSecretInputs");
      expect(javascript).not.toContain("innerHTML");

      const css = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/setup.css"),
      );
      expect(await css.text()).toContain("#f3f5f1");
      const font = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/fonts/instrument-sans.woff2"),
      );
      expect(font.status).toBe(200);
      expect(font.headers.get("content-type")).toContain("font/woff2");
    } finally {
      await runtime.close();
    }
  });

  it("saves strict Recall/ngrok replacements before queuing one reload", async () => {
    const localApiAccess = new LocalApiAccess(token);
    const ready = readyStatus();
    const storage = setupStorage(ready);
    let releaseReload: () => void = () => undefined;
    const reloadPending = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    const requestReload = vi.fn(async () => {
      await reloadPending;
      return "reloaded" as const;
    });
    const runtime = await startDesktopSetupRuntime({
      localApiAccess,
      storage,
      initialStatus: setupStatus(),
      requestReload,
    });

    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const response = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        {
          method: "PUT",
          origin,
          json: {
            ngrokDomain: "portable.ngrok.app",
            recallApiKey: "replacement-recall-key",
            recallWebhookVerificationSecret: verificationSecret(),
            ngrokAuthtoken: "",
            hermesMode: "ssh",
            hermesLocalPort: 18642,
            hermesRemotePort: 28642,
            hermesSshTarget: "operator@hermes-host.local",
            hermesEndpointPath: "/p/everyday",
            hermesProfile: "research",
            hermesApiKey: "replacement-hermes-key",
          },
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        mode: "ready",
        recallRegion: "us-west-2",
        recallLanguage: "en",
        ngrokDomain: "example.ngrok.app",
        webhookUrl: "https://example.ngrok.app/api/capture/recall/webhook",
      });
      expect(storage.save).toHaveBeenCalledWith({
        connection: {
          recall: { region: "us-west-2", language: "en" },
          ngrok: { domain: "portable.ngrok.app" },
          hermes: {
            mode: "ssh",
            localPort: 18642,
            remotePort: 28642,
            sshTarget: "operator@hermes-host.local",
            endpointPath: "/p/everyday",
            profile: "research",
          },
        },
        replacements: {
          "recall-api-key": "replacement-recall-key",
          "recall-webhook-verification-secret": verificationSecret(),
          "ngrok-authtoken": "",
          "hermes-api-key": "replacement-hermes-key",
        },
      });
      expect(requestReload).not.toHaveBeenCalled();
      const acknowledgement = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/save-acknowledgement"),
        { method: "POST", origin, json: {} },
      );
      expect(acknowledgement.status).toBe(202);
      await vi.waitFor(() => expect(requestReload).toHaveBeenCalledOnce());
      releaseReload();
    } finally {
      await runtime.close();
    }
  });

  it("rejects mutations while an acknowledged reload is pending", async () => {
    const storage = setupStorage(readyStatus());
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reload = vi.fn(async () => {
      await pending;
      return "reloaded" as const;
    });
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      initialStatus: setupStatus(),
      requestReload: reload,
    });
    try {
      const origin = new URL(runtime.applicationUrl).origin;
      await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        { method: "PUT", origin, json: validConnectionSaveBody() },
      );
      await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/save-acknowledgement"),
        { method: "POST", origin, json: {} },
      );
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
      for (const [route, method, json] of [
        ["/api/setup/connections", "PUT", validConnectionSaveBody()],
        ["/api/setup/credentials", "DELETE", { confirm: true }],
        ["/api/setup/reconcile", "POST", {}],
      ] as const) {
        const result = await authenticatedFetch(
          endpoint(runtime.applicationUrl, route),
          { method, origin, json },
        );
        expect(result.status).toBe(409);
      }
      expect(storage.save).toHaveBeenCalledOnce();
      expect(storage.resetCredentials).not.toHaveBeenCalled();
    } finally {
      release();
      await runtime.close();
    }
  });

  it("serializes reconciliation with pending storage mutations", async () => {
    const storage = setupStorage(setupStatus());
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.initialize.mockImplementation(async () => {
      await pending;
      return setupStatus();
    });
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      initialStatus: setupStatus(),
      requestReload: async () => "reloaded",
    });
    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const reconcile = authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/reconcile"),
        { method: "POST", origin, json: {} },
      );
      await vi.waitFor(() => expect(storage.initialize).toHaveBeenCalledOnce());
      const save = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        { method: "PUT", origin, json: validConnectionSaveBody() },
      );
      expect(save.status).toBe(409);
      expect(storage.save).not.toHaveBeenCalled();
      release();
      await reconcile;
    } finally {
      release();
      await runtime.close();
    }
  });

  it("does not acknowledge a save rejected by candidate cleanup", async () => {
    const blocked: ConnectionStorageStatus = {
      ...setupStatus(),
      kind: "needs_attention",
      code: "candidate_cleanup_failed",
    };
    const requestReload = vi.fn(async () => "reloaded" as const);
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage: setupStorage(blocked),
      initialStatus: setupStatus(),
      requestReload,
    });
    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const result = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        {
          method: "PUT",
          origin,
          json: validConnectionSaveBody(),
        },
      );
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({
        error: expect.stringContaining("not saved"),
      });
      const ack = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/save-acknowledgement"),
        { method: "POST", origin, json: {} },
      );
      expect(ack.status).toBe(409);
      expect(requestReload).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("fails a save with a redacted response and never reloads", async () => {
    const localApiAccess = new LocalApiAccess(token);
    const storage = setupStorage(setupStatus());
    storage.save.mockRejectedValueOnce(
      new Error("provider leaked replacement-recall-key"),
    );
    const requestReload = vi.fn(async () => "reloaded" as const);
    const runtime = await startDesktopSetupRuntime({
      localApiAccess,
      storage,
      initialStatus: setupStatus(),
      requestReload,
    });

    try {
      const response = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        {
          method: "PUT",
          origin: new URL(runtime.applicationUrl).origin,
          json: {
            ngrokDomain: "portable.ngrok.app",
            recallApiKey: "replacement-recall-key",
            recallWebhookVerificationSecret: verificationSecret(),
            ngrokAuthtoken: "replacement-ngrok-token",
            hermesMode: null,
            hermesLocalPort: 8642,
            hermesRemotePort: 8642,
            hermesSshTarget: null,
            hermesProfile: null,
            hermesApiKey: "",
          },
        },
      );
      expect(response.status).toBe(500);
      const failure = await response.json();
      expect(failure.code).toBe("setup_unknown");
      expect(failure.error).toContain("Your unsaved entries are still here");
      expect(JSON.stringify(failure)).not.toContain("must-not-leak");
      expect(requestReload).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("discovers profiles with a preserved Keychain secret and never selects one", async () => {
    const authority = activeAuthority("00000000-0000-4000-8000-000000000001");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority.mockResolvedValue(authority);
    const hermesConnectionTester = {
      discover: vi.fn(async () => ({
        generation: authority.generation,
        state: "profiles_advertised" as const,
        profiles: ["alpha", "research"],
      })),
      testAssistant: vi.fn(),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      hermesConnectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const response = await authenticatedFetch(
        endpoint(
          runtime.applicationUrl,
          "/api/setup/connections/hermes/discover",
        ),
        {
          method: "POST",
          origin: new URL(runtime.applicationUrl).origin,
          json: {
            hermesMode: "local",
            hermesLocalPort: 18642,
            hermesRemotePort: 28642,
            hermesSshTarget: null,
            hermesApiKey: "",
          },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        generation: authority.generation,
        state: "profiles_advertised",
        profiles: ["alpha", "research"],
      });
      expect(hermesConnectionTester.discover).toHaveBeenCalledWith({
        generation: authority.generation,
        mode: "local",
        baseUrl: "http://127.0.0.1:18642",
        localPort: 18642,
        remotePort: 28642,
        sshTarget: null,
        apiKey: "stored-hermes-key",
      });
      expect(hermesConnectionTester.testAssistant).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("tests one explicitly selected synthetic assistant profile and suppresses stale results", async () => {
    const first = activeAuthority("00000000-0000-4000-8000-000000000001");
    const second = activeAuthority("00000000-0000-4000-8000-000000000002");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const hermesConnectionTester = {
      discover: vi.fn(),
      testAssistant: vi.fn(async () => ({
        generation: first.generation,
        state: "assistant_verified_synthetic" as const,
      })),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      hermesConnectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const response = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections/hermes/test"),
        {
          method: "POST",
          origin: new URL(runtime.applicationUrl).origin,
          json: {
            hermesMode: "ssh",
            hermesLocalPort: 18642,
            hermesRemotePort: 28642,
            hermesSshTarget: "operator@hermes-host.local",
            hermesApiKey: "replacement-hermes-key",
            hermesProfile: "research",
          },
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        state: "stale",
        generation: first.generation,
      });
      expect(hermesConnectionTester.testAssistant).toHaveBeenCalledWith({
        generation: first.generation,
        mode: "ssh",
        baseUrl: "http://127.0.0.1:18642",
        localPort: 18642,
        remotePort: 28642,
        sshTarget: "operator@hermes-host.local",
        apiKey: "replacement-hermes-key",
        profile: "research",
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects a settings save while a Hermes assistant operation owns the active generation", async () => {
    const authority = activeAuthority("00000000-0000-4000-8000-000000000001");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority.mockResolvedValue(authority);
    let releaseAssistant: () => void = () => undefined;
    const pendingAssistant = new Promise<void>((resolve) => {
      releaseAssistant = resolve;
    });
    const hermesConnectionTester = {
      discover: vi.fn(),
      testAssistant: vi.fn(async () => {
        await pendingAssistant;
        return {
          generation: authority.generation,
          state: "assistant_verified_synthetic" as const,
        };
      }),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      hermesConnectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const assistant = authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections/hermes/test"),
        {
          method: "POST",
          origin,
          json: {
            hermesMode: "local",
            hermesLocalPort: 18642,
            hermesRemotePort: 28642,
            hermesSshTarget: null,
            hermesApiKey: "",
            hermesProfile: "research",
          },
        },
      );
      await vi.waitFor(() =>
        expect(hermesConnectionTester.testAssistant).toHaveBeenCalledOnce(),
      );

      const save = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        {
          method: "PUT",
          origin,
          json: validConnectionSaveBody(),
        },
      );
      expect(save.status).toBe(409);
      expect(await save.json()).toEqual({
        error: "A Hermes connection operation is already in progress.",
      });
      expect(storage.save).not.toHaveBeenCalled();

      releaseAssistant();
      expect((await assistant).status).toBe(200);
    } finally {
      releaseAssistant();
      await runtime.close();
    }
  });

  it("rejects a Hermes operation while a generation-changing save is in progress", async () => {
    const authority = activeAuthority("00000000-0000-4000-8000-000000000001");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority.mockResolvedValue(authority);
    let releaseSave: () => void = () => undefined;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    storage.save.mockImplementation(async () => {
      await pendingSave;
      return readyStatus();
    });
    const hermesConnectionTester = {
      discover: vi.fn(),
      testAssistant: vi.fn(),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      hermesConnectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const save = authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        {
          method: "PUT",
          origin,
          json: validConnectionSaveBody(),
        },
      );
      await vi.waitFor(() => expect(storage.save).toHaveBeenCalledOnce());

      const assistant = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections/hermes/test"),
        {
          method: "POST",
          origin,
          json: {
            hermesMode: "local",
            hermesLocalPort: 18642,
            hermesRemotePort: 28642,
            hermesSshTarget: null,
            hermesApiKey: "",
            hermesProfile: "research",
          },
        },
      );
      expect(assistant.status).toBe(409);
      expect(await assistant.json()).toEqual({
        error: "Connection settings are being updated.",
      });
      expect(hermesConnectionTester.testAssistant).not.toHaveBeenCalled();

      releaseSave();
      expect((await save).status).toBe(200);
    } finally {
      releaseSave();
      await runtime.close();
    }
  });

  it("rejects a credential reset while a Hermes assistant operation owns the active generation", async () => {
    const authority = activeAuthority("00000000-0000-4000-8000-000000000001");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority.mockResolvedValue(authority);
    let releaseAssistant: () => void = () => undefined;
    const pendingAssistant = new Promise<void>((resolve) => {
      releaseAssistant = resolve;
    });
    const hermesConnectionTester = {
      discover: vi.fn(),
      testAssistant: vi.fn(async () => {
        await pendingAssistant;
        return {
          generation: authority.generation,
          state: "assistant_verified_synthetic" as const,
        };
      }),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      hermesConnectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const assistant = authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections/hermes/test"),
        {
          method: "POST",
          origin,
          json: {
            hermesMode: "local",
            hermesLocalPort: 18642,
            hermesRemotePort: 28642,
            hermesSshTarget: null,
            hermesApiKey: "",
            hermesProfile: "research",
          },
        },
      );
      await vi.waitFor(() =>
        expect(hermesConnectionTester.testAssistant).toHaveBeenCalledOnce(),
      );

      const reset = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/credentials"),
        { method: "DELETE", origin, json: { confirm: true } },
      );
      expect(reset.status).toBe(409);
      expect(await reset.json()).toEqual({
        error: "A Hermes connection operation is already in progress.",
      });
      expect(storage.resetCredentials).not.toHaveBeenCalled();

      releaseAssistant();
      expect((await assistant).status).toBe(200);
    } finally {
      releaseAssistant();
      await runtime.close();
    }
  });

  it("rejects a Hermes operation while a credential reset is in progress", async () => {
    const authority = activeAuthority("00000000-0000-4000-8000-000000000001");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority.mockResolvedValue(authority);
    let releaseReset: () => void = () => undefined;
    const pendingReset = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    storage.resetCredentials.mockImplementation(async () => {
      await pendingReset;
      return setupStatus();
    });
    const hermesConnectionTester = {
      discover: vi.fn(),
      testAssistant: vi.fn(),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      hermesConnectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const reset = authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/credentials"),
        { method: "DELETE", origin, json: { confirm: true } },
      );
      await vi.waitFor(() =>
        expect(storage.resetCredentials).toHaveBeenCalledOnce(),
      );

      const assistant = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections/hermes/test"),
        {
          method: "POST",
          origin,
          json: {
            hermesMode: "local",
            hermesLocalPort: 18642,
            hermesRemotePort: 28642,
            hermesSshTarget: null,
            hermesApiKey: "",
            hermesProfile: "research",
          },
        },
      );
      expect(assistant.status).toBe(409);
      expect(await assistant.json()).toEqual({
        error: "Connection settings are being updated.",
      });
      expect(hermesConnectionTester.testAssistant).not.toHaveBeenCalled();

      releaseReset();
      expect((await reset).status).toBe(200);
    } finally {
      releaseReset();
      await runtime.close();
    }
  });

  it("blocks generation changes after Hermes cleanup becomes unconfirmed", async () => {
    const authority = activeAuthority("00000000-0000-4000-8000-000000000001");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority.mockResolvedValue(authority);
    const hermesConnectionTester = {
      discover: vi.fn(),
      testAssistant: vi.fn(async () => {
        throw new HermesConnectionTestError(
          "cleanup_failed",
          "Hermes connection cleanup could not be confirmed.",
        );
      }),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      hermesConnectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const assistant = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections/hermes/test"),
        {
          method: "POST",
          origin,
          json: {
            hermesMode: "local",
            hermesLocalPort: 18642,
            hermesRemotePort: 28642,
            hermesSshTarget: null,
            hermesApiKey: "",
            hermesProfile: "research",
          },
        },
      );
      expect(assistant.status).toBe(500);

      const save = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        {
          method: "PUT",
          origin,
          json: validConnectionSaveBody(),
        },
      );
      expect(save.status).toBe(409);
      expect(await save.json()).toEqual({
        error:
          "Hermes cleanup is unconfirmed. Quit Convo Caddy before changing connection settings.",
      });
      expect(storage.save).not.toHaveBeenCalled();

      const reset = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/credentials"),
        { method: "DELETE", origin, json: { confirm: true } },
      );
      expect(reset.status).toBe(409);
      expect(await reset.json()).toEqual({
        error:
          "Hermes cleanup is unconfirmed. Quit Convo Caddy before changing connection settings.",
      });
      expect(storage.resetCredentials).not.toHaveBeenCalled();
    } finally {
      await expect(runtime.close()).rejects.toThrow(
        "Connection-test endpoint cleanup is still pending.",
      );
    }
  });

  it("tests active secrets without read-back and suppresses a late generation", async () => {
    const first = activeAuthority("00000000-0000-4000-8000-000000000001");
    const second = activeAuthority("00000000-0000-4000-8000-000000000002");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const connectionTester = {
      test: vi.fn(async () => connectionTestResult(first.generation)),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      connectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const response = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections/test"),
        {
          method: "POST",
          origin: new URL(runtime.applicationUrl).origin,
          json: {
            ngrokDomain: "example.ngrok.app",
            recallApiKey: "",
            recallWebhookVerificationSecret: "",
            ngrokAuthtoken: "",
          },
        },
      );
      expect(response.status).toBe(409);
      const responseBody = await response.text();
      expect(JSON.parse(responseBody)).toEqual({
        state: "stale",
        generation: first.generation,
      });
      expect(connectionTester.test).toHaveBeenCalledWith({
        generation: first.generation,
        recallApiKey: "stored-recall-key",
        recallWebhookVerificationSecret: verificationSecret(),
        ngrokAuthtoken: "stored-ngrok-token",
        ngrokDomain: "example.ngrok.app",
      });
      expect(responseBody).not.toMatch(/stored-recall|stored-ngrok|whsec_/);
    } finally {
      await runtime.close();
    }
  });

  it("returns component-specific test results and rejects overlapping tests", async () => {
    const authority = activeAuthority("00000000-0000-4000-8000-000000000001");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority.mockResolvedValue(authority);
    let releaseTest: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      releaseTest = resolve;
    });
    const connectionTester = {
      test: vi.fn(async () => {
        await pending;
        return connectionTestResult(authority.generation);
      }),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      connectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const body = {
        ngrokDomain: "example.ngrok.app",
        recallApiKey: "",
        recallWebhookVerificationSecret: "",
        ngrokAuthtoken: "",
      };
      const first = authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections/test"),
        { method: "POST", origin, json: body },
      );
      await vi.waitFor(() =>
        expect(connectionTester.test).toHaveBeenCalledOnce(),
      );
      const overlapping = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections/test"),
        { method: "POST", origin, json: body },
      );
      expect(overlapping.status).toBe(409);
      expect(await overlapping.json()).toEqual({
        error: "A connection test is already in progress.",
      });

      releaseTest();
      const response = await first;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        connectionTestResult(authority.generation),
      );
      expect(connectionTester.test).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });

  it("keeps teardown pending until an active connection test releases its endpoint", async () => {
    const authority = activeAuthority("00000000-0000-4000-8000-000000000001");
    const storage = setupStorage(readyStatus());
    storage.loadActiveAuthority.mockResolvedValue(authority);
    let releaseTest: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      releaseTest = resolve;
    });
    const connectionTester = {
      test: vi.fn(async () => {
        await pending;
        return connectionTestResult(authority.generation);
      }),
    };
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage,
      connectionTester,
      initialStatus: readyStatus(),
      requestReload: async () => "reloaded",
    });
    const testResponse = authenticatedFetch(
      endpoint(runtime.applicationUrl, "/api/setup/connections/test"),
      {
        method: "POST",
        origin: new URL(runtime.applicationUrl).origin,
        json: {
          ngrokDomain: "example.ngrok.app",
          recallApiKey: "",
          recallWebhookVerificationSecret: "",
          ngrokAuthtoken: "",
        },
      },
    ).catch(() => undefined);
    await vi.waitFor(() =>
      expect(connectionTester.test).toHaveBeenCalledOnce(),
    );

    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(closed).toBe(false);

    releaseTest();
    await closing;
    await testResponse;
  });

  it("requires exact Origin for mutations and rejects unknown or oversized bodies", async () => {
    const localApiAccess = new LocalApiAccess(token);
    const storage = setupStorage(setupStatus());
    const runtime = await startDesktopSetupRuntime({
      localApiAccess,
      storage,
      initialStatus: setupStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const missingOrigin = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/reconcile"),
        { method: "POST", json: {} },
      );
      expect(missingOrigin.status).toBe(403);
      expect(storage.initialize).not.toHaveBeenCalled();

      const unknown = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/reconcile"),
        {
          method: "POST",
          origin: new URL(runtime.applicationUrl).origin,
          json: { extra: true },
        },
      );
      expect(unknown.status).toBe(400);

      const invalidConnection = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        {
          method: "PUT",
          origin: new URL(runtime.applicationUrl).origin,
          json: {
            ngrokDomain: "https://portable.ngrok.app/path",
            recallApiKey: "replacement-recall-key",
            recallWebhookVerificationSecret: "not-a-whsec-secret",
            ngrokAuthtoken: "replacement-ngrok-token",
          },
        },
      );
      expect(invalidConnection.status).toBe(400);
      const invalidVerificationSecret = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/connections"),
        {
          method: "PUT",
          origin: new URL(runtime.applicationUrl).origin,
          json: {
            ngrokDomain: "portable.ngrok.app",
            recallApiKey: "replacement-recall-key",
            recallWebhookVerificationSecret: "not-a-whsec-secret",
            ngrokAuthtoken: "replacement-ngrok-token",
          },
        },
      );
      expect(invalidVerificationSecret.status).toBe(400);

      const optionLikeSshTarget = await authenticatedFetch(
        endpoint(
          runtime.applicationUrl,
          "/api/setup/connections/hermes/discover",
        ),
        {
          method: "POST",
          origin: new URL(runtime.applicationUrl).origin,
          json: {
            hermesMode: "ssh",
            hermesLocalPort: 8642,
            hermesRemotePort: 8642,
            hermesSshTarget: "-Ffoo",
            hermesApiKey: "replacement-hermes-key",
          },
        },
      );
      expect(optionLikeSshTarget.status).toBe(400);
      expect(storage.save).not.toHaveBeenCalled();

      const oversized = await fetch(
        endpoint(runtime.applicationUrl, "/api/setup/reconcile"),
        {
          method: "POST",
          headers: {
            Cookie: `${LOCAL_API_COOKIE_NAME}=${token}`,
            Origin: new URL(runtime.applicationUrl).origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ value: "x".repeat(9_000) }),
        },
      );
      expect(oversized.status).toBe(413);
      expect(oversized.headers.get("cache-control")).toBe("no-store");
      expect(await oversized.text()).not.toContain("x".repeat(100));
    } finally {
      await runtime.close();
    }
  });

  it("reconciles and resets through strict redacted mutations", async () => {
    const localApiAccess = new LocalApiAccess(token);
    const ready = readyStatus();
    const storage = setupStorage(ready);
    const runtime = await startDesktopSetupRuntime({
      localApiAccess,
      storage,
      initialStatus: setupStatus(),
      requestReload: async () => "reloaded",
    });

    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const reconciled = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/reconcile"),
        { method: "POST", origin, json: {} },
      );
      expect(reconciled.status).toBe(200);
      expect((await reconciled.json()).mode).toBe("ready");
      expect(storage.initialize).toHaveBeenCalledOnce();

      const unconfirmed = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/credentials"),
        { method: "DELETE", origin, json: { confirm: false } },
      );
      expect(unconfirmed.status).toBe(400);
      expect(storage.resetCredentials).not.toHaveBeenCalled();

      const reset = await authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/credentials"),
        { method: "DELETE", origin, json: { confirm: true } },
      );
      expect(reset.status).toBe(200);
      expect((await reset.json()).mode).toBe("ready");
      expect(storage.resetCredentials).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });

  it("finishes and coalesces reload responses without awaiting the lifecycle callback", async () => {
    const localApiAccess = new LocalApiAccess(token);
    const storage = setupStorage(readyStatus());
    let releaseReload: () => void = () => undefined;
    const reloadPending = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    const requestReload = vi.fn(async () => {
      await reloadPending;
      return "reloaded" as const;
    });
    const runtime = await startDesktopSetupRuntime({
      localApiAccess,
      storage,
      initialStatus: readyStatus(),
      requestReload,
    });

    try {
      const origin = new URL(runtime.applicationUrl).origin;
      const first = authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/reload"),
        {
          method: "POST",
          origin,
          json: {},
        },
      );
      const second = authenticatedFetch(
        endpoint(runtime.applicationUrl, "/api/setup/reload"),
        {
          method: "POST",
          origin,
          json: {},
        },
      );

      await expect(first).resolves.toMatchObject({ status: 202 });
      await expect(second).resolves.toMatchObject({ status: 202 });
      await vi.waitFor(() => expect(requestReload).toHaveBeenCalledOnce());
      releaseReload();
    } finally {
      await runtime.close();
    }
  });

  it("closes idempotently and has no interview quit risk", async () => {
    const runtime = await startDesktopSetupRuntime({
      localApiAccess: new LocalApiAccess(token),
      storage: setupStorage(setupStatus()),
      initialStatus: setupStatus(),
      requestReload: async () => "reloaded",
    });

    expect(runtime.getQuitRisk()).toBeNull();
    await runtime.close();
    await runtime.close();
  });
});

function setupStatus(): ConnectionStorageStatus {
  const settings = defaultConnectionSettings();
  settings.legacyMigration = { state: "not_needed" };
  return {
    kind: "setup_required",
    settings,
    configured: {
      recallApiKey: false,
      recallWebhookVerificationSecret: false,
      ngrokAuthtoken: false,
      hermesApiKey: false,
    },
    cleanupPending: false,
  };
}

function readyStatus(): ConnectionStorageStatus {
  const settings = defaultConnectionSettings();
  settings.ngrok.domain = "example.ngrok.app";
  settings.activeSecretGeneration = "00000000-0000-4000-8000-000000000001";
  settings.configuredSecretRoles = [
    "recall-api-key",
    "recall-webhook-verification-secret",
    "ngrok-authtoken",
  ];
  settings.legacyMigration = { state: "complete" };
  return {
    kind: "ready",
    settings,
    configured: {
      recallApiKey: true,
      recallWebhookVerificationSecret: true,
      ngrokAuthtoken: true,
      hermesApiKey: false,
    },
    cleanupPending: false,
  };
}

function setupStorage(result: ConnectionStorageStatus) {
  const initialize = vi.fn(async () => result);
  const resetCredentials = vi.fn(async () => result);
  const save = vi.fn(async () => result);
  const loadActiveAuthority = vi.fn(
    async (): Promise<ActiveConnectionAuthority | null> => null,
  );
  return { initialize, loadActiveAuthority, resetCredentials, save };
}

function activeAuthority(generation: string): ActiveConnectionAuthority {
  return {
    generation,
    connection: {
      recall: { region: "us-west-2", language: "en" },
      ngrok: { domain: "example.ngrok.app" },
      hermes: defaultConnectionSettings().hermes,
    },
    secrets: {
      "recall-api-key": "stored-recall-key",
      "recall-webhook-verification-secret": verificationSecret(),
      "ngrok-authtoken": "stored-ngrok-token",
      "hermes-api-key": "stored-hermes-key",
    },
  };
}

function connectionTestResult(
  generation: string,
): RecallNgrokConnectionTestResult {
  return {
    generation,
    recallCredentials: { state: "authenticated_read_only" },
    localWebhook: { state: "verified_synthetic" },
    ngrokEndpoint: { state: "verified_exact_domain" },
    publicWebhook: { state: "verified_synthetic" },
    webhookAuthenticity: { state: "verified_in_automation" },
    botCreation: { state: "not_attempted" },
    retention: {
      requestedMedia: "none",
      providerConfirmation: "not_observed",
      accountMetadata: "unknown",
      localManagedDays: 7,
    },
  };
}

function verificationSecret(): string {
  return `whsec_${Buffer.from("unit-2b-setup-secret").toString("base64")}`;
}

async function authenticatedFetch(
  target: string,
  options: {
    method?: string;
    origin?: string;
    json?: unknown;
  } = {},
) {
  return fetch(target, {
    method: options.method,
    headers: {
      Cookie: `${LOCAL_API_COOKIE_NAME}=${token}`,
      ...(options.origin ? { Origin: options.origin } : {}),
      ...(options.json === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(options.json === undefined
      ? {}
      : { body: JSON.stringify(options.json) }),
  });
}

function requestWithHost(
  target: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          Host: host,
          Cookie: `${LOCAL_API_COOKIE_NAME}=${token}`,
        },
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function validConnectionSaveBody() {
  return {
    ngrokDomain: "portable.ngrok.app",
    recallApiKey: "",
    recallWebhookVerificationSecret: "",
    ngrokAuthtoken: "",
    hermesMode: "local" as const,
    hermesLocalPort: 18642,
    hermesRemotePort: 28642,
    hermesSshTarget: null,
    hermesProfile: "research",
    hermesApiKey: "",
  };
}

function endpoint(base: string, pathname: string): string {
  return new URL(pathname, base).toString();
}
