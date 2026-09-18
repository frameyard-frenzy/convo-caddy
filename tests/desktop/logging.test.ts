import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopLogger } from "../../src/desktop/logging.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop logging", () => {
  it("writes owner-private structured events without raw error messages", () => {
    const root = mkdtempSync(path.join(tmpdir(), "convo-caddy-logs-"));
    temporaryDirectories.push(root);
    const logsDirectory = path.join(root, "Logs");
    const logger = createDesktopLogger(logsDirectory);

    logger.error(
      "desktop_startup_needs_attention",
      new Error("CONVO_CADDY_RECALL_API_KEY=must-not-appear"),
    );

    const logFile = path.join(logsDirectory, "desktop.log");
    const contents = readFileSync(logFile, "utf8");
    expect(JSON.parse(contents)).toMatchObject({
      level: "error",
      event: "desktop_startup_needs_attention",
      error: "Error",
    });
    expect(contents).not.toContain("must-not-appear");
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
  });
});
