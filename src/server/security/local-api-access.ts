import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";

export const LOCAL_API_COOKIE_NAME = "convo_caddy_launch";

export type ElectronSessionCookie = {
  url: string;
  name: string;
  value: string;
  httpOnly: true;
  secure: false;
  sameSite: "strict";
  path: "/";
};

const mutatingMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export class LocalApiAccess {
  readonly #token: string;
  #origin: string | null = null;

  constructor(token = randomBytes(32).toString("base64url")) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("Local API launch tokens must contain 256 bits.");
    }
    this.#token = token;
  }

  bindOrigin(value: string): void {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !isLoopbackHostname(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Local API access requires an exact loopback origin.");
    }
    this.#origin = url.origin;
  }

  createElectronCookie(): ElectronSessionCookie {
    if (this.#origin === null) {
      throw new Error(
        "Local API origin must be bound before setting its cookie.",
      );
    }
    return {
      url: this.#origin,
      name: LOCAL_API_COOKIE_NAME,
      value: this.#token,
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      path: "/",
    };
  }

  hostMiddleware(): RequestHandler {
    return (request, response, next) => {
      if (
        this.#origin === null ||
        request.get("host") !== new URL(this.#origin).host
      ) {
        response.status(421).type("text").send("Misdirected request");
        return;
      }
      next();
    };
  }

  middleware(): RequestHandler {
    return (request, response, next) => {
      if (!this.#hasExactCookie(request)) {
        response
          .status(401)
          .json({ error: "Local application access denied." });
        return;
      }
      if (
        mutatingMethods.has(request.method.toUpperCase()) &&
        request.get("origin") !== this.#origin
      ) {
        response
          .status(403)
          .json({ error: "Local application origin denied." });
        return;
      }
      next();
    };
  }

  #hasExactCookie(request: Request): boolean {
    const values = parseCookieValues(
      request.get("cookie"),
      LOCAL_API_COOKIE_NAME,
    );
    return (
      values.length === 1 && constantTimeEqual(values[0] ?? "", this.#token)
    );
  }
}

export function browserSecurityHeaders(
  options: { allowViteInlineStyles?: boolean } = {},
): RequestHandler {
  return (_request, response, next) => {
    const styleSource = options.allowViteInlineStyles
      ? "style-src 'self' 'unsafe-inline'"
      : "style-src 'self'";
    response.set({
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self'",
        styleSource,
        "connect-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), display-capture=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  };
}

function parseCookieValues(
  header: string | undefined,
  targetName: string,
): string[] {
  if (!header) {
    return [];
  }
  const values: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== targetName) {
      continue;
    }
    values.push(segment.slice(separator + 1).trim());
  }
  return values;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}
