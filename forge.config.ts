import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { flipFuses } from "@electron/fuses";
import { ELECTRON_FUSE_CONFIG } from "./scripts/lib/electron-fuses.js";
import {
  assertProductionDependencyClosure,
  assertSafePackagedFiles,
  createPackageIgnore,
  installStagedProductionDependencies,
  writePackagedManifest,
} from "./scripts/lib/package-contract.js";
import { resolveSigningMode } from "./scripts/lib/release-manifest.js";

import { installerLayout } from "./scripts/lib/installer-layout.js";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const signing = resolveSigningMode(process.env);
const signingIdentity =
  signing.mode === "release-signed" ? signing.identity : undefined;
const notaryProfile =
  signing.mode === "release-signed" ? signing.notaryProfile : undefined;

const config: ForgeConfig = {
  outDir: "out",
  packagerConfig: {
    name: "Convo Caddy",
    executableName: "Convo Caddy",
    appBundleId: "com.frameyard.convocaddy",
    appCategoryType: "public.app-category.productivity",
    appCopyright: "Copyright © 2026 Linn Autoracing Excellence LLC",
    extendInfo: { LSMinimumSystemVersion: "14.0" },
    icon: path.join(projectRoot, "dist/packaging/ConvoCaddy.icns"),
    asar: true,
    extraResource: [
      path.join(projectRoot, "scripts/acquire-hermes.py"),
      path.join(projectRoot, "scripts/enroll-hermes-key.py"),
    ],
    derefSymlinks: true,
    ignore: createPackageIgnore(projectRoot),
    osxSign: signingIdentity
      ? {
          identity: signingIdentity,
          hardenedRuntime: true,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: (filePath) => minimalEntitlements(filePath),
        }
      : {
          identity: "-",
          identityValidation: false,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: (filePath) => ({
            ...minimalEntitlements(filePath),
            hardenedRuntime: false,
          }),
        },
    ...(notaryProfile
      ? { osxNotarize: { keychainProfile: notaryProfile } }
      : {}),
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: installerLayout(projectRoot),
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
      config: {},
    },
  ],
  plugins: [new AutoUnpackNativesPlugin({})],
  hooks: {
    packageAfterCopy: async (
      _forgeConfig,
      buildPath,
      _electronVersion,
      platform,
    ) => {
      writePackagedManifest(buildPath);
      if (platform !== "darwin") {
        throw new Error("Convo Caddy Phase 6 packages only macOS builds.");
      }
      await flipFuses(
        path.resolve(buildPath, "../..", "MacOS", "Electron"),
        ELECTRON_FUSE_CONFIG,
      );
    },
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      installStagedProductionDependencies(
        buildPath,
        path.join(projectRoot, "dist/package-runtime/node_modules"),
      );
      assertProductionDependencyClosure(
        buildPath,
        path.join(projectRoot, "dist/package-runtime/node_modules"),
      );
      assertSafePackagedFiles(buildPath);
    },
  },
};

export default config;

function minimalEntitlements(filePath: string): {
  entitlements: string[];
} {
  const needsJit =
    filePath.includes("(Renderer).app") ||
    filePath.includes("(GPU).app") ||
    !filePath.includes(".app/");
  return {
    entitlements: needsJit ? ["com.apple.security.cs.allow-jit"] : [],
  };
}
