import { readFileSync } from "node:fs";
import path from "node:path";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { createLiveSessionService } from "../../src/server/session-service.js";

// Actual startup and checkpoint writer; the capture provider is entirely fake.
export async function produceUninstallCheckpoints(root: string) {
  const repository = new FileSessionRepository(root);
  const service = createLiveSessionService({
    repository,
    createId: () => "11111111-2222-4333-8444-555555555555",
    now: () => new Date("2026-09-10T12:00:00.000Z"),
    captureProvider: {
      region: "us-west-2",
      createBot: async () => ({ botId: "synthetic-uninstall-bot" }),
      stopRecordingNotice: async () => {},
    },
  });
  const read = () =>
    readFileSync(path.join(root, "active-session.json"), "utf8");
  const idle = read();
  const started = await service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  if (!started.ok) throw new Error("Synthetic capture fixture did not start.");
  const state = service.getSnapshot();
  if (state.capture.mode !== "recall")
    throw new Error("Expected fake Recall state.");
  state.capture.operationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  repository.save(state, []);
  const joining = read();
  state.capture.status = "ended";
  repository.save(state, []);
  const ended = read();
  state.capture.status = "failed";
  state.capture.error = "Synthetic failure; remote state unknown.";
  repository.save(state, []);
  return { idle, joining, ended, failed: read() };
}
