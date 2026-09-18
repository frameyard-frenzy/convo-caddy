import { SecretStoreError } from "../server/desktop/secret-store.js";
import { renderSetupGuide } from "./setup-guide.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { hermesSshTargetSchema } from "../server/connectivity/hermes-ssh-target.js";
import {
  connectionConfigurationFromSettings,
  ngrokDomainSchema,
} from "../server/desktop/connection-settings.js";
import type {
  ActiveConnectionAuthority,
  ConnectionStorage,
  ConnectionStorageStatus,
} from "../server/desktop/connection-storage.js";
import {
  RecallNgrokConnectionTester,
  RecallNgrokConnectionTestError,
  type RecallNgrokConnectionTestInput,
  type RecallNgrokConnectionTestResult,
} from "../server/desktop/recall-ngrok-connection-test.js";
import {
  HermesConnectionTester,
  HermesConnectionTestError,
  type HermesAssistantConnectionTestResult,
  type HermesProfileDiscoveryTestResult,
  type HermesSetupConnection,
} from "../server/desktop/hermes-connection-test.js";
import {
  browserSecurityHeaders,
  type LocalApiAccess,
} from "../server/security/local-api-access.js";
import {
  closeHttpServer,
  listenOnLoopback,
} from "../server/server-lifecycle.js";
import type { DesktopRuntimePort } from "./application.js";
import { SETUP_CSS, SETUP_HTML } from "./setup-page.js";
import { SETUP_JAVASCRIPT } from "./setup-client.js";

const emptyBodySchema = z.strictObject({});
const confirmedResetSchema = z.strictObject({ confirm: z.literal(true) });
const replacementSchema = z.string().trim().max(4_096);
const verificationSecretReplacementSchema = replacementSchema.refine(
  (value) => value === "" || isRecallVerificationSecret(value),
);
const recallNgrokInputSchema = z.strictObject({
  ngrokDomain: ngrokDomainSchema,
  recallApiKey: replacementSchema,
  recallWebhookVerificationSecret: verificationSecretReplacementSchema,
  ngrokAuthtoken: replacementSchema,
});
const portSchema = z.number().int().min(1).max(65_535);
const endpointPathSchema = z.union([
  z.literal("/"),
  z.string().regex(/^\/p\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
]);
const profileSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    }),
  );
const hermesConnectionInputSchema = z
  .strictObject({
    hermesMode: z.enum(["local", "ssh"]),
    hermesLocalPort: portSchema,
    hermesRemotePort: portSchema,
    hermesSshTarget: hermesSshTargetSchema.nullable(),
    hermesEndpointPath: endpointPathSchema.default("/"),
    hermesApiKey: replacementSchema,
  })
  .superRefine((value, context) => {
    if (value.hermesMode === "ssh" && value.hermesSshTarget === null) {
      context.addIssue({
        code: "custom",
        path: ["hermesSshTarget"],
        message: "SSH mode requires a target.",
      });
    }
    if (value.hermesMode === "local" && value.hermesSshTarget !== null) {
      context.addIssue({
        code: "custom",
        path: ["hermesSshTarget"],
        message: "Local mode cannot store an SSH target.",
      });
    }
  });
