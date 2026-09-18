import { isIP } from "node:net";

export type HermesEndpoint = {
  origin: string;
  pathname: "/" | `/p/${string}`;
  hostname: string;
  port: number;
};

export function parseHermesEndpoint(value: string): HermesEndpoint {
  if (/%(?:2e|2f|5c)/iu.test(value)) {
    throw new Error("Hermes URL must not contain encoded path metacharacters.");
  }
  // WHATWG URL parsing erases dot segments and treats backslashes as slashes.
  // Validate the raw path first so parsing cannot silently select another profile.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes before URL normalization
  if (/[\\\x00-\x20\x7f]/u.test(value))
    throw new Error("Hermes URL contains unsafe characters.");
  const raw = /^http:\/\/[^/?#]+([^?#]*)$/iu.exec(value);
  if (!raw)
    throw new Error(
      "Hermes URL must use loopback HTTP with an unadorned absolute URL.",
    );
  normalizePathname(raw[1] ?? "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Hermes URL must be an absolute URL.");
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Hermes URL must use loopback HTTP without credentials, query, or fragment.",
    );
  }
  const pathname = normalizePathname(url.pathname);
  const port = Number(url.port || "80");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Hermes URL must contain a valid port.");
  return { origin: url.origin, pathname, hostname: url.hostname, port };
}

export function hermesEndpointUrl(
  endpoint: HermesEndpoint,
  path: string,
): string {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#"))
    throw new Error("Hermes API path must be absolute and unadorned.");
  return `${endpoint.origin}${endpoint.pathname === "/" ? "" : endpoint.pathname}${path}`;
}

function normalizePathname(pathname: string): HermesEndpoint["pathname"] {
  if (pathname === "/" || pathname === "") return "/";
  if (/%2f|%5c/iu.test(pathname))
    throw new Error("Hermes profile path contains an encoded separator.");
  const match = /^\/p\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/?$/u.exec(pathname);
  if (!match?.[1] || match[1] === "." || match[1] === "..")
    throw new Error("Hermes URL path must be root or /p/<profile>.");
  return `/p/${match[1]}`;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/iu.test(normalized)) return true;
  if (normalized.startsWith("::ffff:"))
    return isLoopbackHostname(normalized.slice(7));
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}
