import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromHere = createRequire(import.meta.url);

export type MacosPackagingToolOptions = {
  platform?: NodeJS.Platform;
  cleanOutputs?: () => void;
  isAddonLoadable?: () => boolean;
  rebuildAddon?: () => void;
};

export function ensureMacosPackagingTool(
  options: MacosPackagingToolOptions = {},
): "ready" | "rebuilt" {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("macOS package tooling can only be prepared on macOS.");
  }

  (options.cleanOutputs ?? cleanMacosPackageOutputs)();
  const isAddonLoadable = options.isAddonLoadable ?? defaultIsAddonLoadable;
  if (isAddonLoadable()) {
    return "ready";
  }

  (options.rebuildAddon ?? defaultRebuildAddon)();
  if (!isAddonLoadable()) {
    throw new Error(
      "macOS DMG native dependency is unavailable after rebuild.",
    );
  }
  return "rebuilt";
}

export function cleanMacosPackageOutputs(
  outputRoot = path.resolve("out"),
): void {
  rmSync(outputRoot, { recursive: true, force: true });
}

function defaultIsAddonLoadable(): boolean {
  const addon = macosAliasAddon();
  if (!existsSync(addon)) {
    return false;
  }
  return (
    spawnSync(process.execPath, ["-e", "require(process.argv[1])", addon], {
      stdio: "ignore",
    }).status === 0
  );
}

function defaultRebuildAddon(): void {
  const packageRoot = macosAliasRoot();
  const nodeGyp = requireFromHere.resolve("@electron/node-gyp/bin/node-gyp.js");
  execFileSync(process.execPath, [nodeGyp, "rebuild"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

function macosAliasAddon(): string {
  return path.join(macosAliasRoot(), "build", "Release", "volume.node");
}

function macosAliasRoot(): string {
  return path.dirname(requireFromHere.resolve("macos-alias/package.json"));
}