const hermesAssistantInputSchema = hermesConnectionInputSchema.safeExtend({
  hermesProfile: profileSchema,
});
const connectionSaveInputSchema = recallNgrokInputSchema
  .safeExtend({
    hermesMode: z.enum(["local", "ssh"]).nullable(),
    hermesLocalPort: portSchema,
    hermesRemotePort: portSchema,
    hermesSshTarget: hermesSshTargetSchema.nullable(),
    hermesEndpointPath: endpointPathSchema.default("/"),
    hermesProfile: profileSchema.nullable(),
    hermesApiKey: replacementSchema,
  })
  .superRefine((value, context) => {
    if (value.hermesMode === null) {
      if (value.hermesSshTarget !== null || value.hermesProfile !== null) {
        context.addIssue({
          code: "custom",
          path: ["hermesMode"],
          message: "Disabled Hermes cannot store a target or profile.",
        });
      }
      return;
    }
    if (value.hermesProfile === null) {
      context.addIssue({
        code: "custom",
        path: ["hermesProfile"],
        message: "Configured Hermes requires an explicit profile.",
      });
    }
    if (value.hermesMode === "ssh" && value.hermesSshTarget === null) {
      context.addIssue({
        code: "custom",
        path: ["hermesSshTarget"],
        message: "SSH mode requires a target.",
      });
    }
    if (value.hermesMode === "local" && value.hermesSshTarget !== null) {
      context.addIssue({
        code: "custom",
        path: ["hermesSshTarget"],
        message: "Local mode cannot store an SSH target.",
      });
    }
  });

export type SetupConnectionStoragePort = {
  initialize(): Promise<ConnectionStorageStatus>;
  loadActiveAuthority(): Promise<ActiveConnectionAuthority | null>;
  resetCredentials(): Promise<ConnectionStorageStatus>;
  save(
    input: Parameters<ConnectionStorage["save"]>[0],
  ): Promise<ConnectionStorageStatus>;
};

export type SetupConnectionTesterPort = {
  test(
    input: RecallNgrokConnectionTestInput,
  ): Promise<RecallNgrokConnectionTestResult>;
};

export type SetupHermesConnectionTesterPort = {
  discover(
    input: HermesSetupConnection,
  ): Promise<HermesProfileDiscoveryTestResult>;
  testAssistant(
    input: HermesSetupConnection & { profile: string },
  ): Promise<HermesAssistantConnectionTestResult>;
};

