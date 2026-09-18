import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const sourceScript = path.resolve("scripts/prepare-release-mac.sh");

describe("fresh-export release bootstrap", () => {
  it("runs frozen installation before loading repository-local release tooling", () => {
    const fixture = createFixture();
    const result = run(fixture);
    expect(result.status).toBe(0);
    expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toEqual([
      "install --frozen-lockfile --force",
      "exec tsx scripts/prepare-release-mac.ts --version 0.1.0 --clean-export-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --manifest manifest.json",
    ]);
  });

  it("stops on locked-install failure before loading signing/notary tooling", () => {
    const fixture = createFixture(true);
    const result = run(fixture);
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.log, "utf8")).not.toContain("exec tsx");
    expect(result.stderr).toMatch(/locked dependency installation failed/i);
  });
});

function createFixture(fail = false) {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), "caddy release bootstrap ")),
    "export with spaces",
  );
  const scripts = path.join(root, "scripts"),
    bin = path.join(root, "bin"),
    log = path.join(root, "calls.log");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(root, "package.json"), "{}\n");
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(
    path.join(scripts, "prepare-release-mac.sh"),
    readFileSync(sourceScript),
  );
  chmodSync(path.join(scripts, "prepare-release-mac.sh"), 0o755);
  writeFileSync(
    path.join(bin, "pnpm"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1" = install ] && [ "${fail}" = true ]; then exit 7; fi\n`,
  );
  chmodSync(path.join(bin, "pnpm"), 0o755);
  return { root, bin, log };
}

function run(fixture: ReturnType<typeof createFixture>) {
  return spawnSync(
    "/bin/bash",
    [
      path.join(fixture.root, "scripts/prepare-release-mac.sh"),
      "--version",
      "0.1.0",
      "--clean-export-sha",
      "a".repeat(40),
      "--manifest",
      "manifest.json",
    ],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${fixture.bin}:/usr/bin:/bin` },
    },
  );
}
