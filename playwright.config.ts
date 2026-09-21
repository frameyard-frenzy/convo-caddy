import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

const port = Number(process.env.CONVO_CADDY_E2E_PORT ?? 4317);
const setupPort = Number(process.env.CONVO_CADDY_SETUP_FIXTURE_PORT ?? 4318);
const dataRoot = path.join(tmpdir(), `convo-caddy-playwright-${process.pid}`);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx src/server/main.ts",
      env: {
        CONVO_CADDY_DATA_DIR: dataRoot,
        CONVO_CADDY_TEST_MODE: "1",
        CONVO_CADDY_PORT: String(port),
      },
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node --import tsx scripts/setup-fixture-server.ts",
      url: `http://127.0.0.1:${setupPort}/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