export async function startDesktopSetupRuntime(options: {
  localApiAccess: LocalApiAccess;
  storage: SetupConnectionStoragePort;
  connectionTester?: SetupConnectionTesterPort;
  hermesConnectionTester?: SetupHermesConnectionTesterPort;
  initialStatus: ConnectionStorageStatus;
  requestReload(): Promise<"blocked" | "reloaded">;
  listenPort?: number;
}): Promise<DesktopRuntimePort> {
  let status = options.initialStatus;
  let reloadQueued = false;
  let returnState: "idle" | "pending" | "blocked" | "reloaded" = "idle";
  let saveAwaitingAcknowledgement = false;
  let connectionTestRunning = false;
  let connectionTestCleanupBlocked = false;
  let hermesOperationRunning = false;
  let hermesCleanupBlocked = false;
  let connectionSettingsUpdateRunning = false;
  let closing = false;
  const activeOperations = new Set<Promise<void>>();
  const connectionTester =
    options.connectionTester ?? new RecallNgrokConnectionTester();
  const hermesConnectionTester =
    options.hermesConnectionTester ?? new HermesConnectionTester();
  const app = express();
  app.disable("x-powered-by");
  app.use(browserSecurityHeaders());
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(options.localApiAccess.hostMiddleware());
  app.use(options.localApiAccess.middleware());
  app.use(express.json({ limit: 8_192, strict: true }));
  app.use((_request, response, next) => {
    if (closing) {
      response.status(503).json({ error: "Setup is closing." });
      return;
    }
    next();
  });

  app.use((request, response, next) => {
    if (
      reloadQueued &&
      request.method !== "GET" &&
      request.path !== "/api/setup/reload"
    ) {
      response.status(409).json({
        error:
          "Setup reload is pending. Quit and reopen Convo Caddy if it does not finish.",
      });
      return;
    }
    next();
  });
  app.get("/", (_request, response) => {
    const packagedGuide = new URL(
      "./hermes-connection-setup.md",
      import.meta.url,
    );
    const guide = readFileSync(
      existsSync(packagedGuide)
        ? packagedGuide
        : new URL("../../docs/hermes-connection-setup.md", import.meta.url),
      "utf8",
    );
    response
      .status(200)
      .type("html")
      .send(
        // Keep dollar sequences in displayed commands literal.
        SETUP_HTML.replace("<!--REMOTE_GUIDE-->", () =>
          renderSetupGuide(guide),
        ),
      );
  });
  app.get("/setup.css", (_request, response) => {
    response
      .status(200)
      .type("css")
      .send(
        `main{width:100%}${SETUP_CSS}section{grid-template-columns:38px minmax(0,1fr)}section>div{min-width:0}@media(max-width:560px){section{grid-template-columns:28px minmax(0,1fr)}}`,
      );
  });
  app.get("/setup.js", (_request, response) => {
    response.status(200).type("application/javascript").send(SETUP_JAVASCRIPT);
  });
  app.get("/fonts/instrument-sans.woff2", (_request, response) => {
    const packagedFont = new URL("./instrument-sans.woff2", import.meta.url);
    response
      .status(200)
      .type("font/woff2")
      .send(
        readFileSync(
          existsSync(packagedFont)
            ? packagedFont
            : path.resolve(
                "node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2",
              ),
        ),
      );
  });
  app.get("/api/setup", (_request, response) => {
    response.status(200).json(redactedOverview(status));
  });
  app.post("/api/setup/reconcile", async (request, response, next) => {
    if (!parseBody(emptyBodySchema, request.body, response)) {
      return;
    }
    if (
      connectionSettingsUpdateRunning ||
      connectionTestRunning ||
      connectionTestCleanupBlocked ||
      hermesOperationRunning ||
      hermesCleanupBlocked
    ) {
      response.status(409).json({
        error: "Another setup operation or cleanup is still pending.",
      });
      return;
    }
    connectionSettingsUpdateRunning = true;
    const finishOperation = beginSetupOperation();
    try {
      status = await options.storage.initialize();
      response.status(200).json(redactedOverview(status));
    } catch (error) {
      next(error);
    } finally {
      connectionSettingsUpdateRunning = false;
      finishOperation();
    }
  });
  app.put("/api/setup/connections", async (request, response, next) => {
    const input = parseBody(connectionSaveInputSchema, request.body, response);
    if (input === null) {
      return;
    }
    if (
      connectionSettingsUpdateRunning ||
      connectionTestRunning ||
      connectionTestCleanupBlocked ||
      hermesOperationRunning ||
      hermesCleanupBlocked
    ) {
      response.status(409).json({
        error: connectionTestCleanupBlocked
          ? "Recall/ngrok cleanup is unconfirmed. Quit Convo Caddy before changing connection settings."
          : connectionTestRunning
            ? "A Recall/ngrok connection test is already in progress."
            : hermesCleanupBlocked
              ? "Hermes cleanup is unconfirmed. Quit Convo Caddy before changing connection settings."
              : hermesOperationRunning
                ? "A Hermes connection operation is already in progress."
                : "Connection settings are already being updated.",
      });
      return;
    }
    connectionSettingsUpdateRunning = true;
    const finishOperation = beginSetupOperation();
    try {
      const connection = connectionConfigurationFromSettings(status.settings);
      status = await options.storage.save({
        connection: {
          ...connection,
          recall: { region: "us-west-2", language: "en" },
          ngrok: { domain: input.ngrokDomain },
          hermes: {
            mode: input.hermesMode,
            localPort: input.hermesLocalPort,
            remotePort: input.hermesRemotePort,
            sshTarget: input.hermesSshTarget,
            endpointPath: input.hermesEndpointPath,
            profile: input.hermesProfile,
          },
        },
        replacements: {
          "recall-api-key": input.recallApiKey,
          "recall-webhook-verification-secret":
            input.recallWebhookVerificationSecret,
          "ngrok-authtoken": input.ngrokAuthtoken,
          "hermes-api-key": input.hermesApiKey,
        },
      });
      if (
        status.kind === "needs_attention" &&
        status.code === "candidate_cleanup_failed"
      ) {
        saveAwaitingAcknowledgement = false;
        response.status(409).json({
          error:
            "Settings were not saved because prior credential cleanup is incomplete. Your draft is retained; resolve credential cleanup before retrying.",
        });
        return;
      }
      saveAwaitingAcknowledgement = true;
      response.status(200).json(redactedOverview(status));
    } catch (error) {
      next(error);
    } finally {
      connectionSettingsUpdateRunning = false;
      finishOperation();
    }
  });
  app.post("/api/setup/connections/test", async (request, response, next) => {
    const input = parseBody(recallNgrokInputSchema, request.body, response);
    if (input === null) {
      return;
    }
    if (connectionTestRunning) {
      response
        .status(409)
        .json({ error: "A connection test is already in progress." });
      return;
    }
    if (connectionSettingsUpdateRunning || hermesOperationRunning) {
      response
        .status(409)
        .json({ error: "Another setup operation is already in progress." });
      return;
    }
    connectionTestRunning = true;
    const finishOperation = beginSetupOperation();
    try {
      const initialAuthority = await options.storage.loadActiveAuthority();
      const testInput = resolveConnectionTestInput(input, initialAuthority);
      const result = await connectionTester.test(testInput);
      const currentAuthority = await options.storage.loadActiveAuthority();
      if (
        (initialAuthority?.generation ?? null) !==
        (currentAuthority?.generation ?? null)
      ) {
        response.status(409).json({
          state: "stale",
          generation: result.generation,
        });
        return;
      }
      response.status(200).json(result);
    } catch (error) {
      if (
        error instanceof RecallNgrokConnectionTestError &&
        error.code === "test_in_progress"
      ) {
        response
          .status(409)
          .json({ error: "A connection test is already in progress." });
        return;
      }
      if (
        error instanceof RecallNgrokConnectionTestError &&
        error.code === "cleanup_failed"
      ) {
        connectionTestCleanupBlocked = true;
        response.status(500).json({
          error:
            "Connection-test cleanup could not be confirmed. Quit Convo Caddy before trying again.",
        });
        return;
      }
      if (error instanceof SetupInputError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    } finally {
      connectionTestRunning = false;
      finishOperation();
    }
  });
  app.post(
    "/api/setup/connections/hermes/discover",
    async (request, response, next) => {
      const input = parseBody(
        hermesConnectionInputSchema,
        request.body,
        response,
      );
      if (input === null) {
        return;
      }
      if (
        connectionSettingsUpdateRunning ||
        connectionTestRunning ||
        hermesOperationRunning ||
        hermesCleanupBlocked
      ) {
        response.status(409).json({
          error:
            connectionSettingsUpdateRunning || connectionTestRunning
              ? "Connection settings are being updated."
              : hermesCleanupBlocked
                ? "Hermes cleanup is unconfirmed. Quit Convo Caddy before trying again."
                : "A Hermes connection operation is already in progress.",
        });
        return;
      }
      hermesOperationRunning = true;
      const finishOperation = beginSetupOperation();
      try {
        const initialAuthority = await options.storage.loadActiveAuthority();
        const testInput = resolveHermesConnectionInput(input, initialAuthority);
        const result = await hermesConnectionTester.discover(testInput);
        const currentAuthority = await options.storage.loadActiveAuthority();
        if (!sameGeneration(initialAuthority, currentAuthority)) {
          response.status(409).json({
            state: "stale",
            generation: result.generation,
          });
          return;
        }
        response.status(200).json(result);
      } catch (error) {
        handleHermesSetupError(error, response, next);
      } finally {
        hermesOperationRunning = false;
        finishOperation();
      }
    },
  );
  app.post(
    "/api/setup/connections/hermes/test",
    async (request, response, next) => {
      const input = parseBody(
        hermesAssistantInputSchema,
        request.body,
        response,
      );
      if (input === null) {
        return;
      }
      if (
        connectionSettingsUpdateRunning ||
        connectionTestRunning ||
        hermesOperationRunning ||
        hermesCleanupBlocked
      ) {
        response.status(409).json({
          error:
            connectionSettingsUpdateRunning || connectionTestRunning
              ? "Connection settings are being updated."
              : hermesCleanupBlocked
                ? "Hermes cleanup is unconfirmed. Quit Convo Caddy before trying again."
                : "A Hermes connection operation is already in progress.",
        });
        return;
      }
      hermesOperationRunning = true;
      const finishOperation = beginSetupOperation();
      try {
        const initialAuthority = await options.storage.loadActiveAuthority();
        const testInput = resolveHermesConnectionInput(input, initialAuthority);
        const result = await hermesConnectionTester.testAssistant({
          ...testInput,
          profile: input.hermesProfile,
        });
        const currentAuthority = await options.storage.loadActiveAuthority();
        if (!sameGeneration(initialAuthority, currentAuthority)) {
          response.status(409).json({
            state: "stale",
            generation: result.generation,
          });
          return;
        }
        response.status(200).json(result);
      } catch (error) {
        handleHermesSetupError(error, response, next);
      } finally {
        hermesOperationRunning = false;
        finishOperation();
      }
    },
  );
  app.delete("/api/setup/credentials", async (request, response, next) => {
    if (!parseBody(confirmedResetSchema, request.body, response)) {
      return;
    }
    if (
      connectionSettingsUpdateRunning ||
      connectionTestRunning ||
      connectionTestCleanupBlocked ||
      hermesOperationRunning ||
      hermesCleanupBlocked
    ) {
      response.status(409).json({
        error: connectionTestCleanupBlocked
          ? "Recall/ngrok cleanup is unconfirmed. Quit Convo Caddy before changing connection settings."
          : connectionTestRunning
            ? "A Recall/ngrok connection test is already in progress."
            : hermesCleanupBlocked
              ? "Hermes cleanup is unconfirmed. Quit Convo Caddy before changing connection settings."
              : hermesOperationRunning
                ? "A Hermes connection operation is already in progress."
                : "Connection settings are already being updated.",
      });
      return;
    }
    connectionSettingsUpdateRunning = true;
    const finishOperation = beginSetupOperation();
    // Accepted Reset retires the previous Save acknowledgement before yielding
    // to storage. A failed reset must not restore permission for old teardown.
    saveAwaitingAcknowledgement = false;
    try {
      status = await options.storage.resetCredentials();
      response.status(200).json(redactedOverview(status));
    } catch (error) {
      next(error);
    } finally {
      connectionSettingsUpdateRunning = false;
      finishOperation();
    }
  });
  app.get("/api/setup/reload", (_request, response) =>
    response.json({ state: returnState }),
  );
  app.post("/api/setup/reload", (request, response) => {
    if (parseBody(emptyBodySchema, request.body, response) === null) {
      return;
    }
    if (reloadQueued) {
      response.status(202).json({ accepted: true });
      return;
    }
    if (
      status.kind !== "ready" ||
      activeOperations.size > 0 ||
      connectionTestCleanupBlocked ||
      hermesCleanupBlocked ||
      reloadQueued
    ) {
      response.status(409).json({
        error:
          status.kind !== "ready"
            ? "Complete setup and Save before returning to the app."
            : "Wait for the current operation to finish before returning to the app.",
      });
      return;
    }
    returnState = "pending";
    queueReloadAfterResponse(response, true);
    response.status(202).json({ accepted: true });
  });
  app.post("/api/setup/save-acknowledgement", (request, response) => {
    if (parseBody(emptyBodySchema, request.body, response) === null) return;
    if (!saveAwaitingAcknowledgement) {
      response.status(409).json({
        error: "No saved settings are awaiting acknowledgement.",
      });
      return;
    }
    saveAwaitingAcknowledgement = false;
    queueReloadAfterResponse(response);
    response.status(202).json({ accepted: true });
  });
  app.use((_request, response) => {
    response.status(404).json({ error: "Setup route not found." });
  });
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (isBodyTooLarge(error)) {
        response.status(413).json({ error: "Setup request is too large." });
        return;
      }
      if (error instanceof SyntaxError) {
        response.status(400).json({ error: "Setup request is invalid." });
        return;
      }
      if (error instanceof SecretStoreError) {
        const advice = {
          access_denied:
            "macOS denied Keychain access. Allow Convo Caddy access in the macOS prompt, then retry Save.",
          unavailable:
            "Keychain did not respond or is unavailable. Unlock your login keychain in Keychain Access, then retry Save.",
          write_failed:
            "Keychain could not save and verify the new credentials. Retry Save; use code keychain_write_failed to troubleshoot if it repeats.",
          missing:
            "A saved Keychain item is missing. Enter its replacement in the masked field, then retry Save.",
          malformed:
            "A saved Keychain item could not be read correctly. Enter replacement credentials, then retry Save.",
          invalid_request:
            "Connection credentials are missing or invalid. Fill the Recall key, verification secret and ngrok token, then retry Save.",
          delete_failed:
            "Keychain cleanup could not finish. Check Keychain access before retrying; do not reset your draft.",
        }[error.code];
        response.status(500).json({
          code: `keychain_${error.code}`,
          error: `${advice} Your unsaved entries are still here.`,
        });
        return;
      }
      const fileCode =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      if (["EACCES", "EPERM", "EROFS", "ENOSPC"].includes(String(fileCode))) {
        response.status(500).json({
          code: "settings_storage_unavailable",
          error:
            "Setup storage could not be written. Check free disk space and permission for Convo Caddy’s app data, then retry Save. Your unsaved entries are still here.",
        });
        return;
      }
      response.status(500).json({
        code: "setup_unknown",
        error:
          "Setup operation failed (setup_unknown). Your unsaved entries are still here. Use this code and the button you clicked to troubleshoot. If seeking help, share only those details, never credentials or request contents.",
      });
    },
  );

  const server = createServer(app);
  const address = await listenOnLoopback(
    server,
    options.listenPort ?? 0,
    "127.0.0.1",
  );
  options.localApiAccess.bindOrigin(address.url);
  let closePromise: Promise<void> | null = null;
  return {
    mode: "setup",
    applicationUrl: address.url,
    getQuitRisk: () => null,
    close: () => {
      closePromise ??= closeSetupRuntime();
      return closePromise;
    },
  };

  async function closeSetupRuntime(): Promise<void> {
    closing = true;
    const serverCloseResult = closeHttpServer(server).then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.all([...activeOperations]);
    const serverCloseError = await serverCloseResult;
    if (connectionTestCleanupBlocked || hermesCleanupBlocked) {
      throw new Error("Connection-test endpoint cleanup is still pending.");
    }
    if (serverCloseError !== null) {
      throw serverCloseError;
    }
  }

  function beginSetupOperation(): () => void {
    let finish: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    activeOperations.add(completion);
    return () => {
      activeOperations.delete(completion);
      finish();
    };
  }

  function queueReloadAfterResponse(
    response: Response,
    returning = false,
  ): void {
    if (reloadQueued) {
      return;
    }
    reloadQueued = true;
    response.once("finish", () => {
      queueMicrotask(() => {
        void options
          .requestReload()
          .catch(() => "blocked" as const)
          .then((result) => {
            if (returning) returnState = result;
          })
          .finally(() => {
            reloadQueued = false;
          });
      });
    });
  }

  function handleHermesSetupError(
    error: unknown,
    response: Response,
    next: NextFunction,
  ): void {
    if (error instanceof HermesConnectionTestError) {
      if (error.code === "cleanup_failed") {
        hermesCleanupBlocked = true;
        response.status(500).json({
          error:
            "Hermes cleanup could not be confirmed. Quit Convo Caddy before trying again.",
        });
        return;
      }
      response.status(409).json({
        error: "A Hermes connection operation is already in progress.",
      });
      return;
    }
    if (error instanceof SetupInputError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
}

function parseBody<T extends z.ZodType>(
  schema: T,
  value: unknown,
  response: Response,
): z.infer<T> | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    response.status(400).json({ error: "Setup request is invalid." });
    return null;
  }
  return parsed.data;
}

