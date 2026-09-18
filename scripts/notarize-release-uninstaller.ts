import path from "node:path";
import {
  notarizeStandaloneApp,
  resolveSigningMode,
} from "./lib/release-manifest.js";

const signing = resolveSigningMode(process.env);
if (signing.mode !== "release-signed")
  throw new Error("Standalone notarization requires release-signed mode.");
notarizeStandaloneApp({
  app: path.resolve("dist/packaging/Uninstall Convo Caddy.app"),
  notaryProfile: signing.notaryProfile,
});
