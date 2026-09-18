import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  lstatSync,
  realpathSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  PUBLIC_TREE_ALLOWLIST,
  assertNoHighConfidenceSecrets,
  assertPublicCandidate,
  assertDocumentationReferences,
} from "./verify-public-tree.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicReleaseManifest,
  prepareReleaseCandidate,
  resolveSigningMode,
} from "./lib/release-manifest.js";

function main() {
  const signing = resolveSigningMode(process.env);
  if (signing.mode !== "release-signed")
    throw new Error(
      "prepare:release:mac requires release-signed mode; local ad-hoc builds use pnpm make:mac.",
    );
  const {
    version,
    cleanExportSha,
    approvedRootSha,
    manifest: manifestArgument,
  } = parseReleaseArguments(process.argv.slice(2));
  const manifestPath = path.resolve(manifestArgument);
  const root = process.cwd();
  assertManifestDestination(root, manifestPath);
  assertReleaseSource(root, version, cleanExportSha, approvedRootSha);
  run("pnpm", ["make:mac:release"]);
  const release = prepareReleaseCandidate({
    root,
    identity: signing.identity,
    team: signing.team,
    notaryProfile: signing.notaryProfile,
  });
  run("pnpm", ["verify:package:mac"]);
  const manifest = createPublicReleaseManifest({
    root,
    version,
    cleanExportSha,
    signingTeam: release.signingTeam,
    notarization: release.notarization,
    toolVersions: {
      node: process.version.slice(1),
      pnpm: run("pnpm", ["--version"]).trim(),
      swift: firstVersion(run("swift", ["--version"])),
      xcode: run("xcodebuild", ["-version"]).trim().replace(/\n/g, " "),
    },
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(`Verified release manifest written to ${manifestPath}`);

  function run(command: string, commandArgs: string[]) {
    return execFileSync(command, commandArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();

export function parseReleaseArguments(argv: string[]) {
  const values = argv[0] === "--" ? argv.slice(1) : argv;
  const allowed = new Set([
    "--version",
    "--clean-export-sha",
    "--approved-root-sha",
    "--manifest",
  ]);
  const args = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index],
      value = values[index + 1];
    if (
      !key ||
      !allowed.has(key) ||
      args.has(key) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error("Invalid release flags.");
    }
    args.set(key, value);
  }
  const version = args.get("--version"),
    cleanExportSha = args.get("--clean-export-sha"),
    approvedRootSha = args.get("--approved-root-sha"),
    manifest = args.get("--manifest");
  if (
    !version ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !cleanExportSha ||
    !/^[a-f0-9]{40}$/.test(cleanExportSha) ||
    !approvedRootSha ||
    !/^[a-f0-9]{40}$/.test(approvedRootSha) ||
    !manifest
  ) {
    throw new Error(
      "Required release version, full public HEAD and approved root SHAs, and manifest path are invalid or missing.",
    );
  }
  return { version, cleanExportSha, approvedRootSha, manifest };
}

export function assertReleaseSource(
  root: string,
  version: string,
  cleanExportSha: string,
  approvedRootSha: string,
) {
  const git = (args: string[]) =>
    execFileSync("git", ["--no-replace-objects", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  if (
    git(["status", "--porcelain"]) ||
    git(["rev-parse", "HEAD"]) !== cleanExportSha
  )
    throw new Error("Release requires clean source matching supplied SHA.");
  if (
    !/^[a-f0-9]{40}$/.test(approvedRootSha ?? "") ||
    git(["rev-parse", "--is-shallow-repository"]) !== "false"
  )
    throw new Error(
      "Release requires an explicit approved root and non-shallow history.",
    );
  if (
    git(["rev-parse", `${approvedRootSha}^{commit}`]) !== approvedRootSha ||
    /^parent /m.test(git(["cat-file", "-p", approvedRootSha]))
  )
    throw new Error("Approved root must be a root commit.");
  try {
    git(["merge-base", "--is-ancestor", approvedRootSha, "HEAD"]);
  } catch {
    throw new Error("Release HEAD must descend from the approved root.");
  }
  if (
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
      .version !== version
  )
    throw new Error("Approved version does not match package version.");
  // Ignored public/source inputs are still consumed by Vite, native tools and
  // packaging. Only explicit reproducible output/dependency roots may be extra.
  const generated = [
    "node_modules/",
    "dist/",
    "out/",
    "native/uninstaller/.build/",
    "native/lifecycle-lock/build/",
    ".pnpm-store/",
    "coverage/",
    "playwright-report/",
    "test-results/",
  ];
  const extras = git(["ls-files", "--others", "-z"])
    .split("\0")
    .filter(Boolean);
  if (
    extras.some((file) => !generated.some((prefix) => file.startsWith(prefix)))
  )
    throw new Error(
      "Release source contains ignored or untracked build inputs.",
    );
  const snapshot = mkdtempSync(path.join(tmpdir(), "caddy-release-preflight-"));
  try {
    const entries = git(["ls-tree", "-rz", "HEAD"]).split("\0").filter(Boolean);
    for (const entry of entries) {
      const split = entry.indexOf("\t");
      const metadata = entry.slice(0, split),
        relative = entry.slice(split + 1);
      if (
        !/^100(?:644|755) blob [a-f0-9]{40}$/.test(metadata) ||
        !PUBLIC_TREE_ALLOWLIST.some(
          (allowed) =>
            relative === allowed || relative.startsWith(`${allowed}/`),
        )
      )
        throw new Error(
          "Release export contains non-public or non-regular source.",
        );
      const bytes = execFileSync(
        "git",
        ["--no-replace-objects", "show", `HEAD:${relative}`],
        {
          cwd: root,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      if (
        !lstatSync(path.join(root, relative)).isFile() ||
        !readFileSync(path.join(root, relative)).equals(bytes)
      )
        throw new Error("Export source bytes differ from approved HEAD.");
      const target = path.join(snapshot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    assertPublicCandidate(snapshot);
    assertNoHighConfidenceSecrets(snapshot);
    assertDocumentationReferences(snapshot);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function firstVersion(value: string) {
  return value.trim().split("\n")[0] ?? value.trim();
}

export function assertManifestDestination(
  root: string,
  destination: string,
): void {
  const parent = realpathSync(path.dirname(destination));
  const resolvedRoot = realpathSync(root);
  if (
    parent === resolvedRoot ||
    parent.startsWith(`${resolvedRoot}${path.sep}`) ||
    existsSync(destination)
  )
    throw new Error(
      "Manifest must be a new file outside the checkout in an existing directory.",
    );
}
