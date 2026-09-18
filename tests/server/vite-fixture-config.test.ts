import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("does not open a shared HMR listener in synthetic browser fixtures", async () => {
  vi.stubEnv("CONVO_CADDY_TEST_MODE", "1");
  const { default: config } = await import("../../vite.config.js");
  expect(config.server?.hmr).toBe(false);
});

it("preserves normal development hot reload outside synthetic fixtures", async () => {
  vi.stubEnv("CONVO_CADDY_TEST_MODE", undefined);
  const { default: config } = await import("../../vite.config.js");
  expect(config.server?.hmr).toBeUndefined();
});
