import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type MatrixStatus = "automated" | "mixed" | "pending";
export const MATRIX_CASES: ReadonlyArray<{
  id: string;
  contractHeading: string;
  status: MatrixStatus;
  evidence: string;
}> = [
  {
    id: "W1",
    contractHeading: "§4.2 Workspace preservation",
    status: "automated",
    evidence:
      "Swift W1 runs the descriptor filesystem against a current external workspace and verifies default-No byte retention.",
  },
  {
    id: "W2",
    contractHeading: "§4.2 Workspace preservation",
    status: "automated",
    evidence:
      "Swift W2 preserves and verifies a tagged legacy nested workspace before its private ancestor and legacy environment are removed.",
  },
  {
    id: "W3",
    contractHeading: "§4.2 Workspace preservation",
    status: "automated",
    evidence:
      "Swift W3 requires affirmative workspace consent; the production primary prompt supplies it for Yes and removes only the identity-bound dedicated workspace.",
  },
  {
    id: "W4",
    contractHeading: "§4.2 Workspace preservation",
    status: "automated",
    evidence:
      "Swift W4 retains an ambiguous old selected root and its unrelated files while removing private app state.",
  },
  {
    id: "W5",
    contractHeading: "§4.1 Inventory and path safety",
    status: "automated",
    evidence:
      "Swift W5 rejects malformed or unreadable preferences, unsafe ancestors, ownership/bundle failures, and identity or mount replacement.",
  },
  {
    id: "W6",
    contractHeading: "§4.2 Workspace preservation",
    status: "automated",
    evidence:
      "Swift W6 injects copy, synchronization, publication, destination, source-change, and unavailable-volume failures and retains the original.",
  },
  {
    id: "K1",
    contractHeading: "§4.3 Credential cleanup",
    status: "automated",
    evidence:
      "Swift K1 uses only a fake metadata port to remove every exact-service generation across simulated customized keychains without reading secrets.",
  },
  {
    id: "K2",
    contractHeading: "§4.3 Credential cleanup",
    status: "automated",
    evidence:
      "Swift K2 makes locked, denied, unavailable, and surviving fake-Keychain results incomplete and safely retryable.",
  },
  {
    id: "L1",
    contractHeading: "§4.4 Lifecycle exclusion",
    status: "automated",
    evidence:
      "Swift L1 removes private checkpoints without a mandatory backup; production dialog tests distinguish idle and possible remote capture without provider mutation.",
  },
  {
    id: "L2",
    contractHeading: "§4.4 Lifecycle exclusion",
    status: "automated",
    evidence:
      "Swift and C-addon tests exercise the stable inode lock, startup failure, crash release, helper lifetime, operation drain, and concurrent exclusion.",
  },
  {
    id: "L3",
    contractHeading: "§4.4 Lifecycle exclusion",
    status: "automated",
    evidence:
      "Swift L3 controlled process ports block legacy/relaunch/unknown concurrency without name-based kills or unrelated-service mutation.",
  },
  {
    id: "R1",
    contractHeading: "§4.5 Interruption and restart",
    status: "automated",
    evidence:
      "Swift R1 crashes at real journal, preservation, deletion, and verification boundaries and requires fresh confirmation without overwriting evidence.",
  },
  {
    id: "R2",
    contractHeading: "§4.5 Interruption and restart",
    status: "automated",
    evidence:
      "Swift R2 covers cancel-before/during mutation, repeated runs, truthful partial outcomes, and two-uninstaller serialization.",
  },
  {
    id: "P1",
    contractHeading: "§4.6 Packaging and ordinary outcomes",
    status: "automated",
    evidence:
      "Swift/package tests treat a missing app, ejected DMG, absent optional paths, and independently reopened uninstaller as ordinary bounded outcomes.",
  },
  {
    id: "P2",
    contractHeading: "§4.6 Packaging and ordinary outcomes",
    status: "automated",
    evidence:
      "Swift P2 returns an explicit incomplete permission result for non-writable targets and never escalates to root.",
  },
  {
    id: "P3",
    contractHeading: "§4.6 Packaging and ordinary outcomes",
    status: "mixed",
    evidence:
      "Package smoke proves built app/addon/uninstaller runtime with a stripped developer-tool PATH; downloaded quarantine and Gatekeeper remain G1/G3 operational evidence.",
  },
  {
    id: "D1",
    contractHeading: "§4.7 Independent audience acceptance",
    status: "pending",
    evidence:
      "The human and fresh-agent README passes, kept-workspace reinstall, and separately disposable Yes fixture require the exact G1/G3 candidate and people; source tests protect their written contracts only.",
  },
  {
    id: "S1",
    contractHeading: "§4.8 Publication integrity",
    status: "mixed",
    evidence:
      "Source tests fail closed on signature/team/notary, local checksum, modified artifact, and private-export mismatches; remote link/hash verification remains G4.",
  },
] as const;

