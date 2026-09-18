import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/verify-hermes-profile-context.py");
describe("Hermes proof preflight", () => {
  it("refuses a direct child invocation before importing Hermes", () => {
    const result = spawnSync("python3", [script, "--child"], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing uncontained proof child");
  });

  it("refuses a live-layout checkout even when HOME points at a profile home", () => {
    const root = mkdtempSync(join(tmpdir(), "caddy-proof-home-"));
    try {
      const source = join(root, ".hermes", "hermes-agent");
      mkdirSync(source, { recursive: true });
      const result = spawnSync(
        "python3",
        [script, "--source-root", source, "--expected-commit", "synthetic"],
        {
          env: { PATH: process.env.PATH, HOME: join(root, "profile-home") },
          encoding: "utf8",
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing the live Hermes checkout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [".env", "Refusing source-local environment file"],
    [
      "overlay.py",
      "Refusing untracked source configuration or executable overlays",
    ],
  ])(
    "refuses ignored source overlay %s before checking the interpreter",
    (filename, error) => {
      const root = mkdtempSync(join(tmpdir(), "caddy-proof-source-"));
      try {
        const git = (...args: string[]) =>
          execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
        git("init", "--quiet");
        writeFileSync(join(root, ".gitignore"), `${filename}\n`);
        git("add", ".gitignore");
        git(
          "-c",
          "user.name=Synthetic",
          "-c",
          "user.email=synthetic@example.test",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        );
        writeFileSync(join(root, filename), "SYNTHETIC_SECRET=not-real\n");
        const result = spawnSync(
          "python3",
          [
            script,
            "--source-root",
            root,
            "--expected-commit",
            git("rev-parse", "HEAD").trim(),
          ],
          { encoding: "utf8" },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(error);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
