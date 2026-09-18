import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const deploymentRoot = path.resolve("dist/package-runtime");
const nodeModules = path.join(deploymentRoot, "node_modules");
if (!existsSync(nodeModules)) {
  throw new Error("pnpm deploy did not create the production dependency tree.");
}

for (const entry of readdirSync(deploymentRoot)) {
  if (entry !== "node_modules") {
    rmSync(path.join(deploymentRoot, entry), {
      recursive: true,
      force: true,
    });
  }
}

for (const generatedPath of [
  ".bin",
  ".modules.yaml",
  ".package-map.json",
  ".pnpm",
  ".pnpm-workspace-state-v1.json",
  ".vite",
  ".vite-temp",
]) {
  rmSync(path.join(nodeModules, generatedPath), {
    recursive: true,
    force: true,
  });
}

for (const forbiddenPackage of [
  "@biomejs",
  "@electron-forge",
  "@playwright",
  "@types",
  "@vitest",
  "electron",
  "esbuild",
  "playwright",
  "playwright-core",
  "tsx",
  "typescript",
  "vite",
  "vitest",
]) {
  if (existsSync(path.join(nodeModules, forbiddenPackage))) {
    throw new Error(
      `Development dependency escaped into the package stage: ${forbiddenPackage}`,
    );
  }
}

const packageCount = readdirSync(nodeModules).filter(
  (name) => !name.startsWith("."),
).length;
if (packageCount === 0) {
  throw new Error("The production dependency stage is empty.");
}
console.log(`Staged ${packageCount} production dependency roots.`);
