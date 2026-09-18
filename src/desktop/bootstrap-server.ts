import { createServer } from "node:http";
import {
  closeHttpServer,
  listenOnLoopback,
} from "../server/server-lifecycle.js";

export type DesktopBootstrapView =
  | { kind: "starting" }
  | { kind: "needs_attention" };

export type DesktopBootstrapServer = {
  url: string;
  update(view: DesktopBootstrapView): void;
  close(): Promise<void>;
};

export async function startDesktopBootstrapServer(): Promise<DesktopBootstrapServer> {
  let view: DesktopBootstrapView = { kind: "starting" };
  let expectedHost: string | null = null;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.host !== expectedHost) {
      response.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Misdirected request");
      return;
    }
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(renderBootstrap(view));
  });
  const address = await listenOnLoopback(server, 0, "127.0.0.1");
  expectedHost = `127.0.0.1:${address.port}`;
  let closePromise: Promise<void> | null = null;
  return {
    url: address.url,
    update(nextView) {
      view = nextView;
    },
    close() {
      closePromise ??= closeHttpServer(server);
      return closePromise;
    },
  };
}

function renderBootstrap(view: DesktopBootstrapView): string {
  const content = {
    starting: {
      eyebrow: "Starting securely",
      title: "Convo Caddy is getting ready",
      body: "The private workspace and meeting connections are starting. This window will continue automatically.",
    },
    needs_attention: {
      eyebrow: "Needs attention",
      title: "Convo Caddy could not start",
      body: "Open the logs from the Convo Caddy menu, correct the configuration or local dependency, then reload. No meeting capture was started.",
    },
  }[view.kind];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Convo Caddy</title>
<style>:root{color:#242723;background:#eeece5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(38rem,calc(100% - 3rem));padding:2rem;border:1px solid #c7c8c1;border-radius:.5rem;background:#faf9f5}.eyebrow{margin:0 0:.5rem;color:#666a63;font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{margin:0 0:1rem;font-size:2rem}p:last-child{margin:0;line-height:1.55}</style></head>
<body><main class="card"><p class="eyebrow">${escapeHtml(content.eyebrow)}</p><h1>${escapeHtml(content.title)}</h1><p>${escapeHtml(content.body)}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
