import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as release from "../../scripts/prepare-release-mac.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "caddy-release-source-"));
  roots.push(root);
  for (const relative of [
    "scripts/verify-install-uninstall-mac.ts",
    "tests/package/install-uninstall-contract.test.ts",
    "docs/install-uninstall-verification.md",
  ]) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), "synthetic public contract\n");
  }
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "0.2.0" }),
  );
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(root, ["init", "--quiet"]);
  commit(root);
  return root;
}
function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function commit(root: string) {
  git(root, ["add", "--all"]);
  git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
}

describe("release source preflight", () => {
  it("rejects replacement ancestry that admits an unrelated HEAD", () => {
    const root = fixture();
    const approved = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "--orphan", "unrelated"]);
    writeFileSync(path.join(root, "NOTICE.md"), "unrelated source");
    commit(root);
    const head = git(root, ["rev-parse", "HEAD"]);
    const substitute = git(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      approved,
      "-m",
      "synthetic ancestry",
    ]);
    git(root, ["replace", head, substitute]);
    expect(() =>
      git(root, ["merge-base", "--is-ancestor", approved, "HEAD"]),
    ).not.toThrow();
    expect(() =>
      release.assertReleaseSource(root, "0.2.0", head, approved),
    ).toThrow(/descend/);
  });
  it("rejects replacement blobs that hide actual committed bytes", () => {
    const root = fixture();
    writeFileSync(path.join(root, "README.md"), "safe");
    commit(root);
    const safeBlob = git(root, ["rev-parse", "HEAD:README.md"]);
    const approved = git(root, ["rev-list", "--max-parents=0", "HEAD"]);
    writeFileSync(
      path.join(root, "README.md"),
      ["", "Users", "synthetic-person", "private"].join("/"),
    );
    commit(root);
    const head = git(root, ["rev-parse", "HEAD"]);
    git(root, [
      "replace",
      git(root, ["rev-parse", "HEAD:README.md"]),
      safeBlob,
    ]);
    git(root, ["update-index", "--assume-unchanged", "README.md"]);
    writeFileSync(path.join(root, "README.md"), "safe");
    expect(git(root, ["status", "--porcelain"])).toBe("");
    expect(() =>
      release.assertReleaseSource(root, "0.2.0", head, approved),
    ).toThrow(/bytes differ|private|personal/i);
  });

  it.each(["file", "symlink"])(
    "rejects ignored public %s input omitted from provenance",
    (kind) => {
      const root = fixture();
      mkdirSync(path.join(root, "public"));
      writeFileSync(path.join(root, ".git/info/exclude"), "*.log\n");
      const file = path.join(root, "public/interview.log");
      if (kind === "file") writeFileSync(file, "synthetic confidential prose");
      else symlinkSync("../package.json", file);
      expect(git(root, ["status", "--porcelain"])).toBe("");
      expect(() =>
        release.assertReleaseSource(
          root,
          "0.2.0",
          git(root, ["rev-parse", "HEAD"]),
          git(root, ["rev-list", "--max-parents=0", "HEAD"]),
        ),
      ).toThrow(/ignored|untracked/i);
    },
  );
  it("accepts approved root source with approved package version", () => {
    const root = fixture();
    expect(() =>
      release.assertReleaseSource(
        root,
        "0.2.0",
        git(root, ["rev-parse", "HEAD"]),
        git(root, ["rev-list", "--max-parents=0", "HEAD"]),
      ),
    ).not.toThrow();
  });
  it("accepts descendants of the explicitly approved root", () => {
    const root = fixture();
    const approvedRoot = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "NOTICE.md"), "Frameyard\n");
    commit(root);
    expect(() =>
      release.assertReleaseSource(
        root,
        "0.2.0",
        git(root, ["rev-parse", "HEAD"]),
        approvedRoot,
      ),
    ).not.toThrow();
  });
  it.each(["missing", "unrelated", "non-root", "wrong-head"])(
    "rejects %s binding",
    (kind) => {
      const root = fixture();
      const approvedRoot = git(root, ["rev-parse", "HEAD"]);
      writeFileSync(path.join(root, "NOTICE.md"), "Frameyard\n");
      commit(root);
      const head = git(root, ["rev-parse", "HEAD"]);
      const binding =
        kind === "missing"
          ? ""
          : kind === "unrelated"
            ? "b".repeat(40)
            : kind === "non-root"
              ? head
              : approvedRoot;
      expect(() =>
        release.assertReleaseSource(
          root,
          "0.2.0",
          kind === "wrong-head" ? approvedRoot : head,
          binding,
        ),
      ).toThrow();
    },
  );
  it("rejects a real unrelated root commit", () => {
    const root = fixture();
    const head = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "--orphan", "unrelated"]);
    writeFileSync(path.join(root, "NOTICE.md"), "unrelated root\n");
    commit(root);
    const other = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "--detach", head]);
    expect(() =>
      release.assertReleaseSource(root, "0.2.0", head, other),
    ).toThrow(/descend/);
  });
  it("rejects tracked symlinks and hidden dirty bytes", () => {
    const root = fixture();
    const approved = git(root, ["rev-parse", "HEAD"]);
    symlinkSync("package.json", path.join(root, "README.md"));
    commit(root);
    expect(() =>
      release.assertReleaseSource(
        root,
        "0.2.0",
        git(root, ["rev-parse", "HEAD"]),
        approved,
      ),
    ).toThrow(/non-regular/);
    rmSync(path.join(root, "README.md"));
    writeFileSync(path.join(root, "README.md"), "safe\n");
    commit(root);
    git(root, ["update-index", "--assume-unchanged", "README.md"]);
    writeFileSync(path.join(root, "README.md"), "hidden changed bytes\n");
    expect(git(root, ["status", "--porcelain"])).toBe("");
    expect(() =>
      release.assertReleaseSource(
        root,
        "0.2.0",
        git(root, ["rev-parse", "HEAD"]),
        approved,
      ),
    ).toThrow(/bytes differ/);
  });
  it("allows only known generated ignored roots", () => {
    const root = fixture();
    const head = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, ".git/info/exclude"), "dist/\n");
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist/generated.js"), "synthetic");
    expect(() =>
      release.assertReleaseSource(root, "0.2.0", head, head),
    ).not.toThrow();
  });
  it("requires a new external manifest with an existing parent", () => {
    const root = fixture();
    expect(() =>
      release.assertManifestDestination(root, path.join(root, "manifest.json")),
    ).toThrow(/outside/);
    expect(() =>
      release.assertManifestDestination(
        root,
        path.join(root, "missing/manifest.json"),
      ),
    ).toThrow();
    const external = mkdtempSync(path.join(tmpdir(), "caddy-manifest-"));
    roots.push(external);
    const file = path.join(external, "manifest.json");
    expect(() => release.assertManifestDestination(root, file)).not.toThrow();
    writeFileSync(file, "existing");
    expect(() => release.assertManifestDestination(root, file)).toThrow();
    symlinkSync(root, path.join(external, "alias"));
    expect(() =>
      release.assertManifestDestination(
        root,
        path.join(external, "alias/manifest.json"),
      ),
    ).toThrow(/outside/);
  });
  it.each([
    "private-root",
    "private-text",
    "secret",
    "extra-root",
    "version",
    "modified",
    "shallow",
  ])("rejects %s before release operations", (kind) => {
    const root = fixture();
    if (kind === "private-root") {
      mkdirSync(path.join(root, "collab"));
      writeFileSync(path.join(root, "collab/private.md"), "private");
    }
    if (kind === "private-text")
      writeFileSync(
        path.join(root, "README.md"),
        ["", "Users", "fixture", "source"].join("/"),
      );
    if (kind === "secret")
      writeFileSync(
        path.join(root, "README.md"),
        ["gh", "p_", "x".repeat(35)].join(""),
      );
    if (kind === "extra-root")
      writeFileSync(path.join(root, "private-notes.md"), "not public");
    if (
      ["private-root", "private-text", "secret", "extra-root"].includes(kind)
    ) {
      git(root, ["add", "--all"]);
      git(root, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--amend",
        "--no-edit",
        "-q",
      ]);
    }
    if (kind === "modified")
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ version: "0.3.0" }),
      );
    if (kind === "shallow")
      writeFileSync(
        path.join(root, ".git/shallow"),
        `${git(root, ["rev-parse", "HEAD"])}\n`,
      );
    expect(() =>
      release.assertReleaseSource(
        root,
        kind === "version" ? "0.4.0" : "0.2.0",
        git(root, ["rev-parse", "HEAD"]),
        git(root, ["rev-list", "--max-parents=0", "HEAD"]),
      ),
    ).toThrow();
  });
});
