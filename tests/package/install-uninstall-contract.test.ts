import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MATRIX_CASES,
  NATIVE_ASSERTION_EVIDENCE,
  TYPESCRIPT_ASSERTION_EVIDENCE,
  parseInstallUninstallArguments,
  verifyInstallUninstall,
} from "../../scripts/verify-install-uninstall-mac.js";

const allMatrixIds = [
  "W1",
  "W2",
  "W3",
  "W4",
  "W5",
  "W6",
  "K1",
  "K2",
  "L1",
  "L2",
  "L3",
  "R1",
  "R2",
  "P1",
  "P2",
  "P3",
  "D1",
  "S1",
];

describe("install/uninstall acceptance contract", () => {
  it("maps every required case to concrete automated or pending evidence", () => {
    expect(MATRIX_CASES.map(({ id }) => id)).toEqual(allMatrixIds);
    for (const entry of MATRIX_CASES) {
      expect(entry.contractHeading).toMatch(/^§4\./);
      expect(entry.evidence.length).toBeGreaterThan(20);
      expect(entry.status).toMatch(/^(automated|mixed|pending)$/);
    }
    expect(MATRIX_CASES.find(({ id }) => id === "P3")?.status).toBe("mixed");
    expect(MATRIX_CASES.find(({ id }) => id === "D1")?.status).toBe("pending");
    expect(MATRIX_CASES.find(({ id }) => id === "S1")?.status).toBe("mixed");
  });

  it("defaults to synthetic mode and never accepts environment consent", () => {
    expect(
      parseInstallUninstallArguments([], { CONVO_CADDY_G3_APPROVED: "1" }),
    ).toEqual({
      mode: "synthetic",
    });
    expect(() =>
      parseInstallUninstallArguments(["--mode", "real-machine"], {
        CONVO_CADDY_G3_APPROVED: "1",
      }),
    ).toThrow(/scope file.*confirmation/i);
  });

  it("real-machine review requires a file-bound scope and exact fresh confirmation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-g3-contract-"));
    const scope = path.join(root, "scope.json");
    writeFileSync(
      scope,
      JSON.stringify({
        schemaVersion: 1,
        approvedBy: "Moritz",
        sourceSha: "a".repeat(40),
        artifactSha256: "b".repeat(64),
        exactPaths: [path.join(root, "fixture-home")],
      }),
    );
    expect(() =>
      parseInstallUninstallArguments([
        "--mode",
        "real-machine",
        "--g3-scope",
        scope,
        "--confirm",
        "wrong",
      ]),
    ).toThrow(/exact confirmation/i);
    expect(
      parseInstallUninstallArguments([
        "--mode",
        "real-machine",
        "--g3-scope",
        scope,
        "--confirm",
        "I APPROVE THIS EXACT G3 SCOPE",
      ]),
    ).toMatchObject({
      mode: "real-machine",
      scopeFile: scope,
      scope: {
        sourceSha: "a".repeat(40),
        artifactSha256: "b".repeat(64),
        exactPaths: [path.join(root, "fixture-home")],
      },
    });
    writeFileSync(
      scope,
      JSON.stringify({
        schemaVersion: 1,
        approvedBy: "Moritz",
        sourceSha: "a".repeat(40),
        artifactSha256: "b".repeat(64),
        exactPaths: [path.parse(root).root],
      }),
    );
    expect(() =>
      parseInstallUninstallArguments([
        "--mode",
        "real-machine",
        "--g3-scope",
        scope,
        "--confirm",
        "I APPROVE THIS EXACT G3 SCOPE",
      ]),
    ).toThrow(/unsafe recursive target/i);
  });

  it.each([2, 3, 4])(
    "runs real native/package seams and binds the receipt with %i native suites",
    (suites) => {
      const root = mkdtempSync(path.join(tmpdir(), "caddy-u3-acceptance-"));
      const dmg = path.join(root, "candidate.dmg");
      const zip = path.join(root, "candidate.zip");
      const receipt = path.join(root, "receipt.json");
      writeFileSync(dmg, "synthetic dmg bytes");
      writeFileSync(zip, "synthetic zip bytes");
      const commands: string[] = [];
      const sourceSha = "c".repeat(40);
      const result = verifyInstallUninstall(
        {
          mode: "synthetic",
          sourceRoot: root,
          sourceSha,
          artifacts: [dmg, zip],
          receipt,
        },
        {
          run(command, args) {
            commands.push([command, ...args].join(" "));
            if (command === "git")
              return {
                status: 0,
                stdout: args[0] === "rev-parse" ? `${sourceSha}\n` : "",
                stderr: "",
              };
            if (command === "swift")
              return {
                status: 0,
                stdout: nativeOutput().replace(
                  "in 2 suites",
                  `in ${suites} suites`,
                ),
                stderr: "",
              };
            if (command === "python3")
              return {
                status: 0,
                stdout: "Ran 3 tests\nOK",
                stderr:
                  "test_alias_ancestor_rejected (__main__.NativeLockTests.test_alias_ancestor_rejected) ... ok\ntest_contention_helper_exit_and_main_crash (__main__.NativeLockTests.test_contention_helper_exit_and_main_crash) ... ok\ntest_public_marker_rejected (__main__.NativeLockTests.test_public_marker_rejected) ... ok",
              };
            if (command === "pnpm" && args[0] === "vitest")
              return { status: 0, stdout: typescriptOutput(), stderr: "" };
            return {
              status: 0,
              stdout: JSON.stringify({
                status: "ok",
                signing: "local-ad-hoc",
                smoke: { cleanup: "complete" },
                sourceProvenance: {
                  schemaVersion: 1,
                  sourceSha,
                  sourceClean: true,
                },
                distributableEvidence: [dmg, zip].map((artifact) => ({
                  artifact,
                  artifactType: artifact.endsWith(".dmg") ? "dmg" : "zip",
                  sha256: createHash("sha256")
                    .update(readFileSync(artifact))
                    .digest("hex"),
                })),
              }),
              stderr: "",
            };
          },
        },
      );
      expect(commands).toEqual([
        "git rev-parse HEAD",
        "git status --porcelain=v1 --untracked-files=all",
        expect.stringMatching(
          /^swift test --package-path .*native\/uninstaller/,
        ),
        "python3 native/lifecycle-lock/test_lock.py -v",
        expect.stringMatching(/^pnpm vitest run .*--reporter=json$/),
        "pnpm verify:package:mac",
      ]);
      expect(result.sourceSha).toBe(sourceSha);
      expect(result.artifacts).toEqual([
        { path: dmg, sha256: sha256("synthetic dmg bytes") },
        { path: zip, sha256: sha256("synthetic zip bytes") },
      ]);
      expect(result.synthetic.nativeSwiftTests).toBe(55);
      expect(result.synthetic.nativeSemanticCases).toBe(15);
      expect(result.synthetic.nativeAddonTests).toBe(3);
      expect(result.synthetic.packageSmoke).toBe("passed");
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(result);
    },
  );

  it("writes no success receipt when a production seam fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-u3-failure-"));
    const artifact = path.join(root, "candidate.dmg");
    const receipt = path.join(root, "receipt.json");
    writeFileSync(artifact, "bytes");
    expect(() =>
      verifyInstallUninstall(
        {
          mode: "synthetic",
          sourceRoot: root,
          sourceSha: "d".repeat(40),
          artifacts: [artifact],
          receipt,
        },
        mockPort("d".repeat(40), { swiftFailure: true }),
      ),
    ).toThrow(/native failure/);
    expect(() => readFileSync(receipt)).toThrow();
  });

  it("rejects a count-only native claim without semantic case execution", () => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-u3-count-only-"));
    const artifact = path.join(root, "candidate.dmg");
    writeFileSync(artifact, "bytes");
    expect(() =>
      verifyInstallUninstall(
        {
          mode: "synthetic",
          sourceRoot: root,
          sourceSha: "e".repeat(40),
          artifacts: [artifact],
          receipt: path.join(root, "receipt.json"),
        },
        mockPort("e".repeat(40), {
          swiftOutput:
            "✔ Test run with 55 tests in 2 suites passed after 0.1 seconds.",
        }),
      ),
    ).toThrow(/assertion identities/i);
  });

  it("rejects artifacts not bound by package-verifier evidence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-u3-artifact-bind-"));
    const artifact = path.join(root, "candidate.dmg");
    writeFileSync(artifact, "actual bytes");
    expect(() =>
      verifyInstallUninstall(
        {
          mode: "synthetic",
          sourceRoot: root,
          sourceSha: "f".repeat(40),
          artifacts: [artifact],
          receipt: path.join(root, "receipt.json"),
        },
        mockPort("f".repeat(40), {
          artifacts: [
            { artifact, artifactType: "dmg", sha256: "0".repeat(64) },
          ],
        }),
      ),
    ).toThrow(/do not match/i);
  });

  it.each([
    ["mismatched HEAD", { head: "0".repeat(40) }, /does not match/i],
    ["dirty source", { dirty: true }, /clean source/i],
    [
      "stale package provenance",
      { provenanceSha: "0".repeat(40) },
      /provenance/i,
    ],
  ])("rejects %s", (_name, options, message) => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-u3-provenance-"));
    const artifact = path.join(root, "candidate.dmg");
    writeFileSync(artifact, "bytes");
    expect(() =>
      verifyInstallUninstall(
        {
          mode: "synthetic",
          sourceRoot: root,
          sourceSha: "a".repeat(40),
          artifacts: [artifact],
          receipt: path.join(root, "receipt.json"),
        },
        mockPort("a".repeat(40), {
          ...options,
          artifacts: [artifactEvidence(artifact)],
        }),
      ),
    ).toThrow(message);
  });

  it("rejects swapped paths, wrong types, extras, and incomplete artifact sets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-u3-artifact-set-"));
    const dmg = path.join(root, "candidate.dmg"),
      zip = path.join(root, "candidate.zip");
    writeFileSync(dmg, "dmg");
    writeFileSync(zip, "zip");
    for (const artifacts of [
      [{ ...artifactEvidence(dmg), artifact: zip }],
      [{ ...artifactEvidence(dmg), artifactType: "zip" }],
      [artifactEvidence(dmg)],
      [artifactEvidence(dmg), artifactEvidence(zip), artifactEvidence(zip)],
    ])
      expect(() =>
        verifyInstallUninstall(
          {
            mode: "synthetic",
            sourceRoot: root,
            sourceSha: "a".repeat(40),
            artifacts: [dmg, zip],
            receipt: path.join(root, `receipt-${Math.random()}.json`),
          },
          mockPort("a".repeat(40), { artifacts }),
        ),
      ).toThrow(/artifact|match/i);
  });

  it("rejects printed test names unless Swift reports those tests passed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-u3-marker-only-"));
    const artifact = path.join(root, "candidate.dmg");
    writeFileSync(artifact, "bytes");
    const printed = NATIVE_ASSERTION_EVIDENCE.map(({ test }) => test).join(
      "\n",
    );
    expect(() =>
      verifyInstallUninstall(
        {
          mode: "synthetic",
          sourceRoot: root,
          sourceSha: "a".repeat(40),
          artifacts: [artifact],
          receipt: path.join(root, "receipt.json"),
        },
        mockPort("a".repeat(40), {
          swiftOutput: `✔ Test run with 55 tests in 2 suites passed after 0.1 seconds.\n${printed}`,
          artifacts: [artifactEvidence(artifact)],
        }),
      ),
    ).toThrow(/assertion identities/i);
  });

  it("keeps the sanitized matrix tracked and public recovery self-contained", () => {
    const publicGuide = readFileSync(
      "docs/install-uninstall-verification.md",
      "utf8",
    );
    expect(publicGuide).toContain("## Manual recovery fallback");
    expect(publicGuide).not.toContain("G3 packet");
    expect(existsSync(".collab")).toBe(true);
    const guide = readFileSync(
      path.resolve(".collab/runbooks/install-uninstall-acceptance.md"),
      "utf8",
    );
    expect(guide).toContain("[product contract](../PRODUCT_CONTEXT.md)");
    expect(guide).toContain("stable historical identifiers");
    expect(guide).not.toMatch(/section [48]|§4\./i);
    for (const id of allMatrixIds)
      expect(guide).toMatch(new RegExp(`\\| ${id} \\|`));
    for (const boundary of [
      "Real disposable Keychain remains G3",
      "quarantine and Gatekeeper",
      "human README keep-workspace pass",
      "fresh-agent",
      "remote hash checks remain G4",
      "similarly named unit test cannot satisfy",
    ])
      expect(guide).toContain(boundary);
  });
});

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function nativeOutput() {
  return [...new Set(NATIVE_ASSERTION_EVIDENCE.map(({ test }) => test))]
    .map((test) =>
      test.startsWith("No workspace") || test.startsWith("Real producer")
        ? `✔ Test "${test}" with 2 test cases passed after 0.1 seconds.`
        : test.includes("(")
          ? `✔ Test ${test} with 6 test cases passed after 0.1 seconds.`
          : `✔ Test "${test}" passed after 0.1 seconds.`,
    )
    .concat("✔ Test run with 55 tests in 2 suites passed after 0.1 seconds.")
    .join("\n");
}
function artifactEvidence(artifact: string) {
  return {
    artifact,
    artifactType: artifact.endsWith(".dmg") ? "dmg" : "zip",
    sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
  };
}
function mockPort(
  sourceSha: string,
  options: {
    head?: string;
    dirty?: boolean;
    provenanceSha?: string;
    swiftFailure?: boolean;
    swiftOutput?: string;
    artifacts?: Array<Record<string, unknown>>;
  } = {},
) {
  return {
    run(command: string, args: string[]) {
      if (command === "git")
        return {
          status: 0,
          stdout:
            args[0] === "rev-parse"
              ? `${options.head ?? sourceSha}\n`
              : options.dirty
                ? " M README.md\n"
                : "",
          stderr: "",
        };
      if (command === "swift")
        return options.swiftFailure
          ? { status: 1, stdout: "", stderr: "native failure" }
          : {
              status: 0,
              stdout: options.swiftOutput ?? nativeOutput(),
              stderr: "",
            };
      if (command === "python3")
        return {
          status: 0,
          stdout: "Ran 3 tests\nOK",
          stderr:
            "test_alias_ancestor_rejected (__main__.NativeLockTests.test_alias_ancestor_rejected) ... ok\ntest_contention_helper_exit_and_main_crash (__main__.NativeLockTests.test_contention_helper_exit_and_main_crash) ... ok\ntest_public_marker_rejected (__main__.NativeLockTests.test_public_marker_rejected) ... ok",
        };
      if (command === "pnpm" && args[0] === "vitest")
        return { status: 0, stdout: typescriptOutput(), stderr: "" };
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "ok",
          signing: "local-ad-hoc",
          smoke: { cleanup: "complete" },
          sourceProvenance: {
            schemaVersion: 1,
            sourceSha: options.provenanceSha ?? sourceSha,
            sourceClean: true,
          },
          distributableEvidence: options.artifacts ?? [],
        }),
        stderr: "",
      };
    },
  };
}
function typescriptOutput() {
  return JSON.stringify({
    testResults: [
      {
        assertionResults: TYPESCRIPT_ASSERTION_EVIDENCE.map(({ test }) => ({
          title: test,
          status: "passed",
        })),
      },
    ],
  });
}
