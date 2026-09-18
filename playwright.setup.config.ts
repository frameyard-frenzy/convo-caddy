import { defineConfig } from "@playwright/test";

// These tests own ephemeral loopback servers, including the real setup runtime.
// No shared development server or existing desktop instance is used.
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "setup-acceptance.spec.ts",
  workers: 1,
  use: { trace: "retain-on-failure" },
});
