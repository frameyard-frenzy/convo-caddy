import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type CommandRunner = (command: string, args: string[]) => string;
export type SigningMode =
  | { mode: "local-ad-hoc" }
  | {
      mode: "release-signed";
      identity: string;
      team: string;
      notaryProfile: string;
    };

export function resolveSigningMode(
  environment: NodeJS.ProcessEnv,
): SigningMode {
  const mode = environment.CONVO_CADDY_SIGNING_MODE?.trim() || "local-ad-hoc";
  if (mode === "local-ad-hoc") {
    for (const forbidden of [
      "CONVO_CADDY_CODESIGN_IDENTITY",
      "CONVO_CADDY_SIGNING_TEAM",
      "CONVO_CADDY_NOTARY_KEYCHAIN_PROFILE",
    ]) {
      if (environment[forbidden]?.trim())
        throw new Error(`${forbidden} is forbidden in local-ad-hoc mode.`);
    }
    return { mode };
  }
  if (mode !== "release-signed")
    throw new Error(
      "CONVO_CADDY_SIGNING_MODE must be local-ad-hoc or release-signed.",
    );
  const identity = required(environment, "CONVO_CADDY_CODESIGN_IDENTITY");
  const team = required(environment, "CONVO_CADDY_SIGNING_TEAM");
  const notaryProfile = required(
    environment,
    "CONVO_CADDY_NOTARY_KEYCHAIN_PROFILE",
  );
  if (!identity.startsWith("Developer ID Application:"))
    throw new Error(
      "Release identity must be a Developer ID Application identity.",
    );
  if (!/^[A-Z0-9]{6,20}$/.test(team))
    throw new Error("Signing team must be an Apple Team ID.");
  return { mode, identity, team, notaryProfile };
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value)
    throw new Error(
      `${name} is required in release-signed mode; refusing ad-hoc fallback.`,
    );
  return value;
}

export function prepareReleaseCandidate(input: {
  root: string;
  identity: string;
  team: string;
  notaryProfile: string;
  runner?: CommandRunner;
}) {
  const run = input.runner ?? systemRunner;
  const app = firstExisting(input.root, [
    "Convo Caddy.app",
    "out/Convo Caddy-darwin-arm64/Convo Caddy.app",
  ]);
  const uninstaller = firstExisting(input.root, [
    "Uninstall Convo Caddy.app",
    "dist/packaging/Uninstall Convo Caddy.app",
  ]);
  const dmg = findSingleDmg(path.join(input.root, "out/make"));
  const identities = run("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  if (!identities.includes(input.identity))
    throw new Error(
      "Requested Developer ID Application identity was not found.",
    );
  const nested = findSignableNested(app);
  for (const target of [...nested, uninstaller, app]) {
    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", target]);
    assertSigningDetails(
      run("/usr/bin/codesign", ["-dv", "--verbose=4", target]),
      input.team,
      true,
    );
  }
  for (const target of [uninstaller, app]) {
    run("/usr/bin/xcrun", ["stapler", "validate", target]);
    run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      target,
    ]);
  }
  run("/usr/bin/codesign", [
    "--sign",
    input.identity,
    "--force",
    "--timestamp",
    dmg,
  ]);
  run("/usr/bin/codesign", ["--verify", "--strict", dmg]);
  assertSigningDetails(
    run("/usr/bin/codesign", ["-dv", "--verbose=4", dmg]),
    input.team,
    false,
  );
  run("/usr/bin/xcrun", [
    "notarytool",
    "submit",
    dmg,
    "--keychain-profile",
    input.notaryProfile,
    "--wait",
  ]);
  run("/usr/bin/xcrun", ["stapler", "staple", dmg]);
  run("/usr/bin/xcrun", ["stapler", "validate", dmg]);
  run("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmg,
  ]);
  return {
    signingTeam: input.team,
    notarization: "accepted-and-stapled" as const,
    dmg,
    sha256: digest(dmg),
  };
}

function assertSigningDetails(
  details: string,
  team: string,
  requireRuntime: boolean,
): void {
  if (
    !details.split(/\r?\n/).includes(`TeamIdentifier=${team}`) ||
    !/^Authority=Developer ID Application:.+$/m.test(details)
  ) {
    throw new Error("Signing team/authority verification failed.");
  }
  const flags = /flags=0x([a-f0-9]+)/i.exec(details);
  if (
    requireRuntime &&
    (!flags || (Number.parseInt(flags[1] as string, 16) & 0x10000) === 0)
  ) {
    throw new Error("Hardened runtime signature is required.");
  }
}