export type ParsedArguments =
  | { mode: "synthetic" }
  | {
      mode: "real-machine";
      scopeFile: string;
      confirmation: string;
      scope: RealMachineScope;
    };

interface RealMachineScope {
  schemaVersion: 1;
  approvedBy: "Moritz";
  sourceSha: string;
  artifactSha256: string;
  exactPaths: string[];
}

const EXACT_G3_CONFIRMATION = "I APPROVE THIS EXACT G3 SCOPE";
export const NATIVE_ASSERTION_EVIDENCE = [
  {
    matrix: "W1",
    subcondition: "external default-No byte retention",
    test: "W1 external workspace + default No removes private state and preserves every byte",
  },
  {
    matrix: "W2",
    subcondition: "legacy no-overwrite preservation",
    test: "W2 legacy nested + No publishes verified no-overwrite preservation before deleting ancestor",
  },
  {
    matrix: "W3",
    subcondition: "dedicated final consent and exact deletion",
    test: "W3 dedicated Yes requires final affirmative consent and removes exact workspace",
  },
  {
    matrix: "W4",
    subcondition: "ambiguous old root retention",
    test: "W4 old selected root remains intact under ordinary private uninstall",
  },
  {
    matrix: "W5",
    subcondition: "malformed and unreadable preferences",
    test: "review W5 valid JSON with invalid preference schema is not readable ownership evidence",
  },
  {
    matrix: "W5",
    subcondition: "root home nested symlink and wrong bundle rejection",
    test: "U3 W5 root home true symlink ancestor and wrong bundle are rejected",
  },
  {
    matrix: "W5",
    subcondition: "owner inode and device identity replacement",
    test: "recovery descriptor-pinned root replacement never deletes the replacement",
  },
  {
    matrix: "W5",
    subcondition: "owner permission and mount-device fault propagation",
    test: "U3 W5 owner permission and mount device replacement block deletion",
  },
  {
    matrix: "W6",
    subcondition: "copy sync publication interruption",
    test: "w6FailureBoundariesKeepOriginal(boundary:)",
  },
  {
    matrix: "W6",
    subcondition: "existing destination and changed source",
    test: "W6 existing destination and changed source identity retain original",
  },
  {
    matrix: "W6",
    subcondition: "full disk at production write seam",
    test: "U3 W6 full disk at production write seam preserves original and containing root",
  },
  {
    matrix: "W6",
    subcondition: "cross-volume interrupted copy after first chunk",
    test: "U3 W6 cross volume interrupted second copy chunk preserves original and containing root",
  },
  {
    matrix: "W6",
    subcondition: "unavailable destination volume open",
    test: "U3 W6 unavailable destination volume open preserves original and containing root",
  },
  {
    matrix: "K1",
    subcondition: "all exact service generations without secret reads",
    test: "K1 exact service generations across custom keychains delete persistent refs without secret reads",
  },
  {
    matrix: "K2",
    subcondition: "locked denied unavailable and explicit retry",
    test: "K2 locked denied unavailable Keychain is incomplete and retry is explicit",
  },
  {
    matrix: "L1",
    subcondition: "private checkpoint deletion without backup",
    test: "L1 private checkpoint cleanup needs no backup or remote action",
  },
  {
    matrix: "L1",
    subcondition: "legacy crashed-session discovery",
    test: "review L1 legacy pointer does not prove a remote capture; known workspace stays protected",
  },
  {
    matrix: "L1",
    subcondition: "single primary consent without checkpoint backups",
    test: "No workspace Yes and No need exactly one consent, even with a checkpoint",
  },
  {
    matrix: "L1",
    subcondition: "actual producer states give nonblocking information",
    test: "Real producer checkpoints inform without blocking or requiring private backups",
  },
  {
    matrix: "W3",
    subcondition: "whole child scope in sole primary prompt",
    test: "Dedicated Yes confirms the exact whole child in the primary prompt",
  },
  {
    matrix: "R1",
    subcondition: "interrupted uninstall fresh consent and cancel",
    test: "Interrupted uninstall needs fresh primary consent and keeps its journal on Cancel",
  },
  {
    matrix: "R1",
    subcondition: "lost preferences and fresh primary consent",
    test: "Lost preferences retry shows exact journal workspace for fresh No Yes Cancel",
  },
  {
    matrix: "R1",
    subcondition: "second interruption after keep",
    test: "Retry never forgets a kept workspace if fresh No is interrupted again",
  },
  {
    matrix: "R1",
    subcondition: "unverified outstanding paths retain evidence",
    test: "Replaced or unverified retry target stays blocked with persisted evidence",
  },
  {
    matrix: "R1",
    subcondition: "retry identity race after primary consent",
    test: "Retry revalidates journal workspace identity after primary consent",
  },
  {
    matrix: "R1",
    subcondition: "already removed targets are not falsely retained",
    test: "Already removed journal workspace is not claimed retained or deleted again",
  },
  {
    matrix: "L2",
    subcondition: "stable inode and uninstaller serialization",
    test: "L2 exclusive lock uses stable inode, serializes uninstallers, and releases after owner exits",
  },
  {
    matrix: "L3",
    subcondition: "legacy unknown and unrelated process safety",
    test: "L3 legacy or unknown process blocks without name kill, provider mutation, or unrelated-service change",
  },
  {
    matrix: "R1",
    subcondition: "all journal and deletion crash boundaries",
    test: "r1CrashAtJournalAndDeletionBoundariesIsIncompleteAndNeedsFreshConfirmation(phase:)",
  },
  {
    matrix: "R1",
    subcondition: "durable restart acknowledgment",
    test: "recovery writes preservation plan before staging and requires acknowledgment on restart",
  },
  {
    matrix: "R2",
    subcondition: "cancel repeat and concurrent exclusion",
    test: "R2 cancel before mutation preserves data; repeated run is idempotent; concurrent lock is excluded",
  },
  {
    matrix: "R2",
    subcondition: "during-deletion event delivery",
    test: "review36 each deletion target offers cancellation event delivery",
  },
  {
    matrix: "P1",
    subcondition: "missing app ejected DMG absent optional paths",
    test: "P1 missing app, ejected DMG, and absent optional paths are normal",
  },
  {
    matrix: "P2",
    subcondition: "nonwritable target no escalation",
    test: "P2 nonwritable target returns incomplete without root escalation",
  },
] as const;
export const TYPESCRIPT_ASSERTION_EVIDENCE = [
  {
    matrix: "L2",
    subcondition: "lock before startup and explicit release",
    test: "acquires before normal startup ownership and releases only explicitly",
  },
  {
    matrix: "L2",
    subcondition: "addon load or acquisition failure prevents startup",
    test: "fails closed when addon load or acquisition fails",
  },
  {
    matrix: "L2",
    subcondition: "helper exit cannot release main ownership",
    test: "keeps ownership independent of helper child lifetime",
  },
  {
    matrix: "L2",
    subcondition: "runtime work drains before lock release",
    test: "retains the maintenance lock until process exit when runtime drain fails",
  },
  {
    matrix: "L2",
    subcondition: "packaged addon is main-owned and fail-closed",
    test: "builds a Node-API addon owned by Electron main and fails closed",
  },
  {
    matrix: "P1",
    subcondition: "independently runnable DMG uninstaller",
    test: "offers a no-inventory runtime probe and binds the DMG uninstaller",
  },
] as const;

