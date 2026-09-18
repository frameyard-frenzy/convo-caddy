import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";
import type { CommandRunner } from "./release-manifest.js";

export function versionUninstallerPlist(
  plist: string,
  version: string,
): string {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Bundle version must be numeric major.minor.patch.");
  let result = plist;
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
    const pattern = new RegExp(
      `(<key>${key}</key>\\s*<string>)[^<]*(</string>)`,
      "g",
    );
    if ([...result.matchAll(pattern)].length !== 1)
      throw new Error("Uninstaller version field missing or duplicated.");
    result = result.replace(
      pattern,
      (_match, before, after) => `${before}${version}${after}`,
    );
  }
  return result;
}

export function assertBundleVersion(
  app: string,
  version: string,
  runner: CommandRunner,
) {
  const read = (key: string) =>
    runner("/usr/bin/plutil", [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      path.join(app, "Contents/Info.plist"),
    ]).trim();
  const result = {
    identifier: read("CFBundleIdentifier"),
    version: read("CFBundleShortVersionString"),
    buildVersion: read("CFBundleVersion"),
  };
  if (result.version !== version || result.buildVersion !== version)
    throw new Error("Bundle version differs from approved package version.");
  if (
    ![
      "com.frameyard.convocaddy",
      "com.frameyard.convocaddy.uninstaller",
    ].includes(result.identifier)
  )
    throw new Error("Unexpected release bundle identity.");
  return result;
}

export function assertMachOMinimum(
  root: string,
  minimum: string,
  runner: CommandRunner,
): number {
  const pending = [root];
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const fd = openSync(file, "r"),
        header = Buffer.alloc(4);
      let count: number;
      try {
        count = readSync(fd, header, 0, 4, 0);
      } finally {
        closeSync(fd);
      }
      if (
        count !== 4 ||
        ![
          "cffaedfe",
          "cefaedfe",
          "feedfacf",
          "feedface",
          "cafebabe",
          "bebafeca",
          "cafebabf",
          "bfbafeca",
        ].includes(header.toString("hex"))
      )
        continue;
      // CLT's otool-classic otherwise treats parentheses in Electron helper
      // filenames as archive-member syntax and silently truncates the path.
      const commands = runner("/usr/bin/otool", ["-m", "-l", file]);
      const versions = deploymentTargets(commands);
      if (
        !versions.length ||
        versions.some((version) => newer(version, minimum))
      )
        throw new Error(
          `Packaged Mach-O ${path.relative(root, file) || path.basename(file)} requires a newer or unverified minimum macOS (${versions.join(", ") || "missing"}; expected <= ${minimum}).`,
        );
      inspected += 1;
    }
  }
  if (!inspected)
    throw new Error("No packaged Mach-O deployment targets were verified.");
  return inspected;
}
function deploymentTargets(commands: string): string[] {
  const versions: string[] = [];
  let deploymentField: "minos" | "version" | undefined;
  for (const line of commands.split("\n")) {
    const command = line.match(/^\s*cmd\s+(LC_[A-Z0-9_]+)\s*$/)?.[1];
    if (command) {
      deploymentField =
        command === "LC_BUILD_VERSION"
          ? "minos"
          : command === "LC_VERSION_MIN_MACOSX"
            ? "version"
            : undefined;
      continue;
    }
    if (!deploymentField) continue;
    const match = line.match(
      new RegExp(`^\\s*${deploymentField}\\s+(\\d+\\.\\d+(?:\\.\\d+)?)\\s*$`),
    );
    if (match?.[1]) {
      versions.push(match[1]);
      deploymentField = undefined;
    }
  }
  return versions;
}
function newer(version: string, floor: string): boolean {
  const a = version.split(".").map(Number),
    b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
