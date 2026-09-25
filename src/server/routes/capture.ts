import { Router } from "express";
import { z } from "zod";
import type { SessionService } from "../session-service.js";
import { meetingPlatformSchema } from "../../domain/capture.js";

const startCaptureSchema = z.strictObject({
  meetingPlatform: meetingPlatformSchema.default("microsoft_teams_personal"),
  meetingUrl: z.string().url(),
  displayName: z.string().trim().min(1).max(80).optional(),
});

export function createCaptureRouter(service: SessionService): Router {
  const router = Router();

  router.post("/capture/recall/start", async (request, response) => {
    const input = startCaptureSchema.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({
        error:
          "Choose a supported meeting platform and enter its meeting link.",
      });
      return;
    }

    const result = await service.startRecallCapture(input.data);
    const status = result.ok
      ? 201
      : result.kind === "invalid"
        ? 400
        : result.kind === "conflict"
          ? 409
          : 502;
    response.status(status).json(result);
  });

  return router;
}
