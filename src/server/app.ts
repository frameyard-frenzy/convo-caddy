import express, { type Express } from "express";
import type { RuntimeReadiness } from "./connectivity/readiness.js";
import { createCaptureRouter } from "./routes/capture.js";
import { createEventsRouter } from "./routes/events.js";
import { createInputRouter } from "./routes/input.js";
import { createSessionRouter } from "./routes/session.js";
import { createWorkspaceRouter } from "./routes/workspace.js";
import {
  browserSecurityHeaders,
  type LocalApiAccess,
} from "./security/local-api-access.js";
import type { SessionService } from "./session-service.js";

export type AppOptions = {
  service: SessionService;
  choosePrep?: (directory: string) => Promise<string | null>;
  exposeTestControls?: boolean;
  allowViteInlineStyles?: boolean;
  localApiAccess?: LocalApiAccess;
  retryHermes?: () => Promise<void>;
  readiness?: () => RuntimeReadiness | null;
};

export function createApp(options: AppOptions): Express {
  const app = express();
  const exposeTestControls = options.exposeTestControls ?? false;
  const service = options.service;

  app.disable("x-powered-by");
  app.use(
    browserSecurityHeaders({
      allowViteInlineStyles: options.allowViteInlineStyles ?? false,
    }),
  );
  if (options.localApiAccess) {
    app.use(options.localApiAccess.hostMiddleware());
    app.use("/api", options.localApiAccess.middleware());
  }
  app.use(express.json());
  app.use("/api", (request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      next();
      return;
    }
    try {
      const release = service.beginWriteRequest();
      response.once("finish", release);
      response.once("close", release);
      next();
    } catch (error) {
      response.status(409).json({
        error: error instanceof Error ? error.message : "Workspace is busy.",
      });
    }
  });
  app.get("/api/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });
  app.get("/api/runtime/readiness", (_request, response) => {
    response.status(200).json({
      readiness: options.readiness?.() ?? null,
      workspaceRoot: service.getWorkspaceRoot(),
    });
  });
  app.post("/api/runtime/hermes/retry", async (_request, response) => {
    if (!options.retryHermes) {
      response
        .status(409)
        .json({ error: "No managed Hermes connection is configured." });
      return;
    }
    try {
      await options.retryHermes();
      response.status(200).json({ readiness: options.readiness?.() ?? null });
    } catch {
      response.status(503).json({
        error:
          "Connection retry failed. Check network and SSH access, then retry.",
      });
    }
  });
  app.use("/api", createSessionRouter(service, exposeTestControls));
  app.use("/api", createInputRouter(service));
  app.use("/api", createCaptureRouter(service));
  app.use("/api", createWorkspaceRouter(service, options.choosePrep));
  app.use("/api", createEventsRouter(service));

  return app;
}