function redactedOverview(status: ConnectionStorageStatus) {
  return {
    mode: status.kind,
    code: status.kind === "needs_attention" ? status.code : null,
    recallRegion: "us-west-2" as const,
    recallLanguage: "en" as const,
    ngrokDomain: status.settings.ngrok.domain,
    webhookUrl:
      status.settings.ngrok.domain === null
        ? null
        : `https://${status.settings.ngrok.domain}/api/capture/recall/webhook`,
    hermesMode: status.settings.hermes.mode,
    hermesLocalPort: status.settings.hermes.localPort,
    hermesRemotePort: status.settings.hermes.remotePort,
    hermesSshTarget: status.settings.hermes.sshTarget,
    hermesEndpointPath: status.settings.hermes.endpointPath,
    hermesProfile: status.settings.hermes.profile,
    configured: status.configured,
    cleanupPending: status.cleanupPending,
  };
}

function nonBlankReplacement(value: string): string | null {
  return value === "" ? null : value;
}

function isRecallVerificationSecret(value: string): boolean {
  const encoded = value.startsWith("whsec_")
    ? value.slice("whsec_".length)
    : "";
  return (
    encoded.length > 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) &&
    Buffer.from(encoded, "base64").byteLength > 0
  );
}

function resolveConnectionTestInput(
  input: z.infer<typeof recallNgrokInputSchema>,
  authority: ActiveConnectionAuthority | null,
): RecallNgrokConnectionTestInput {
  const recallApiKey =
    nonBlankReplacement(input.recallApiKey) ??
    authority?.secrets["recall-api-key"];
  const recallWebhookVerificationSecret =
    nonBlankReplacement(input.recallWebhookVerificationSecret) ??
    authority?.secrets["recall-webhook-verification-secret"];
  const ngrokAuthtoken =
    nonBlankReplacement(input.ngrokAuthtoken) ??
    authority?.secrets["ngrok-authtoken"];
  if (!recallApiKey || !recallWebhookVerificationSecret || !ngrokAuthtoken) {
    throw new SetupInputError(
      "Enter or save all three Recall and ngrok credentials before testing.",
    );
  }
  return {
    generation: authority?.generation ?? randomUUID(),
    recallApiKey,
    recallWebhookVerificationSecret,
    ngrokAuthtoken,
    ngrokDomain: input.ngrokDomain,
  };
}

