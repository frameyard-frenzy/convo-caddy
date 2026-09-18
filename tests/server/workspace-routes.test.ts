import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { SessionService } from "../../src/server/session-service.js";
import { initializeUserWorkspace } from "../../src/server/workspace/user-workspace.js";

describe("workspace routes", () => {
  it("indexes errors separately and starts from selected exact prep", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workspace-routes-"));
    initializeUserWorkspace(root);
    writeFileSync(
      path.join(root, "prep/current/good.json"),
      JSON.stringify({
        schemaVersion: 1,
        title: "Good",
        plannedDurationMinutes: 20,
        topics: [{ tier: "must", text: "One question" }],
      }),
    );
    writeFileSync(path.join(root, "prep/current/bad.json"), "{");
    const service = new SessionService({
      topics: [],
      transcript: [],
      provider: new FakeMartyProvider(),
      repository: new FileSessionRepository(
        mkdtempSync(path.join(tmpdir(), "private-state-")),
      ),
      userWorkspaceRoot: root,
      initialCaptureMode: "live_ready",
    });
    const app = createApp({ service });
    const scan = await request(app).get("/api/workspace").expect(200);
    expect(
      scan.body.workspace.prep.valid.map(
        (entry: { basename: string }) => entry.basename,
      ),
    ).toEqual(["good.json"]);
    expect(scan.body.workspace.prep.errors[0].basename).toBe("bad.json");
    const selected = await request(app)
      .post("/api/workspace/prep/select")
      .send({ basename: "good.json" })
      .expect(200);
    expect(selected.body.state.topics).toMatchObject([
      { tier: "must", text: "One question", checked: false },
    ]);
  });
});

it("reports workspace location with readiness without scanning prep or finished transcript bodies", async () => {
  const service = new SessionService({
    topics: [],
    transcript: [],
    provider: new FakeMartyProvider(),
    userWorkspaceRoot: "/synthetic/unavailable-workspace",
  });
  const result = await request(createApp({ service }))
    .get("/api/runtime/readiness")
    .expect(200);
  expect(result.body.workspaceRoot).toBe("/synthetic/unavailable-workspace");
  service.close();
});

it("preserves person summary through explicit structured prep saves", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "caddy-summary-route-"));
  initializeUserWorkspace(root);
  const service = new SessionService({
    topics: [],
    transcript: [],
    provider: new FakeMartyProvider(),
    repository: new FileSessionRepository(path.join(root, "private")),
    userWorkspaceRoot: root,
  });
  const prep = {
    schemaVersion: 1,
    title: "Synthetic",
    plannedDurationMinutes: 30,
    personSummary: ["Human context"],
    topics: [{ tier: "must", text: "Why?" }],
  };
  const response = await request(createApp({ service }))
    .put("/api/workspace/prep")
    .send({ basename: "summary.md", expectedSourceBytes: null, prep })
    .expect(200);
  expect(response.body.prep.prep.personSummary).toEqual(["Human context"]);
  service.close();
});