export function parseInstallUninstallArguments(
  args: string[],
  _environment: NodeJS.ProcessEnv = process.env,
): ParsedArguments {
  const mode = valueAfter(args, "--mode") ?? "synthetic";
  if (mode === "synthetic") return { mode };
  if (mode !== "real-machine")
    throw new Error("Mode must be synthetic or real-machine.");
  const scopeFile = valueAfter(args, "--g3-scope");
  const confirmation = valueAfter(args, "--confirm");
  if (!scopeFile || !confirmation)
    throw new Error(
      "Real-machine mode requires a G3 scope file and exact confirmation.",
    );
  if (confirmation !== EXACT_G3_CONFIRMATION)
    throw new Error(`Exact confirmation must be: ${EXACT_G3_CONFIRMATION}`);
  const scope = validateScopeFile(scopeFile);
  return { mode, scopeFile, confirmation, scope };
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export interface CommandPort {
  run(command: string, args: string[]): CommandResult;
}
export interface SyntheticInput {
  mode: "synthetic";
  sourceRoot: string;
  sourceSha: string;
  artifacts: string[];
  receipt: string;
}

export function verifyInstallUninstall(
  input: SyntheticInput,
  port: CommandPort = systemPort(input.sourceRoot),
) {
  if (input.mode !== "synthetic")
    throw new Error("Only synthetic execution is available without G3.");
  if (!/^[0-9a-f]{40}$/.test(input.sourceSha))
    throw new Error("Source SHA must be a full lowercase Git SHA.");
  if (!input.artifacts.length)
    throw new Error("At least one candidate artifact is required.");
  const actualHead = checked(
    port.run("git", ["rev-parse", "HEAD"]),
    "source identity",
  ).stdout.trim();
  if (actualHead !== input.sourceSha)
    throw new Error("Claimed source SHA does not match sourceRoot HEAD.");
  const sourceStatus = checked(
    port.run("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
    "source cleanliness",
  ).stdout.trim();
  if (sourceStatus !== "")
    throw new Error("A success receipt requires a clean source worktree.");
  const swift = checked(
    port.run("swift", [
      "test",
      "--package-path",
      path.join(input.sourceRoot, "native/uninstaller"),
      "-Xswiftc",
      "-F/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
      "-Xlinker",
      "-F/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
      "-Xlinker",
      "-rpath",
      "-Xlinker",
      "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
    ]),
    "native Swift safety matrix",
  );
  const swiftCount = Number(
    combined(swift).match(/with (\d+) tests in \d+ suites passed/)?.[1] ??
      combined(swift).match(/(\d+) tests in \d+ suites/)?.[1],
  );
  if (!Number.isFinite(swiftCount) || swiftCount < 55)
    throw new Error(
      "Native Swift suite did not prove at least 55 actually executed tests.",
    );
  const passedTests = parsePassedSwiftTests(combined(swift));
  const missingNativeCases = NATIVE_ASSERTION_EVIDENCE.filter(
    ({ test }) => !passedTests.has(test),
  );
  if (missingNativeCases.length)
    throw new Error(
      `Native Swift output did not prove passed assertion identities: ${missingNativeCases.map(({ matrix, subcondition }) => `${matrix}/${subcondition}`).join(", ")}`,
    );
  const addon = checked(
    port.run("python3", ["native/lifecycle-lock/test_lock.py", "-v"]),
    "native addon suite",
  );
  const addonCount = Number(combined(addon).match(/Ran (\d+) tests/)?.[1]);
  if (!Number.isFinite(addonCount) || addonCount < 3)
    throw new Error(
      "Native addon suite did not prove three actually executed tests.",
    );
  const requiredAddonTests = [
    "test_alias_ancestor_rejected",
    "test_contention_helper_exit_and_main_crash",
    "test_public_marker_rejected",
  ];
  const missingAddonTests = requiredAddonTests.filter(
    (name) =>
      !combined(addon)
        .split(/\r?\n/)
        .some(
          (line) =>
            line.startsWith(`${name} (`) && line.trimEnd().endsWith("... ok"),
        ),
  );
  if (missingAddonTests.length)
    throw new Error(
      `Native addon output did not prove passed test identities: ${missingAddonTests.join(", ")}`,
    );
  const typescript = checked(
    port.run("pnpm", [
      "vitest",
      "run",
      "tests/desktop/maintenance-lock.test.ts",
      "tests/desktop/application.test.ts",
      "tests/package/maintenance-lock-package.test.ts",
      "tests/package/uninstaller-package.test.ts",
      "--reporter=json",
    ]),
    "TypeScript production-seam assertions",
  );
  const testReport = parseJsonObject(typescript.stdout);
  const passedTypeScriptTests = new Set(
    Array.isArray(testReport.testResults)
      ? testReport.testResults.flatMap((file) =>
          file &&
          typeof file === "object" &&
          Array.isArray(
            (file as { assertionResults?: unknown }).assertionResults,
          )
            ? (
                file as {
                  assertionResults: Array<{
                    title?: unknown;
                    status?: unknown;
                  }>;
                }
              ).assertionResults
                .filter(({ status }) => status === "passed")
                .flatMap(({ title }) =>
                  typeof title === "string" ? [title] : [],
                )
            : [],
        )
      : [],
  );
  const missingTypeScript = TYPESCRIPT_ASSERTION_EVIDENCE.filter(
    ({ test }) => !passedTypeScriptTests.has(test),
  );
  if (missingTypeScript.length)
    throw new Error(
      `TypeScript output did not prove passed assertion identities: ${missingTypeScript.map(({ matrix, subcondition }) => `${matrix}/${subcondition}`).join(", ")}`,
    );
  const packaged = checked(
    port.run("pnpm", ["verify:package:mac"]),
    "isolated package verification",
  );
  const packageEvidence = parseJsonObject(packaged.stdout);
  if (
    packageEvidence.status !== "ok" ||
    packageEvidence.signing !== "local-ad-hoc" ||
    (packageEvidence.smoke as { cleanup?: unknown } | undefined)?.cleanup !==
      "complete"
  )
    throw new Error(
      "Package verification did not prove isolated local-ad-hoc smoke cleanup.",
    );
  const packageProvenance = packageEvidence.sourceProvenance as
    | { schemaVersion?: unknown; sourceSha?: unknown; sourceClean?: unknown }
    | undefined;
  if (
    packageProvenance?.schemaVersion !== 1 ||
    packageProvenance.sourceSha !== actualHead ||
    packageProvenance.sourceClean !== true
  )
    throw new Error("Package provenance does not match the clean source HEAD.");
  const artifacts = input.artifacts.map((artifact) => {
    const resolved = realpathSync(artifact);
    if (!statSync(resolved).isFile())
      throw new Error(`Artifact is not a regular file: ${artifact}`);
    return {
      path: artifact,
      sha256: createHash("sha256").update(readFileSync(resolved)).digest("hex"),
    };
  });
  const verified = Array.isArray(packageEvidence.distributableEvidence)
    ? packageEvidence.distributableEvidence
    : [];
  if (verified.length !== artifacts.length)
    throw new Error(
      "Package verifier artifact set is incomplete or contains extras.",
    );
  const matched = artifacts.every((artifact) => {
    const expectedType = artifact.path.endsWith(".dmg")
      ? "dmg"
      : artifact.path.endsWith(".zip")
        ? "zip"
        : "unknown";
    return verified.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as {
        artifact?: unknown;
        artifactType?: unknown;
        sha256?: unknown;
      };
      return (
        typeof value.artifact === "string" &&
        realpathSync(value.artifact) === realpathSync(artifact.path) &&
        value.artifactType === expectedType &&
        value.sha256 === artifact.sha256
      );
    });
  });
  if (!matched)
    throw new Error(
      "Acceptance artifacts do not match the package verifier evidence.",
    );
  const result = {
    schemaVersion: 1,
    status: "passed",
    evidenceBoundary: "synthetic-local-ad-hoc",
    sourceSha: input.sourceSha,
    receiptPath: input.receipt,
    artifacts,
    synthetic: {
      nativeSwiftTests: swiftCount,
      nativeSemanticCases: new Set(
        NATIVE_ASSERTION_EVIDENCE.map(({ matrix }) => matrix),
      ).size,
      nativeAssertions: NATIVE_ASSERTION_EVIDENCE,
      nativeAddonTests: addonCount,
      typescriptAssertions: TYPESCRIPT_ASSERTION_EVIDENCE,
      packageSmoke: "passed",
    },
    matrix: MATRIX_CASES,
    deferred: [
      "G1 Apple signing/notarization",
      "G2 destination/version",
      "G3 real-machine human/agent acceptance",
      "G4 publication/remote verification",
    ],
  } as const;
  writeFileSync(input.receipt, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return result;
}

function systemPort(cwd: string): CommandPort {
  return {
    run(command, args) {
      const environment = { ...process.env };
      environment.CLANG_MODULE_CACHE_PATH = path.join(
        cwd,
        "native/uninstaller/.build/recovery-module-cache",
      );
      for (const name of [
        "SDKROOT",
        "CONVO_CADDY_SIGNING_MODE",
        "CONVO_CADDY_CODESIGN_IDENTITY",
        "CONVO_CADDY_SIGNING_TEAM",
        "CONVO_CADDY_NOTARY_KEYCHAIN_PROFILE",
        "CONVO_CADDY_VERIFY_NOTARIZED",
        "APPLE_ID",
        "APPLE_APP_SPECIFIC_PASSWORD",
        "APPLE_TEAM_ID",
        "API_KEY",
        "API_KEY_ID",
        "API_ISSUER",
      ])
        delete environment[name];
      const result = spawnSync(command, args, {
        cwd,
        env: environment,
        encoding: "utf8",
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

function checked(result: CommandResult, label: string) {
  if (result.status !== 0)
    throw new Error(
      `${label} failed: ${combined(result).trim() || `exit ${result.status}`}`,
    );
  return result;
}
function combined(result: CommandResult) {
  return `${result.stdout}\n${result.stderr}`;
}
function parsePassedSwiftTests(output: string): Set<string> {
  const passed = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const quoted = line.match(
      /^✔ Test "(.+)"(?: with \d+ test cases)? passed after /,
    )?.[1];
    const parameterized = line.match(
      /^✔ Test ([^ ]+\([^)]*\)) with \d+ test cases passed after /,
    )?.[1];
    if (quoted) passed.add(quoted);
    if (parameterized) passed.add(parameterized);
  }
  return passed;
}
function valueAfter(args: string[], name: string) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function parseJsonObject(output: string): Record<string, unknown> {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start)
    throw new Error("Package verifier emitted no JSON evidence.");
  return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
}
function validateScopeFile(scopeFile: string): RealMachineScope {
  const scope = JSON.parse(readFileSync(scopeFile, "utf8")) as Record<
    string,
    unknown
  >;
  if (scope.schemaVersion !== 1 || scope.approvedBy !== "Moritz")
    throw new Error("G3 scope file is not explicitly approved by Moritz.");
  if (!Array.isArray(scope.exactPaths) || scope.exactPaths.length === 0)
    throw new Error("G3 scope must list exact paths.");
  if (
    typeof scope.sourceSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(scope.sourceSha) ||
    typeof scope.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(scope.artifactSha256)
  )
    throw new Error("G3 scope must bind full source and artifact identities.");
  for (const target of scope.exactPaths) {
    if (typeof target !== "string")
      throw new Error("G3 scope contains a non-path target.");
    const resolved = path.resolve(target);
    if (
      resolved === path.parse(resolved).root ||
      resolved === path.resolve(homedir())
    )
      throw new Error("G3 scope contains an unsafe recursive target.");
  }
  return scope as unknown as RealMachineScope;
}

function defaultSyntheticInput(): SyntheticInput {
  const sourceRoot = path.resolve(".");
  const sourceSha = checked(
    systemPort(sourceRoot).run("git", ["rev-parse", "HEAD"]),
    "source identity",
  ).stdout.trim();
  const architecture = process.arch === "arm64" ? "arm64" : process.arch;
  const packageVersion = (
    JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8")) as {
      version?: unknown;
    }
  ).version;
  if (
    typeof packageVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(packageVersion)
  )
    throw new Error("Package version must be numeric major.minor.patch.");
  const artifacts = [
    path.join(
      sourceRoot,
      `out/make/Convo Caddy-${packageVersion}-${architecture}.dmg`,
    ),
    path.join(
      sourceRoot,
      `out/make/zip/darwin/${architecture}/Convo Caddy-darwin-${architecture}-${packageVersion}.zip`,
    ),
  ];
  for (const artifact of artifacts)
    if (!existsSync(artifact))
      throw new Error(`Build the local package first; missing ${artifact}`);
  const scratch = mkdtempSync(
    path.join(tmpdir(), "convo-caddy-install-uninstall-acceptance-"),
  );
  return {
    mode: "synthetic",
    sourceRoot,
    sourceSha,
    artifacts,
    receipt: path.join(scratch, "receipt.json"),
  };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  const parsed = parseInstallUninstallArguments(process.argv.slice(2));
  if (parsed.mode === "real-machine") {
    process.stdout.write(
      `${JSON.stringify({ status: "g3-scope-reviewed-no-mutation", scopeFile: path.resolve(parsed.scopeFile), scope: parsed.scope, next: "Run the graphical human and independent-agent procedures only under the separately approved G3 session." }, null, 2)}\n`,
    );
  } else {
    const result = verifyInstallUninstall(defaultSyntheticInput());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
