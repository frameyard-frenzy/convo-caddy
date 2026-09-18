import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/build-from-source.sh");

describe("one-command macOS source build", () => {
  it("locates a checkout containing spaces from another cwd and runs only install and make", () => {
    const fixture = fixtureCheckout();
    const result = runFixture(fixture, {
      FIXTURE_PLATFORM: "Darwin",
      FIXTURE_ARCH: "arm64",
      FIXTURE_FREE_KB: "9000000",
      FIXTURE_MACOS: "14.7",
    });
    expect(result.status).toBe(0);
    expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toEqual([
      "pnpm --version",
      "pnpm install --frozen-lockfile",
      "pnpm make:mac",
    ]);
    expect(result.stdout).toContain(path.join(fixture.root, "out/make"));
    expect(result.stdout).toMatch(/built, not installed/i);
  });

  it.each([
    ["Linux", "arm64", "9000000", /requires macOS/i],
    ["Darwin", "x86_64", "9000000", /Apple Silicon.*arm64/i],
    ["Darwin", "arm64", "100", /free disk space/i],
  ])(
    "fails precisely for platform=%s arch=%s space=%s",
    (platform, arch, free, message) => {
      const fixture = fixtureCheckout();
      const result = runFixture(fixture, {
        FIXTURE_PLATFORM: platform,
        FIXTURE_ARCH: arch,
        FIXTURE_FREE_KB: free,
        FIXTURE_MACOS: "14.7",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(message);
    },
  );

  it("rejects a macOS version below the native bundle minimum", () => {
    const fixture = fixtureCheckout();
    const result = runFixture(fixture, {
      FIXTURE_PLATFORM: "Darwin",
      FIXTURE_ARCH: "arm64",
      FIXTURE_FREE_KB: "9000000",
      FIXTURE_MACOS: "13.6",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/requires macOS 14 or later/i);
  });

  it.each(["Apple Swift version 5.10", "unknown compiler"])(
    "rejects unsupported Swift output %s before installing",
    (version) => {
      const fixture = fixtureCheckout();
      command(fixture.bin, "swift", `printf '%s\\n' '${version}'`);
      const result = runFixture(fixture, {
        FIXTURE_PLATFORM: "Darwin",
        FIXTURE_ARCH: "arm64",
        FIXTURE_FREE_KB: "9000000",
        FIXTURE_MACOS: "14.7",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Swift 6 or later/);
      expect(readFileSync(fixture.log, "utf8")).not.toContain("pnpm install");
    },
  );

  it("propagates locked-install failure and never starts packaging", () => {
    const fixture = fixtureCheckout("install");
    const result = runFixture(fixture, {
      FIXTURE_PLATFORM: "Darwin",
      FIXTURE_ARCH: "arm64",
      FIXTURE_FREE_KB: "9000000",
      FIXTURE_MACOS: "14.7",
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.log, "utf8")).not.toContain("make:mac");
    expect(result.stderr).toMatch(/dependency installation failed/i);
  });

  it("propagates package construction failure without claiming a build or install", () => {
    const fixture = fixtureCheckout("make");
    const result = runFixture(fixture, {
      FIXTURE_PLATFORM: "Darwin",
      FIXTURE_ARCH: "arm64",
      FIXTURE_FREE_KB: "9000000",
      FIXTURE_MACOS: "14.7",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/package construction failed/i);
    expect(result.stdout).not.toMatch(/Build complete|installed/i);
  });
});

function fixtureCheckout(fail?: string) {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), "caddy source build ")),
    "checkout with spaces",
  );
  const bin = path.join(root, "test-bin");
  const scripts = path.join(root, "scripts");
  const log = path.join(root, "commands.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@11.19.0",
      engines: { node: ">=24 <25" },
    }),
  );
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(
    path.join(scripts, "build-from-source.sh"),
    readFileSync(script),
  );
  chmodSync(path.join(scripts, "build-from-source.sh"), 0o755);
  command(bin, "node", 'if [ "$1" = --version ]; then echo v24.15.0; fi');
  command(
    bin,
    "pnpm",
    `echo "pnpm $*" >> "${log}"; if [ "$1" = --version ]; then echo 11.19.0; exit 0; fi; if [ "$1" = install ] && [ "${fail ?? ""}" = install ]; then exit 9; fi; if [ "$1" = make:mac ] && [ "${fail ?? ""}" = make ]; then exit 8; fi`,
  );
  command(bin, "sw_vers", 'echo "$FIXTURE_MACOS"');
  command(bin, "xcode-select", "echo /Library/Developer/CommandLineTools");
  command(bin, "swift", "echo 'Swift version 6.2.4'");
  command(bin, "git", "echo 'git version 2.50.0'");
  command(
    bin,
    "uname",
    'if [ "$1" = -s ]; then echo "$FIXTURE_PLATFORM"; else echo "$FIXTURE_ARCH"; fi',
  );
  command(
    bin,
    "df",
    'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 10000000 1 %s 1%% /\\n" "$FIXTURE_FREE_KB"',
  );
  return { root, bin, log };
}

function command(bin: string, name: string, body: string) {
  const target = path.join(bin, name);
  writeFileSync(target, `#!/bin/sh\n${body}\n`);
  chmodSync(target, 0o755);
}

function runFixture(
  fixture: ReturnType<typeof fixtureCheckout>,
  extra: Record<string, string>,
) {
  return spawnSync(
    "/bin/bash",
    [path.join(fixture.root, "scripts/build-from-source.sh")],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.bin}:/usr/bin:/bin`,
        ...extra,
      },
    },
  );
}
