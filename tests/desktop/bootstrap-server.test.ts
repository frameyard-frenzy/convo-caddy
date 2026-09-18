import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { startDesktopBootstrapServer } from "../../src/desktop/bootstrap-server.js";

describe("desktop bootstrap server", () => {
  it("opens a fixed local failure view without reflecting managed paths", async () => {
    const bootstrap = await startDesktopBootstrapServer();

    try {
      bootstrap.update({ kind: "needs_attention" });
      const response = await fetch(bootstrap.url);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
      expect(html).toContain("Convo Caddy could not start");
      expect(html).not.toContain("/private/config/.env");
      expect(html).not.toContain("CONVO_CADDY_RECALL_API_KEY=");
      const rejected = await requestWithHost(bootstrap.url, "attacker.example");
      expect(rejected.status).toBe(421);
      expect(rejected.body).not.toContain("/private/config/.env");
      expect(
        await (await fetch(`${bootstrap.url}/api/session`)).text(),
      ).not.toContain("sessionId");
    } finally {
      await bootstrap.close();
    }
  });
});

function requestWithHost(
  target: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { Host: host },
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}
