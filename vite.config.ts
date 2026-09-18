import { defineConfig } from "vite";

export default defineConfig({
  // Fixture servers must not connect browsers to another dev server's HMR port.
  server: {
    hmr: process.env.CONVO_CADDY_TEST_MODE === "1" ? false : undefined,
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
