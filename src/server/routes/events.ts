import { Router } from "express";
import type { SessionService } from "../session-service.js";

export function createEventsRouter(service: SessionService): Router {
  const router = Router();

  router.get("/events", (request, response) => {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const send = (state: ReturnType<SessionService["getSnapshot"]>) => {
      response.write(`event: session\ndata: ${JSON.stringify(state)}\n\n`);
    };
    send(service.getSnapshot());
    const unsubscribe = service.subscribe(send);
    request.on("close", unsubscribe);
  });

  return router;
}
