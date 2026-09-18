import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import {
  LOCAL_API_COOKIE_NAME,
  LocalApiAccess,
} from "../../src/server/security/local-api-access.js";
import { SessionService } from "../../src/server/session-service.js";

const applicationOrigin = "http://127.0.0.1:4317";
const launchToken = "a".repeat(43);

describe("desktop local API access", () => {
  it("requires same-origin authority for connection retry and never exposes thrown detail", async () => {
    const retryHermes = vi.fn(async () => undefined);
    const { app, cookie } = createProtectedApp({ retryHermes });
    await request(app)
      .post("/api/runtime/hermes/retry")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", cookie)
      .set("Origin", "https://attacker.example")
      .send({})
      .expect(403);
    expect(retryHermes).not.toHaveBeenCalled();
    await request(app)
      .post("/api/runtime/hermes/retry")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", cookie)
      .set("Origin", applicationOrigin)
      .send({})
      .expect(200);
    expect(retryHermes).toHaveBeenCalledOnce();
    retryHermes.mockRejectedValueOnce(new Error("PRIVATE SSH ERROR"));
    const failed = await request(app)
      .post("/api/runtime/hermes/retry")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", cookie)
      .set("Origin", applicationOrigin)
      .send({})
      .expect(503);
    expect(failed.text).not.toContain("PRIVATE");
  });

  it("rejects every API route without the per-launch cookie", async () => {
    const { app } = createProtectedApp();

    await request(app)
      .post("/api/runtime/hermes/retry")
      .set("Host", new URL(applicationOrigin).host)
      .expect(401);
    await request(app)
      .get("/api/health")
      .set("Host", new URL(applicationOrigin).host)
      .expect(401);
    await request(app)
      .get("/api/session")
      .set("Host", new URL(applicationOrigin).host)
      .expect(401);
    await request(app)
      .get("/api/events")
      .set("Host", new URL(applicationOrigin).host)
      .expect(401);
    await request(app)
      .get("/api/exports")
      .set("Host", new URL(applicationOrigin).host)
      .expect(401);
  });

  it("accepts one exact per-launch cookie and rejects duplicates", async () => {
    const { app, cookie } = createProtectedApp();

    await request(app)
      .get("/api/health")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", cookie)
      .expect(200);
    await request(app)
      .get("/api/health")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", `${cookie}; ${cookie}`)
      .expect(401);
  });

  it("rejects a mismatched Host before serving local API state", async () => {
    const { app, cookie } = createProtectedApp();

    const response = await request(app)
      .get("/")
      .set("Host", "attacker.example")
      .set("Cookie", cookie)
      .expect(421);
    expect(response.text).not.toContain("sessionId");
  });

  it("rejects a mismatched Host before serving client assets", async () => {
    const { app, cookie } = createProtectedApp();
    app.get("/client.js", (_request, response) =>
      response.send("client asset"),
    );

    const response = await request(app)
      .get("/client.js")
      .set("Host", "attacker.example")
      .set("Cookie", cookie)
      .expect(421);
    expect(response.text).not.toContain("client asset");
  });

  it("requires the exact local origin for mutations", async () => {
    const { app, cookie } = createProtectedApp();

    await request(app)
      .post("/api/input")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", cookie)
      .send({ input: "/note test", mutationId: "missing-origin" })
      .expect(403);
    await request(app)
      .post("/api/input")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", cookie)
      .set("Origin", "https://attacker.example")
      .send({ input: "/note test", mutationId: "wrong-origin" })
      .expect(403);
    for (const mutation of [
      request(app).post("/api/exports/automatic/select"),
      request(app).delete("/api/exports/automatic"),
      request(app).post("/api/sessions/session-one/export/manual"),
      request(app).post("/api/sessions/session-one/export/automatic/retry"),
    ]) {
      await mutation
        .set("Host", new URL(applicationOrigin).host)
        .set("Cookie", cookie)
        .expect(403);
    }
    await request(app)
      .post("/api/input")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", cookie)
      .set("Origin", applicationOrigin)
      .send({ input: "/note test", mutationId: "exact-origin" })
      .expect(200);
  });

  it("sets restrictive browser security headers without exposing credentials", async () => {
    const { app, cookie } = createProtectedApp();
    const response = await request(app)
      .get("/api/health")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", cookie)
      .expect(200);

    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(JSON.stringify(response.body)).not.toContain(launchToken);
  });

  it("allows Vite style injection only for the explicit development client", async () => {
    const production = createProtectedApp();
    const development = createProtectedApp({ allowViteInlineStyles: true });

    const productionResponse = await request(production.app)
      .get("/api/health")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", production.cookie)
      .expect(200);
    const developmentResponse = await request(development.app)
      .get("/api/health")
      .set("Host", new URL(applicationOrigin).host)
      .set("Cookie", development.cookie)
      .expect(200);

    expect(productionResponse.headers["content-security-policy"]).toContain(
      "style-src 'self';",
    );
    expect(productionResponse.headers["content-security-policy"]).not.toContain(
      "'unsafe-inline'",
    );
    expect(developmentResponse.headers["content-security-policy"]).toContain(
      "style-src 'self' 'unsafe-inline';",
    );
  });

  it("creates a host-only, HTTP-only, nonpersistent cookie for Electron", () => {
    const access = new LocalApiAccess(launchToken);
    access.bindOrigin(applicationOrigin);

    expect(access.createElectronCookie()).toEqual({
      url: applicationOrigin,
      name: LOCAL_API_COOKIE_NAME,
      value: launchToken,
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      path: "/",
    });
  });
});

function createProtectedApp(
  options: {
    allowViteInlineStyles?: boolean;
    retryHermes?: () => Promise<void>;
  } = {},
): {
  app: ReturnType<typeof createApp>;
  cookie: string;
} {
  const access = new LocalApiAccess(launchToken);
  access.bindOrigin(applicationOrigin);
  const service = new SessionService({
    topics: [],
    transcript: [],
    provider: new FakeMartyProvider(),
  });
  return {
    app: createApp({
      service,
      localApiAccess: access,
      ...options,
    }),
    cookie: `${LOCAL_API_COOKIE_NAME}=${launchToken}`,
  };
}
