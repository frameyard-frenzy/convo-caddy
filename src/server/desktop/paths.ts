import { homedir } from "node:os";
import path from "node:path";

export type DesktopPaths = {
  applicationRoot: string;
  configDirectory: string;
  connectionSettingsFile: string;
  preferencesFile: string;
  electronDirectory: string;
  logsDirectory: string;
};

export type ResolveDesktopPathsOptions = {
  applicationSupportDirectory?: string;
  logsDirectory?: string;
};

export function resolveDesktopPaths(
  options: ResolveDesktopPathsOptions = {},
): DesktopPaths {
  const userHome = homedir();
  const applicationSupportDirectory = requireAbsolute(
    options.applicationSupportDirectory ??
      path.join(userHome, "Library", "Application Support"),
    "Application Support directory",
  );
  const logsRoot = requireAbsolute(
    options.logsDirectory ?? path.join(userHome, "Library", "Logs"),
    "logs directory",
  );
  const applicationRoot = path.join(applicationSupportDirectory, "Convo Caddy");

  return {
    applicationRoot,
    configDirectory: path.join(applicationRoot, "config"),
    connectionSettingsFile: path.join(
      applicationRoot,
      "config",
      "connections.json",
    ),
    preferencesFile: path.join(applicationRoot, "config", "preferences.json"),
    electronDirectory: path.join(applicationRoot, "electron"),
    logsDirectory: path.join(logsRoot, "Convo Caddy"),
  };
}

function requireAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`Desktop ${label} must be absolute.`);
  }
  return path.resolve(value);
}
