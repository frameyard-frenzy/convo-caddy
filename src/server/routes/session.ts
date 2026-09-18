import { Router } from "express";
import { z } from "zod";
import type { SessionService, SimulationAction } from "../session-service.js";

const checkedSchema = z.object({ checked: z.boolean() });
const simulationBodySchema = z.object({
  speed: z.number().positive().optional(),
});
const simulationActionSchema = z.enum([
  "start",
  "pause",
  "resume",
  "step",
  "reset",
]);

export function createSessionRouter(
  service: SessionService,
  exposeTestControls: boolean,
): Router {
  const router = Router();

  router.get("/session", (_request, response) => {
    response.json({
      state: service.getSnapshot(),
      diagnostics: { providerCallCount: service.getProviderCallCount() },
    });
  });

  router.post("/session/content/open", (_request, response) => {
    try {
      response.json({ state: service.openContentEditing() });
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : "Editing could not be opened safely.",
      });
    }
  });

  router.post("/session/content", (request, response) => {
    try {
      response.json({ state: service.editContent(request.body) });
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error ? error.message : "Edit could not be saved.",
      });
    }
  });

  router.post("/session/save", (request, response) => {
    try {
      response.json({ state: service.saveCurrentContent(request.body) });
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : "Save failed. Your draft was kept.",
      });
    }
  });

  router.get("/sessions", (_request, response) => {
    response.json({ sessions: service.listSessions() });
  });

  router.post("/session/new", (_request, response) => {
    try {
      response.status(201).json({
        state: service.startNextSession(),
        sessions: service.listSessions(),
      });
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : "The next interview could not be started.",
      });
    }
  });

  registerCheckedRoute(
    router,
    "/session/topics/:itemId/check",
    (id, checked) => service.setTopicChecked(id, checked),
    service,
  );
  registerCheckedRoute(
    router,
    "/session/revisit/:itemId/check",
    (id, checked) => service.setRevisitChecked(id, checked),
    service,
  );
  registerCheckedRoute(
    router,
    "/session/questions/:itemId/check",
    (id, checked) => service.setQuestionChecked(id, checked),
    service,
  );

  router.post("/session/simulation/:action", (request, response) => {
    const action = simulationActionSchema.safeParse(request.params.action);
    const body = simulationBodySchema.safeParse(request.body);
    if (!action.success || !body.success) {
      response.status(400).json({ error: "Invalid simulation action." });
      return;
    }

    try {
      response.json({
        state: service.controlSimulation(
          action.data as SimulationAction,
          body.data.speed,
        ),
      });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Simulation failed.",
      });
    }
  });

  if (exposeTestControls) {
    router.post("/test/provider/fail-next", (request, response) => {
      const message = z
        .object({ message: z.string().min(1).optional() })
        .safeParse(request.body);
      if (
        !message.success ||
        !service.failNextFakeProvider(message.data.message)
      ) {
        response.status(400).json({ error: "Fake provider is unavailable." });
        return;
      }
      response.status(204).end();
    });
  }

  return router;
}

function registerCheckedRoute(
  router: Router,
  path: string,
  update: (id: string, checked: boolean) => boolean,
  service: SessionService,
): void {
  router.post(path, (request, response) => {
    const body = checkedSchema.safeParse(request.body);
    if (!body.success) {
      response.status(400).json({ error: "checked must be a boolean." });
      return;
    }

    const itemId = z.string().safeParse(request.params.itemId);
    if (!itemId.success || !update(itemId.data, body.data.checked)) {
      response.status(404).json({ error: "Item not found." });
      return;
    }

    response.json({ state: service.getSnapshot() });
  });
}
