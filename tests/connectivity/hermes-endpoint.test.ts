import { describe, expect, it } from "vitest";
import {
  hermesEndpointUrl,
  parseHermesEndpoint,
} from "../../src/server/connectivity/hermes-endpoint.js";

describe("Hermes endpoint", () => {
  it.each([
    ["http://127.0.0.1:8642", "/", "http://127.0.0.1:8642/health"],
    [
      "http://127.0.0.1:8642/p/everyday",
      "/p/everyday",
      "http://127.0.0.1:8642/p/everyday/health",
    ],
  ])("joins the supported endpoint scope", (input, pathname, health) => {
    const endpoint = parseHermesEndpoint(input);
    expect(endpoint.pathname).toBe(pathname);
    expect(hermesEndpointUrl(endpoint, "/health")).toBe(health);
  });

  it.each([
    "http://127.0.0.1:8642/p/everyday/../other",
    "http://127.0.0.1:8642/p/everyday/../../",
    "http://127.0.0.1:8642/p/everyday\\..\\other",
    "http://127.0.0.1:8642/arbitrary",
    "http://127.0.0.1:8642/p/a/b",
    "http://127.0.0.1:8642/p/%2e%2e",
    "http://127.0.0.1:8642/p/a%2fb",
    "http://user:secret@127.0.0.1:8642",
    "http://127.0.0.1:8642/?query=1",
  ])("rejects unsafe scope %s", (input) => {
    expect(() => parseHermesEndpoint(input)).toThrow();
  });
});
