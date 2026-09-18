import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { versionUninstallerPlist } from "./lib/release-bundle-metadata.js";
import path from "node:path";
import { resolveSigningMode } from "./lib/release-manifest.js";

const packageRoot = path.resolve("native/uninstaller"),
  output = path.resolve("dist/packaging/Uninstall Convo Caddy.app");
const env = {
  ...process.env,
  ...(process.env.CONVO_CADDY_SWIFT_SDK
    ? { SDKROOT: process.env.CONVO_CADDY_SWIFT_SDK }
    : {}),
};
execFileSync(
  "swift",
  ["build", "--package-path", packageRoot, "-c", "release"],
  { stdio: "inherit", env },
);
rmSync(output, { recursive: true, force: true });
mkdirSync(path.join(output, "Contents/MacOS"), { recursive: true });
mkdirSync(path.join(output, "Contents/Resources"), { recursive: true });
cpSync(
  path.join(packageRoot, ".build/release/UninstallConvoCaddy"),
  path.join(output, "Contents/MacOS/Uninstall Convo Caddy"),
);
writeFileSync(
  path.join(output, "Contents/Info.plist"),
  versionUninstallerPlist(
    readFileSync(path.join(packageRoot, "Info.plist"), "utf8"),
    JSON.parse(readFileSync("package.json", "utf8")).version,
  ),
);
cpSync(
  path.join(packageRoot, "Resources"),
  path.join(output, "Contents/Resources"),
  { recursive: true },
);
cpSync(
  path.resolve("dist/packaging", "UninstallConvoCaddy.icns"),
  path.join(output, "Contents/Resources/UninstallConvoCaddy.icns"),
);
const signing = resolveSigningMode(process.env);
execFileSync(
  "/usr/bin/codesign",
  signing.mode === "release-signed"
    ? [
        "--sign",
        signing.identity,
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        output,
      ]
    : ["--force", "--sign", "-", "--timestamp=none", output],
  { stdio: "inherit" },
);
