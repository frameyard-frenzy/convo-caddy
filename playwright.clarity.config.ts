import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*-clarity.spec.ts",
  workers: 1,
  use: { trace: "retain-on-failure" },
});
