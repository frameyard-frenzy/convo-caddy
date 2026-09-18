import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as verifier from "../../scripts/verify-public-tree.js";
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "caddy-public-verifier-"));
  roots.push(root);
  for (const file of [
    "scripts/verify-install-uninstall-mac.ts",
    "tests/package/install-uninstall-contract.test.ts",
    "docs/install-uninstall-verification.md",
    ".collab/README.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".editorconfig",
    "playwright.setup.config.ts",
    "playwright.clarity.config.ts",
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "synthetic contract\n");
  }
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { check: "vitest" } }),
  );
  writeFileSync(
    path.join(root, "README.md"),
    "[Collaboration](.collab/README.md)\n`pnpm check`\n",
  );
  git(root, ["init", "-q"]);
  commit(root);
  return root;
}
function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function commit(root: string) {
  git(root, ["add", "-A"]);
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
describe("public source verification", () => {
  it("bounds Git process startup independently of tracked file count", () => {
    const root = fixture();
    mkdirSync(path.join(root, "fixtures"));
    for (let index = 0; index < 32; index++)
      writeFileSync(
        path.join(root, `fixtures/file-${index}.txt`),
        `synthetic ${index}\n`,
      );
    // Batch framing must preserve binary bytes, repeated blobs and unusual paths.
    writeFileSync(
      path.join(root, "fixtures/binary.dat"),
      Buffer.from([0, 10, 255, 32]),
    );
    writeFileSync(
      path.join(root, "fixtures/tab\tnewline\n.txt"),
      "synthetic 1\n",
    );
    commit(root);
    vi.mocked(execFileSync).mockClear();
    const result = verifier.verifyPublicTree(root);
    const calls = vi.mocked(execFileSync).mock.calls.length;
    expect(result.files).toBe(45);
    expect(calls).toBeLessThanOrEqual(4);
    writeFileSync(
      path.join(root, "fixtures/last-private.txt"),
      ["", "Users", "synthetic-person", "private"].join("/"),
    );
    commit(root);
    expect(() => verifier.verifyPublicTree(root)).toThrow(/personal/i);
  });

  it.each(["commit", "tree", "blob"])(
    "ignores %s replacements that hide unsafe HEAD bytes",
    (kind) => {
      const root = fixture();
      const safe = git(root, ["rev-parse", "HEAD"]);
      writeFileSync(
        path.join(root, "README.md"),
        ["", "Users", "synthetic-person", "private"].join("/"),
      );
      commit(root);
      const suffix =
        kind === "tree" ? "^{tree}" : kind === "blob" ? ":README.md" : "";
      git(root, [
        "replace",
        git(root, ["rev-parse", `HEAD${suffix}`]),
        git(root, ["rev-parse", `${safe}${suffix}`]),
      ]);
      expect(() => verifier.verifyPublicTree(root)).toThrow(
        /private|personal/i,
      );
    },
  );
  it.each(["script", "config", "chain"])(
    "rejects a missing package %s target in committed source",
    (kind) => {
      const root = fixture();
      writeFileSync(
        path.join(root, "scripts/build-desktop.ts"),
        "// synthetic",
      );
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          scripts: {
            check: "pnpm build:desktop",
            "build:desktop":
              kind === "script"
                ? "tsx scripts/build-desktop.ts"
                : kind === "config"
                  ? "vitest --config missing.config.ts"
                  : "pnpm absent-command && vite build",
          },
        }),
      );
      commit(root);
      rmSync(path.join(root, "scripts/build-desktop.ts"));
      commit(root);
      expect(() => verifier.verifyPublicTree(root)).toThrow(/Missing|Unknown/);
    },
  );
  it("allows built-in pnpm commands and external tools in package chains", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          check:
            "pnpm install && pnpm exec vitest && pnpm --filter fixture deploy --prod dist/runtime && electron dist/desktop/main.mjs && vite build",
        },
      }),
    );
    commit(root);
    expect(() => verifier.verifyPublicTree(root)).not.toThrow();
  });

  it("includes clone instructions, dotfiles, and tracked collaboration", () => {
    for (const name of [
      ".collab",
      "AGENTS.md",
      "CLAUDE.md",
      ".editorconfig",
      "playwright.setup.config.ts",
      "playwright.clarity.config.ts",
    ])
      expect(verifier.PUBLIC_TREE_ALLOWLIST).toContain(name);
  });
  it("verifies a multi-commit HEAD without modifying files or creating commits", () => {
    const root = fixture();
    writeFileSync(path.join(root, "NOTICE.md"), "Frameyard\n");
    commit(root);
    const head = git(root, ["rev-parse", "HEAD"]);
    const before = git(root, ["status", "--porcelain"]);
    expect(verifier.verifyPublicTree(root).commit).toBe(head);
    expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(git(root, ["status", "--porcelain"])).toBe(before);
  });
  it("allows generic host preparation anchors and reserved example endpoints", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "README.md"),
      "[prepare](#prepare-hermes-mac) example.ngrok-free.dev host.example.ts.net\n",
    );
    commit(root);
    expect(() => verifier.verifyPublicTree(root)).not.toThrow();
  });
  it("inspects committed HEAD even when a working file has changed", () => {
    const root = fixture();
    writeFileSync(path.join(root, "NOTICE.md"), "local draft");
    verifier.verifyPublicTree(root);
    expect(readFileSync(path.join(root, "NOTICE.md"), "utf8")).toBe(
      "local draft",
    );
  });
  it.each(["collab", "artifacts", ".marty", ".codex", ".hermes"])(
    "rejects tracked private root %s",
    (directory) => {
      const root = fixture();
      mkdirSync(path.join(root, directory));
      writeFileSync(path.join(root, directory, "private.md"), "synthetic");
      commit(root);
      expect(() => verifier.verifyPublicTree(root)).toThrow(
        /non-public|private/i,
      );
    },
  );
  it.each([
    "personal-path",
    "personal-endpoint",
    "credential",
    "missing-link",
    "missing-command",
    "missing-script",
    "missing-config",
  ])("rejects %s in tracked collaboration", (kind) => {
    const root = fixture();
    const content =
      kind === "personal-path"
        ? ["", "Users", "synthetic-person", "private"].join("/")
        : kind === "personal-endpoint"
          ? ["unique-fixture", "ngrok-free.dev"].join(".")
          : kind === "credential"
            ? ["gh", "p_", "x".repeat(35)].join("")
            : kind === "missing-link"
              ? "[Missing](absent.md)"
              : kind === "missing-command"
                ? "`pnpm absent-command`"
                : kind === "missing-script"
                  ? "`bash scripts/absent.sh`"
                  : "`pnpm exec playwright test --config missing.config.ts`";
    writeFileSync(path.join(root, ".collab/README.md"), content);
    commit(root);
    expect(() => verifier.verifyPublicTree(root)).toThrow();
  });
});