export function notarizeStandaloneApp(input: {
  app: string;
  notaryProfile: string;
  runner?: CommandRunner;
}): void {
  const run = input.runner ?? systemRunner;
  const scratch = mkdtempSync(path.join(tmpdir(), "convo-caddy-notary-"));
  const archive = path.join(scratch, "application.zip");
  try {
    run("/usr/bin/ditto", ["-c", "-k", "--keepParent", input.app, archive]);
    run("/usr/bin/xcrun", [
      "notarytool",
      "submit",
      archive,
      "--keychain-profile",
      input.notaryProfile,
      "--wait",
    ]);
    run("/usr/bin/xcrun", ["stapler", "staple", input.app]);
    run("/usr/bin/xcrun", ["stapler", "validate", input.app]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function findSignableNested(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        if (entry.name.endsWith(".app") || entry.name.endsWith(".framework"))
          found.push(absolute);
      } else if (/\.(node|dylib)$/.test(entry.name)) found.push(absolute);
    }
  }
  return found.sort(
    (a, b) =>
      b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b),
  );
}

export interface PublicReleaseManifest {
  schemaVersion: 1;
  product: {
    name: "Convo Caddy";
    version: string;
    bundleIdentifiers: string[];
  };
  source: { cleanExportSha: string; lockfileSha256: string };
  tools: Record<string, string>;
  platform: { architecture: "arm64"; minimumMacOS: "14.0" };
  signing: {
    mode: "release-signed";
    team: string;
    notarization: "accepted-and-stapled";
  };
  artifacts: Array<{ filename: string; bytes: number; sha256: string }>;
  verificationCommands: string[];
}

export function createPublicReleaseManifest(input: {
  root: string;
  version: string;
  cleanExportSha: string;
  signingTeam: string;
  notarization: "accepted-and-stapled";
  toolVersions: Record<string, string>;
}): PublicReleaseManifest {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version))
    throw new Error(
      "Approved product version must be an explicit semantic version.",
    );
  if (!/^[a-f0-9]{40}$/.test(input.cleanExportSha))
    throw new Error("Clean export SHA must be a full public commit SHA.");
  if (!/^[A-Z0-9]{6,20}$/.test(input.signingTeam))
    throw new Error("Verified signing team must be an Apple Team ID.");
  assertPublicValues(input.toolVersions);
  const lockfile = path.join(input.root, "pnpm-lock.yaml");
  const dmg = findSingleDmg(path.join(input.root, "out/make"));
  const zip = findSingle(
    path.join(input.root, "out/make/zip/darwin/arm64"),
    ".zip",
  );
  return {
    schemaVersion: 1,
    product: {
      name: "Convo Caddy",
      version: input.version,
      bundleIdentifiers: [
        "com.frameyard.convocaddy",
        "com.frameyard.convocaddy.uninstaller",
      ],
    },
    source: {
      cleanExportSha: input.cleanExportSha,
      lockfileSha256: digest(lockfile),
    },
    tools: { ...input.toolVersions },
    platform: { architecture: "arm64", minimumMacOS: "14.0" },
    signing: {
      mode: "release-signed",
      team: input.signingTeam,
      notarization: input.notarization,
    },
    artifacts: [dmg, zip].map((artifact) => ({
      filename: path.basename(artifact),
      bytes: statSync(artifact).size,
      sha256: digest(artifact),
    })),
    verificationCommands: [
      "codesign --verify --deep --strict <app>",
      "spctl --assess --type execute <app>",
      "xcrun stapler validate <app-or-dmg>",
      "spctl --assess --type open --context context:primary-signature <dmg>",
    ],
  };
}

function assertPublicValues(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (
      !value.trim() ||
      /(?:\/Users\/|\\Users\\|@[A-Za-z0-9.-]+\.|keychain|profile)/i.test(value)
    )
      throw new Error(
        `Tool version ${name} contains private or invalid metadata.`,
      );
  }
}

function findSingleDmg(root: string) {
  return findSingle(root, ".dmg");
}
function firstExisting(root: string, candidates: string[]): string {
  const found = candidates
    .map((relative) => path.join(root, relative))
    .find(existsSync);
  if (!found)
    throw new Error(
      `Missing release bundle under ${root}: ${candidates.join(" or ")}.`,
    );
  return found;
}
function findSingle(root: string, suffix: string): string {
  const matches = readdirSync(root).filter((name) => name.endsWith(suffix));
  if (matches.length !== 1)
    throw new Error(`Expected exactly one ${suffix} artifact in ${root}.`);
  return path.join(root, matches[0] as string);
}
function digest(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
export function systemRunner(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    // Arguments and tool diagnostics can contain private credential metadata.
    throw new Error(
      `Release command ${path.basename(command)} failed (status ${result.status ?? "unavailable"}).`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}
