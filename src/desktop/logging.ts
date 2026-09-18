import { appendFileSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import {
  assertManagedPathHasNoSymlinks,
  ensurePrivateDirectory,
} from "../server/persistence/atomic-write.js";
import {
  assertOwnerPrivateDirectory,
  assertOwnerPrivateRegularFile,
} from "../server/persistence/private-path.js";

export type DesktopLogger = {
  info(event: string): void;
  error(event: string, error: unknown): void;
};

export function createDesktopLogger(logsDirectory: string): DesktopLogger {
  ensurePrivateDirectory(logsDirectory);
  assertOwnerPrivateDirectory(logsDirectory);
  const logFile = path.join(logsDirectory, "desktop.log");
  const write = (level: "info" | "error", event: string, error?: unknown) => {
    const safeEvent = /^[a-z0-9_.-]+$/.test(event) ? event : "invalid_event";
    const errorName =
      error instanceof Error && /^[A-Za-z0-9_.-]+$/.test(error.name)
        ? error.name
        : undefined;
    assertManagedPathHasNoSymlinks(logFile, logsDirectory);
    if (existsSync(logFile)) {
      assertOwnerPrivateRegularFile(logFile);
    }
    appendFileSync(
      logFile,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event: safeEvent,
        ...(errorName ? { error: errorName } : {}),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (existsSync(logFile)) {
      chmodSync(logFile, 0o600);
      assertOwnerPrivateRegularFile(logFile);
    }
  };
  return {
    info: (event) => write("info", event),
    error: (event, error) => write("error", event, error),
  };
}
