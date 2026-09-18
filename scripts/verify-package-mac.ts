import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractAll, listPackage } from "@electron/asar";
import {
  FuseState,
  type FuseV1Config,
  type FuseV1Options,
  getCurrentFuseWire,
} from "@electron/fuses";
import {
  assertBundleVersion,
  assertMachOMinimum,
} from "./lib/release-bundle-metadata.js";
import { EXPECTED_ELECTRON_FUSE_STATES } from "./lib/electron-fuses.js";
import {
  assertAllowedAsarEntries,
  assertSafePackagedFiles,
  containsSecretLikeContent,
} from "./lib/package-contract.js";

import { readFinderValue, assertBackgroundAlias } from "./lib/finder-plist.js";
import { readAppDmgStore, assertFinderLayout } from "./lib/dmg-store.js";

if (process.platform !== "darwin") {
  throw new Error("The packaged macOS application must be verified on macOS.");
}

const architecture = requireArchitecture(
  process.env.CONVO_CADDY_MAC_ARCH ?? process.arch,
);
const appPath = path.resolve(
  `out/Convo Caddy-darwin-${architecture}/Convo Caddy.app`,
);
const executable = path.join(appPath, "Contents/MacOS/Convo Caddy");
const resources = path.join(appPath, "Contents/Resources");
const asarPath = path.join(resources, "app.asar");
const unpackedRoot = path.join(resources, "app.asar.unpacked");
const extractionRoot = mkdtempSync(
  path.join(tmpdir(), "convo-caddy-asar-verification-"),
);