function resolveHermesConnectionInput(
  input: z.infer<typeof hermesConnectionInputSchema>,
  authority: ActiveConnectionAuthority | null,
): HermesSetupConnection {
  const apiKey =
    nonBlankReplacement(input.hermesApiKey) ??
    authority?.secrets["hermes-api-key"];
  if (!apiKey) {
    throw new SetupInputError(
      "Enter or save the Hermes API key before testing.",
    );
  }
  return {
    generation: authority?.generation ?? randomUUID(),
    mode: input.hermesMode,
    baseUrl: `http://127.0.0.1:${input.hermesLocalPort}${input.hermesEndpointPath === "/" ? "" : input.hermesEndpointPath}`,
    localPort: input.hermesLocalPort,
    remotePort: input.hermesRemotePort,
    sshTarget: input.hermesSshTarget,
    apiKey,
  };
}

function sameGeneration(
  first: ActiveConnectionAuthority | null,
  second: ActiveConnectionAuthority | null,
): boolean {
  return (first?.generation ?? null) === (second?.generation ?? null);
}

class SetupInputError extends Error {}

function isBodyTooLarge(error: unknown): boolean {
  return (
    error instanceof Error &&
    "type" in error &&
    (error as Error & { type?: string }).type === "entity.too.large"
  );
}
