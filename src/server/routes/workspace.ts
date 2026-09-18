import { isPreparation } from "../../domain/session-lifecycle.js";
import path from "node:path";
import { lstatSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { prepSchema as interviewPrepSchema } from "../workspace/prep-format.js";
import type { SessionService } from "../session-service.js";

const prepSchema = z.object({
  basename: z.string().min(1),
  prep: interviewPrepSchema,
  expectedSourceBytes: z.string().nullable(),
});

export function createWorkspaceRouter(
  service: SessionService,
  choosePrep?: (directory: string) => Promise<string | null>,
): Router {
  const router = Router();
  router.get("/workspace", (_request, response) =>
    response.json({ workspace: service.getWorkspaceOverview() }),
  );
  let choosing = false;
  router.post("/workspace/prep/choose", async (_request, response) => {
    if (choosing) {
      response.status(409).json({ error: "A prep chooser is already open." });
      return;
    }
    const releaseSelection = service.beginWriteRequest();
    choosing = true;
    try {
      const workspace = service.getWorkspaceOverview();
      const snapshot = service.getSnapshot();
      if (!workspace) throw new Error("User workspace is unavailable.");
      if (snapshot.capture.mode === "recall" && !isPreparation(snapshot))
        throw new Error("Prep cannot change after the interview starts.");
      if (!choosePrep) {
        response.json({
          kind: "browser",
          workspace,
          sessionId: snapshot.sessionId,
        });
        return;
      }
      const directory = path.join(workspace.root, "prep");
      const selected = await choosePrep(directory);
      if (selected === null) {
        response.json({ kind: "canceled" });
        return;
      }
      if (service.getSnapshot().sessionId !== snapshot.sessionId)
        throw new Error("The interview changed. Choose prep again.");
      const state = service.selectNativePrep(selected);
      response.json({
        kind: "selected",
        state,
        workspace: service.getWorkspaceOverview(),
      });
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : "Prep could not be selected.",
      });
    } finally {
      releaseSelection();
      choosing = false;
    }
  });
  router.post("/workspace/prep/select", (request, response) => {
    const body = z
      .object({ basename: z.string().min(1), sessionId: z.string().optional() })
      .safeParse(request.body);
    if (!body.success) {
      response.status(400).json({ error: "Choose a valid prep file." });
      return;
    }
    try {
      if (
        body.data.sessionId &&
        body.data.sessionId !== service.getSnapshot().sessionId
      )
        throw new Error("The interview changed. Choose prep again.");
      const root = service.getWorkspaceOverview()?.root;
      if (!root) throw new Error("User workspace is unavailable.");
      assertCurrentPrep(root, body.data.basename);
      response.json({
        state: service.selectPrep(body.data.basename),
        workspace: service.getWorkspaceOverview(),
      });
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : "Prep could not be selected.",
      });
    }
  });
  router.put("/workspace/prep", (request, response) => {
    const body = prepSchema.safeParse(request.body);
    if (!body.success) {
      response.status(400).json({ error: "Prep is invalid." });
      return;
    }
    try {
      response.json({
        prep: service.saveWorkspacePrep(
          body.data.basename,
          body.data.prep,
          body.data.expectedSourceBytes,
        ),
        workspace: service.getWorkspaceOverview(),
      });
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error ? error.message : "Prep could not be saved.",
      });
    }
  });
  router.post("/session/finish-saving", (request, response) => {
    try {
      service.retryFinalization(request.body);
      response.json({
        state: service.getSnapshot(),
        workspace: service.getWorkspaceOverview(),
      });
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error ? error.message : "Saving could not finish.",
      });
    }
  });
  return router;
}

function assertCurrentPrep(root: string, basename: string): void {
  if (
    path.basename(basename) !== basename ||
    ![".md", ".json"].includes(path.extname(basename).toLowerCase()) ||
    ["TEMPLATE.md", "TEMPLATE.json"].includes(basename)
  )
    throw new Error(
      "Choose a Markdown or legacy JSON prep file in prep/current.",
    );
  for (const directory of [
    path.join(root, "prep"),
    path.join(root, "prep/current"),
  ]) {
    if (!lstatSync(directory).isDirectory())
      throw new Error(
        "The prep/current folder must be a real workspace directory.",
      );
  }
  if (!lstatSync(path.join(root, "prep/current", basename)).isFile())
    throw new Error(
      "Choose a regular Markdown or legacy JSON prep file, not a link or directory.",
    );
}