try {
  requireExisting(appPath, "packaged application");
  requireExisting(executable, "packaged executable");
  requireExisting(asarPath, "application ASAR");
  assertNoRunningApplication();
  assertBundleMetadata(appPath);
  assertArchitecture(executable, architecture);
  const signing = inspectSigning(appPath);
  assertMinimalBundleEntitlements(appPath);
  await verifyFuses(executable);

  const asarEntries = listPackage(asarPath, { isPack: false });
  assertAllowedAsarEntries(asarEntries);
  extractAll(asarPath, extractionRoot);
  assertSafePackagedFiles(extractionRoot);

  const mainBundle = readFileSync(
    path.join(extractionRoot, "dist/desktop/main.mjs"),
    "utf8",
  );
  const sourceProvenance = verifySourceProvenance(extractionRoot);
  const packagedGuide = readFileSync(
    path.join(extractionRoot, "dist/desktop/hermes-connection-setup.md"),
    "utf8",
  );
  if (
    packagedGuide !==
    readFileSync(path.resolve("docs/hermes-connection-setup.md"), "utf8")
  )
    throw new Error("Packaged remote guide does not match source.");
  if (
    !readFileSync(path.join(resources, "acquire-hermes.py")).equals(
      readFileSync(path.resolve("scripts/acquire-hermes.py")),
    )
  )
    throw new Error("Packaged acquisition helper does not match source.");
  if (
    !readFileSync(path.join(resources, "enroll-hermes-key.py")).equals(
      readFileSync(path.resolve("scripts/enroll-hermes-key.py")),
    )
  )
    throw new Error("Packaged enrollment helper does not match source.");
  const packagedFont = readFileSync(
    path.join(extractionRoot, "dist/desktop/instrument-sans.woff2"),
  );
  if (
    !packagedFont.equals(
      readFileSync(
        path.resolve(
          "node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2",
        ),
      ),
    )
  )
    throw new Error(
      "Packaged setup font does not match the licensed source asset.",
    );
  if (!mainBundle.includes('import("@ngrok/ngrok")')) {
    throw new Error(
      "The ngrok runtime import was not preserved as an external.",
    );
  }

  requireExisting(
    path.join(unpackedRoot, "dist/desktop/lifecycle-lock.node"),
    "unpacked lifecycle addon",
  );
  assertNoSecretLikeBundleContent(appPath);
  const nativeArtifacts = findNgrokNativeArtifacts(unpackedRoot);
  if (nativeArtifacts.length === 0) {
    throw new Error("No unpacked ngrok native artifact was found.");
  }
  for (const artifact of nativeArtifacts) {
    assertArchitecture(artifact, architecture);
    verifyCodeSignature(artifact);
  }

  const smoke = await runStrippedPathSmoke(appPath);
  const distributables = findDistributables(architecture);
  const distributableEvidence = verifyDistributables(
    distributables,
    appPath,
    architecture,
  );
  if (process.env.CONVO_CADDY_VERIFY_NOTARIZED === "1") {
    run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      appPath,
    ]);
    run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
  }

  console.log(
    JSON.stringify(
      {
        status: "ok",
        architecture,
        app: appPath,
        distributables,
        distributableEvidence,
        sourceProvenance,
        finderArtwork: {
          contentSize: [560, 400],
          iconSize: 72,
          background: "matched-multiresolution-tiff",
          dsStore: "verified",
          visualAcceptance: "separate-Finder-inspection-required",
        },
        signing,
        asarEntries: asarEntries.length,
        ngrokNativeArtifacts: nativeArtifacts,
        smoke,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(extractionRoot, { recursive: true, force: true });
}

function verifySourceProvenance(extractionRoot: string): {
  schemaVersion: 1;
  sourceSha: string;
  sourceClean: true;
} {
  const provenance = JSON.parse(
    readFileSync(
      path.join(extractionRoot, "dist/desktop/build-provenance.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const head = run("/usr/bin/git", ["rev-parse", "HEAD"]).trim();
  const status = run("/usr/bin/git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).trim();
  if (
    provenance.schemaVersion !== 1 ||
    provenance.sourceSha !== head ||
    provenance.sourceClean !== true ||
    status !== ""
  ) {
    throw new Error(
      "Packaged build provenance does not match the current clean source HEAD.",
    );
  }
  return provenance as {
    schemaVersion: 1;
    sourceSha: string;
    sourceClean: true;
  };
}

function assertBundleMetadata(bundle: string): void {
  assertBundleVersion(bundle, packagedVersion(), run);
  assertMachOMinimum(bundle, "14.0", run);
  const info = path.join(bundle, "Contents/Info.plist");
  expectCommandOutput(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIconFile", "raw", info],
    "electron.icns",
  );
  assertSameFile(
    path.join(bundle, "Contents/Resources/electron.icns"),
    path.resolve("dist/packaging/ConvoCaddy.icns"),
  );
  expectCommandOutput(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", info],
    "com.frameyard.convocaddy",
  );
  expectCommandOutput(
    "/usr/bin/plutil",
    ["-extract", "CFBundleDisplayName", "raw", info],
    "Convo Caddy",
  );
  expectCommandOutput(
    "/usr/bin/plutil",
    ["-extract", "LSMinimumSystemVersion", "raw", info],
    "14.0",
  );
}

function assertArchitecture(file: string, architecture: "arm64" | "x64"): void {
  const expected = architecture === "x64" ? "x86_64" : "arm64";
  const architectures = run("/usr/bin/lipo", ["-archs", file]);
  if (!architectures.split(/\s+/).includes(expected)) {
    throw new Error(`${file} does not contain the ${expected} architecture.`);
  }
}

function verifyCodeSignature(file: string): void {
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    file,
  ]);
}

function assertNoSecretLikeBundleContent(bundle: string): void {
  const pending = [bundle];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (
        entry.isFile() &&
        statSync(absolute).size <= 8 * 1024 * 1024 &&
        containsSecretLikeContent(readFileSync(absolute))
      ) {
        throw new Error(
          `Secret-like content found in final app bundle: ${path.relative(bundle, absolute)}`,
        );
      }
    }
  }
}

function assertMinimalBundleEntitlements(bundle: string): void {
  const forbidden = [
    "com.apple.security.device.audio-input",
    "com.apple.security.device.bluetooth",
    "com.apple.security.device.camera",
    "com.apple.security.device.print",
    "com.apple.security.device.usb",
    "com.apple.security.personal-information.location",
  ];
  const targets = [
    bundle,
    path.join(bundle, "Contents/Frameworks/Convo Caddy Helper (Renderer).app"),
    path.join(bundle, "Contents/Frameworks/Convo Caddy Helper (GPU).app"),
  ];
  for (const target of targets) {
    if (!existsSync(target)) continue;
    const result = spawnSync(
      "/usr/bin/codesign",
      ["--display", "--entitlements", ":-", target],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0) {
      throw new Error(
        `Unable to inspect bundle entitlements: ${result.stderr}`,
      );
    }
    const entitlements = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    for (const entitlement of forbidden) {
      if (entitlements.includes(entitlement)) {
        throw new Error(
          `Packaged bundle has forbidden entitlement: ${entitlement}`,
        );
      }
    }
  }
}

async function verifyFuses(executablePath: string): Promise<void> {
  const current = (await getCurrentFuseWire(
    executablePath,
  )) as FuseV1Config<FuseState>;
  for (const [option, expected] of Object.entries(
    EXPECTED_ELECTRON_FUSE_STATES,
  )) {
    const actual = current[Number(option) as FuseV1Options];
    if (actual !== expected) {
      throw new Error(
        `Electron fuse ${option} is ${fuseName(actual)}; expected ${fuseName(expected)}.`,
      );
    }
  }
}

async function runStrippedPathSmoke(bundlePath: string): Promise<{
  firstLaunch: "secure_setup";
  secondInstance: "focused_existing_instance";
  restart: "state_preserved";
  cleanup: "complete";
}> {
  const smokeRoot = mkdtempSync(
    path.join(tmpdir(), "convo-caddy-package-smoke-"),
  );
  const smokeHome = path.join(smokeRoot, "home");
  const connectionSettingsFile = path.join(
    smokeHome,
    "Library/Application Support/Convo Caddy/config/connections.json",
  );
  const legacyConfigFile = path.join(
    smokeHome,
    "Library/Application Support/Convo Caddy/config/.env",
  );
  const workspaceRoot = path.join(
    smokeHome,
    "Library/Application Support/Convo Caddy/workspace",
  );
  const logFile = path.join(smokeHome, "Library/Logs/Convo Caddy/desktop.log");
  const environment: NodeJS.ProcessEnv = {
    HOME: smokeHome,
    LANG: "en_US.UTF-8",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "convo-caddy-smoke",
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/zsh",
    TMPDIR: smokeRoot,
    USER: process.env.USER ?? "convo-caddy-smoke",
  };
  let owned: ChildProcess | null = null;

  try {
    owned = launch(bundlePath, environment);
    await waitForFile(connectionSettingsFile, owned, 20_000);
    await waitForLogEvent(
      logFile,
      "desktop_runtime_setup_ready",
      owned,
      20_000,
    );
    assertSmokePaths(connectionSettingsFile, workspaceRoot, bundlePath);
    assertPrivateFile(connectionSettingsFile);
    assertFreshConnectionSettings(connectionSettingsFile);
    if (existsSync(legacyConfigFile)) {
      throw new Error("Fresh packaged setup created a plaintext .env file.");
    }
    const initialSettings = readFileSync(connectionSettingsFile, "utf8");
    assertHealthySetupLog(logFile);

    const second = launch(bundlePath, environment);
    await waitForExit(second, 10_000);
    if (second.exitCode !== 0) {
      throw new Error("The packaged second instance did not exit cleanly.");
    }
    await waitForLogEvent(
      logFile,
      "desktop_second_instance_focused",
      owned,
      10_000,
    );
    if (owned.exitCode !== null) {
      throw new Error(
        "The first packaged instance lost ownership unexpectedly.",
      );
    }
    await quitOwnedApplication(owned, bundlePath);
    owned = null;

    const firstStartCount = countLogEvent(logFile, "desktop_started");
    owned = launch(bundlePath, environment);
    await waitForLogEventCount(
      logFile,
      "desktop_started",
      firstStartCount + 1,
      owned,
      20_000,
    );
    await waitForLogEventCount(
      logFile,
      "desktop_runtime_setup_ready",
      2,
      owned,
      20_000,
    );
    if (readFileSync(connectionSettingsFile, "utf8") !== initialSettings) {
      throw new Error("The packaged restart changed persisted setup state.");
    }
    if (existsSync(legacyConfigFile)) {
      throw new Error("Packaged restart created a plaintext .env file.");
    }
    assertHealthySetupLog(logFile);
    await quitOwnedApplication(owned, bundlePath);
    owned = null;
    await waitForNoRunningApplication(5_000);

    return {
      firstLaunch: "secure_setup",
      secondInstance: "focused_existing_instance",
      restart: "state_preserved",
      cleanup: "complete",
    };
  } finally {
    if (owned && owned.exitCode === null) {
      // On uncertain ownership/exit, preserve the synthetic state and fail.
      // Never quit by global bundle ID or kill the Launch Services waiter.
      await quitOwnedApplication(owned, bundlePath);
    }
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function launch(
  bundlePath: string,
  environment: NodeJS.ProcessEnv,
): ChildProcess {
  const launchEnvironment = Object.entries(environment).flatMap(
    ([name, value]) =>
      value === undefined ? [] : ["--env", `${name}=${value}`],
  );
  return spawn(
    "/usr/bin/open",
    ["-n", "-W", "-j", ...launchEnvironment, bundlePath],
    {
      env: environment,
      stdio: "ignore",
    },
  );
}

async function quitOwnedApplication(
  processHandle: ChildProcess,
  bundlePath: string,
): Promise<void> {
  run("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import('AppKit');
     function run(argv) {
       const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
       const matches = [];
       for (let i = 0; i < apps.count; i++) {
         const app = apps.objectAtIndex(i);
         if (app.bundleURL && app.executableURL &&
             ObjC.unwrap(app.bundleURL.path) === argv[0] &&
             ObjC.unwrap(app.executableURL.path) === argv[0] + '/Contents/MacOS/Convo Caddy') matches.push(app);
       }
       if (matches.length !== 1) throw Error('Candidate process ownership is ambiguous; no application was quit.');
       if (!matches[0].terminate) throw Error('Candidate refused graceful termination.');
     }`,
    bundlePath,
  ]);
  await waitForExit(processHandle, 15_000);
  if (processHandle.exitCode !== 0) {
    throw new Error("The packaged application did not quit cleanly.");
  }
}

function assertSmokePaths(
  connectionSettingsFile: string,
  workspaceRoot: string,
  bundlePath: string,
): void {
  const projectRoot = path.resolve(".");
  for (const managedPath of [connectionSettingsFile, workspaceRoot]) {
    if (
      isWithin(managedPath, projectRoot) ||
      isWithin(managedPath, bundlePath)
    ) {
      throw new Error(
        "Packaged data resolved inside the repository or app bundle.",
      );
    }
  }
  if (existsSync(workspaceRoot)) {
    throw new Error(
      "Setup-only smoke unexpectedly created a participant workspace.",
    );
  }
}

function assertPrivateFile(file: string): void {
  if ((statSync(file).mode & 0o777) !== 0o600) {
    throw new Error("The packaged connection settings are not owner-private.");
  }
}

function assertFreshConnectionSettings(file: string): void {
  const contents = readFileSync(file, "utf8");
  const settings = JSON.parse(contents) as Record<string, unknown>;
  if (
    settings.schemaVersion !== 4 ||
    JSON.stringify(settings.recall) !==
      JSON.stringify({ region: "us-west-2", language: "en" }) ||
    JSON.stringify(settings.ngrok) !== JSON.stringify({ domain: null }) ||
    JSON.stringify(settings.hermes) !==
      JSON.stringify({
        mode: null,
        localPort: 8642,
        remotePort: 8642,
        sshTarget: null,
        endpointPath: "/",
        profile: null,
      }) ||
    settings.activeSecretGeneration !== null ||
    JSON.stringify(settings.configuredSecretRoles) !== "[]" ||
    settings.candidateSecretGeneration !== null ||
    JSON.stringify(settings.secretGenerationsPendingCleanup) !== "[]"
  ) {
    throw new Error(
      "Fresh packaged connection settings are not safe defaults.",
    );
  }
  if (/CONVO_CADDY_|whsec_/i.test(contents)) {
    throw new Error(
      "Fresh packaged connection settings contain personal or secret defaults.",
    );
  }
}

function assertHealthySetupLog(logFile: string): void {
  const events = readLogEvents(logFile);
  if (!events.includes("desktop_started")) {
    throw new Error("The packaged desktop shell did not report startup.");
  }
  for (const failure of [
    "desktop_startup_needs_attention",
    "desktop_startup_failed",
    "uncaught_exception",
    "unhandled_rejection",
  ]) {
    if (events.includes(failure)) {
      throw new Error(`The packaged setup smoke logged ${failure}.`);
    }
  }
}

function findNgrokNativeArtifacts(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const artifacts: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".node")) {
        artifacts.push(absolute);
      }
    }
  }
  return artifacts.sort();
}

function findDistributables(architecture: "arm64" | "x64"): string[] {
  const version = packagedVersion();
  const candidates = [
    path.resolve(`out/make/Convo Caddy-${version}-${architecture}.dmg`),
    path.resolve(
      `out/make/zip/darwin/${architecture}/Convo Caddy-darwin-${architecture}-${version}.zip`,
    ),
  ];
  for (const candidate of candidates) {
    requireExisting(candidate, "macOS distributable");
  }
  return candidates;
}

function verifyDistributables(
  distributables: string[],
  verifiedApp: string,
  architecture: "arm64" | "x64",
): Array<{
  artifact: string;
  sha256: string;
  appTreeSha256: string;
  uninstallerTreeSha256?: string;
  artifactType: "dmg" | "zip";
}> {
  const dmg = distributables.find((candidate) => candidate.endsWith(".dmg"));
  const zip = distributables.find((candidate) => candidate.endsWith(".zip"));
  if (!dmg || !zip) {
    throw new Error("Both DMG and ZIP distributables are required.");
  }
  run("/usr/bin/hdiutil", ["verify", dmg]);
  run("/usr/bin/unzip", ["-tq", zip]);

  const expectedTree = hashDirectoryTree(verifiedApp);
  const expectedUninstallerTree = hashDirectoryTree(
    path.resolve("dist/packaging/Uninstall Convo Caddy.app"),
  );
  const evidence: Array<{
    artifact: string;
    sha256: string;
    appTreeSha256: string;
    uninstallerTreeSha256?: string;
  }> = [];
  const extraction = mkdtempSync(
    path.join(tmpdir(), "convo-caddy-distributable-verification-"),
  );
  let mountPoint: string | null = null;
  try {
    const zipRoot = path.join(extraction, "zip");
    mkdirSync(zipRoot, { recursive: true });
    run("/usr/bin/ditto", ["-x", "-k", zip, zipRoot]);
    const zipApp = findContainedApplication(zipRoot);
    verifyContainedApplication(zipApp, architecture, expectedTree);
    evidence.push({
      artifact: zip,
      artifactType: "zip" as const,
      sha256: hashFile(zip),
      appTreeSha256: hashDirectoryTree(zipApp),
    });

    mountPoint = path.join(extraction, "dmg");
    mkdirSync(mountPoint, { recursive: true });
    run("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountPoint,
      dmg,
    ]);
    verifyFinderArtwork(mountPoint);
    const dmgApp = findContainedApplication(mountPoint);
    verifyContainedApplication(dmgApp, architecture, expectedTree);
    verifyContainedUninstaller(
      mountPoint,
      architecture,
      expectedUninstallerTree,
    );
    evidence.push({
      artifact: dmg,
      artifactType: "dmg" as const,
      sha256: hashFile(dmg),
      appTreeSha256: hashDirectoryTree(dmgApp),
      uninstallerTreeSha256: expectedUninstallerTree,
    });
    run("/usr/bin/hdiutil", ["detach", mountPoint]);
    mountPoint = null;
  } finally {
    if (mountPoint) {
      run("/usr/bin/hdiutil", ["detach", "-force", mountPoint]);
    }
    rmSync(extraction, { recursive: true, force: true });
  }
  return evidence;
}

function verifyContainedUninstaller(
  root: string,
  architecture: "arm64" | "x64",
  expectedUninstallerTree: string,
): void {
  const bundle = path.join(root, "Uninstall Convo Caddy.app");
  requireExisting(bundle, "standalone uninstaller");
  assertBundleVersion(bundle, packagedVersion(), run);
  assertMachOMinimum(bundle, "14.0", run);
  const info = path.join(bundle, "Contents/Info.plist");
  expectCommandOutput(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", info],
    "com.frameyard.convocaddy.uninstaller",
  );
  expectCommandOutput(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIconFile", "raw", info],
    "UninstallConvoCaddy.icns",
  );
  assertSameFile(
    path.join(bundle, "Contents/Resources/UninstallConvoCaddy.icns"),
    path.resolve("dist/packaging/UninstallConvoCaddy.icns"),
  );
  if (
    hashFile(path.resolve("dist/packaging/UninstallConvoCaddy.icns")) ===
    hashFile(path.resolve("dist/packaging/ConvoCaddy.icns"))
  )
    throw new Error("Uninstaller icon must be distinct.");
  assertArchitecture(
    path.join(bundle, "Contents/MacOS/Uninstall Convo Caddy"),
    architecture,
  );
  verifyCodeSignature(bundle);
  assertNoSecretLikeBundleContent(bundle);
  if (hashDirectoryTree(bundle) !== expectedUninstallerTree) {
    throw new Error(
      "DMG uninstaller differs from the freshly built uninstaller.",
    );
  }
  // Load an isolated copy without the main app beside it; this mode exits
  // before inventory/Keychain access and cannot perform an uninstall.
  const probeRoot = mkdtempSync(path.join(tmpdir(), "cc-uninstaller-runtime-"));
  try {
    const isolated = path.join(probeRoot, "Uninstall Convo Caddy.app");
    run("/usr/bin/ditto", [bundle, isolated]);
    const output = execFileSync(
      path.join(isolated, "Contents/MacOS/Uninstall Convo Caddy"),
      ["--verify-runtime"],
      {
        env: { PATH: "/usr/bin:/bin", HOME: probeRoot, TMPDIR: probeRoot },
        timeout: 10_000,
        encoding: "utf8",
      },
    ).trim();
    if (output !== "uninstaller-runtime-ok")
      throw new Error("Uninstaller runtime probe failed.");
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function assertSameFile(actual: string, expected: string): void {
  if (!readFileSync(actual).equals(readFileSync(expected)))
    throw new Error(`Packaged artwork differs: ${path.basename(actual)}`);
}

function verifyFinderArtwork(root: string): void {
  assertSameFile(
    path.join(root, ".background/dmg-background.tiff"),
    path.resolve("dist/packaging/dmg-background.tiff"),
  );
  assertSameFile(
    path.join(root, ".VolumeIcon.icns"),
    path.resolve("dist/packaging/ConvoCaddy.icns"),
  );
  if (readlinkSync(path.join(root, "Applications")) !== "/Applications")
    throw new Error("DMG Applications link changed.");
  const store = readAppDmgStore(readFileSync(path.join(root, ".DS_Store")));
  const value = (code: string, key: string): string => {
    const bytes = store.plists[code];
    if (!bytes) throw new Error(`Missing Finder ${code} record`);
    return readFinderValue(bytes, key);
  };
  const view = {
    iconSize: Number(value("icvp", "iconSize")),
    textSize: Number(value("icvp", "textSize")),
    labelOnBottom: value("icvp", "labelOnBottom") === "true",
    arrangeBy: value("icvp", "arrangeBy"),
    backgroundType: Number(value("icvp", "backgroundType")),
    backgroundImageAlias: value("icvp", "backgroundImageAlias"),
  };
  assertFinderLayout(
    store.icons,
    {
      WindowBounds: value("bwsp", "WindowBounds"),
      ShowToolbar: value("bwsp", "ShowToolbar") !== "false",
      ShowStatusBar: value("bwsp", "ShowStatusBar") !== "false",
    },
    view,
  );
  const alias = Buffer.from(String(view.backgroundImageAlias), "base64");
  assertBackgroundAlias(alias, {
    parentId: statSync(path.join(root, ".background")).ino,
    targetId: statSync(path.join(root, ".background/dmg-background.tiff")).ino,
  });
}

function packagedVersion(): string {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("The package manifest has no version.");
  }
  return manifest.version;
}

function findContainedApplication(root: string): string {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name === "Convo Caddy.app") {
        matches.push(absolute);
      } else if (entry.isDirectory()) {
        pending.push(absolute);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Convo Caddy.app in distributable; found ${matches.length}.`,
    );
  }
  return matches[0] as string;
}

function verifyContainedApplication(
  containedApp: string,
  architecture: "arm64" | "x64",
  expectedTree: string,
): void {
  assertBundleMetadata(containedApp);
  assertArchitecture(
    path.join(containedApp, "Contents/MacOS/Convo Caddy"),
    architecture,
  );
  inspectSigning(containedApp);
  assertMinimalBundleEntitlements(containedApp);
  assertNoSecretLikeBundleContent(containedApp);
  const actualTree = hashDirectoryTree(containedApp);
  if (actualTree !== expectedTree) {
    throw new Error("A distributable contains a different application tree.");
  }
}

function hashFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function hashDirectoryTree(root: string): string {
  const hash = createHash("sha256");
  const pending = [root];
  const entries: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      entries.push(relative);
      if (entry.isDirectory()) pending.push(absolute);
    }
  }
  for (const relative of entries.sort()) {
    const absolute = path.join(root, relative);
    const metadata = statSync(absolute);
    hash.update(relative);
    hash.update(metadata.isDirectory() ? "directory" : "file");
    if (metadata.isFile()) hash.update(readFileSync(absolute));
  }
  return hash.digest("hex");
}

function assertNoRunningApplication(): void {
  if (isApplicationRunning()) {
    throw new Error(
      "Close the currently running Convo Caddy app before package verification.",
    );
  }
}

function isApplicationRunning(): boolean {
  try {
    const output = execFileSync("/usr/bin/pgrep", ["-x", "Convo Caddy"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

async function waitForNoRunningApplication(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isApplicationRunning()) {
      return;
    }
    await delay(100);
  }
  throw new Error("The packaged Convo Caddy process did not finish quitting.");
}

async function waitForFile(
  file: string,
  processHandle: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    () => existsSync(file),
    processHandle,
    timeoutMs,
    `file ${file}`,
  );
}

async function waitForLogEvent(
  file: string,
  event: string,
  processHandle: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  await waitForLogEventCount(file, event, 1, processHandle, timeoutMs);
}

async function waitForLogEventCount(
  file: string,
  event: string,
  count: number,
  processHandle: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    () => existsSync(file) && countLogEvent(file, event) >= count,
    processHandle,
    timeoutMs,
    `log event ${event}`,
  );
}

async function waitFor(
  condition: () => boolean,
  processHandle: ChildProcess,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      throw new Error(`The packaged app exited before ${label}.`);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for packaged ${label}.`);
}

async function waitForExit(
  processHandle: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (processHandle.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => processHandle.once("exit", () => resolve())),
    delay(timeoutMs).then(() => {
      throw new Error("Timed out waiting for the packaged process to exit.");
    }),
  ]);
}

function countLogEvent(file: string, event: string): number {
  return readLogEvents(file).filter((candidate) => candidate === event).length;
}

function readLogEvents(file: string): string[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: unknown })
    .flatMap((entry) => (typeof entry.event === "string" ? [entry.event] : []));
}

function expectCommandOutput(
  command: string,
  args: string[],
  expected: string,
): void {
  const actual = run(command, args);
  if (actual !== expected) {
    throw new Error(`${args.at(-1)} has unexpected metadata: ${actual}`);
  }
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function requireExisting(target: string, label: string): void {
  if (!existsSync(target)) {
    throw new Error(`Missing ${label}: ${target}`);
  }
}

function requireArchitecture(value: string): "arm64" | "x64" {
  if (value !== "arm64" && value !== "x64") {
    throw new Error(`Unsupported macOS architecture: ${value}`);
  }
  return value;
}

function inspectSigning(
  file: string,
): "developer-id-notarized" | "developer-id" | "local-ad-hoc" {
  verifyCodeSignature(file);
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", file],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to inspect packaged signature: ${result.stderr}`);
  }
  const details = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const adHoc =
    details.includes("Signature=adhoc") || details.includes("flags=0x2(adhoc)");
  const developerId = details.includes("Authority=Developer ID Application:");
  if (!adHoc && !developerId) {
    throw new Error(
      "The packaged signature is neither local ad-hoc nor Developer ID Application.",
    );
  }
  if (process.env.CONVO_CADDY_VERIFY_NOTARIZED === "1") {
    if (!developerId) {
      throw new Error(
        "Notarized verification requires a Developer ID Application signature.",
      );
    }
    return "developer-id-notarized";
  }
  return developerId ? "developer-id" : "local-ad-hoc";
}

function fuseName(state: FuseState | undefined): string {
  return state === undefined ? "undefined" : FuseState[state];
}

function isWithin(candidate: string, boundary: string): boolean {
  const relative = path.relative(
    path.resolve(boundary),
    path.resolve(candidate),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
