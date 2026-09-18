import { Router } from "express";
import { z } from "zod";
import type { SessionService } from "../session-service.js";

const inputSchema = z.object({
  input: z.string(),
  mutationId: z.string().min(1),
});

export function createInputRouter(service: SessionService): Router {
  const router = Router();

  router.post("/input", async (request, response) => {
    const submission = inputSchema.safeParse(request.body);
    if (!submission.success) {
      response.status(400).json({ error: "Invalid input submission." });
      return;
    }

    const result = await service.submitInput(submission.data);
    const status = result.ok
      ? 200
      : result.kind === "invalid_input"
        ? 400
        : 502;
    response.status(status).json(result);
  });

  return router;
}
