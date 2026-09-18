import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("macOS source and binary support contract", () => {
  it("checks bundle versions and every Mach-O floor in both artifact paths", () => {
    const source = readFileSync(
      path.resolve("scripts/verify-package-mac.ts"),
      "utf8",
    );
    for (const name of ["assertBundleMetadata", "verifyContainedUninstaller"]) {
      const body =
        source
          .slice(source.indexOf(`function ${name}(`))
          .split(/\nfunction /)[0] ?? "";
      expect(body).toContain(
        "assertBundleVersion(bundle, packagedVersion(), run)",
      );
      expect(body).toContain('assertMachOMinimum(bundle, "14.0", run)');
    }
  });
  it("verifies final distributable contents before creating public manifest", () => {
    const source = readFileSync(
      path.resolve("scripts/prepare-release-mac.ts"),
      "utf8",
    );
    expect(source).toContain('run("pnpm", ["verify:package:mac"])');
    expect(
      source.indexOf('run("pnpm", ["verify:package:mac"])'),
    ).toBeGreaterThan(
      source.indexOf("const release = prepareReleaseCandidate"),
    );
    expect(source.indexOf('run("pnpm", ["verify:package:mac"])')).toBeLessThan(
      source.indexOf("const manifest = createPublicReleaseManifest"),
    );
  });
  it("places the codesign operation before hardened-runtime options", () => {
    const source = readFileSync(
      path.resolve("scripts/build-uninstaller.ts"),
      "utf8",
    );
    const releaseArgs = source.slice(
      source.indexOf('signing.mode === "release-signed"'),
    );
    expect(releaseArgs.indexOf('"--sign"')).toBeLessThan(
      releaseArgs.indexOf('"--options"'),
    );
  });

  it("pins the source toolchain and macOS 14 bundle floor consistently", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve("package.json"), "utf8"),
    );
    const plist = readFileSync(
      path.resolve("native/uninstaller/Info.plist"),
      "utf8",
    );
    const forge = readFileSync(path.resolve("forge.config.ts"), "utf8");
    const sourceGuide = readFileSync(
      path.resolve("docs/build-from-source.md"),
      "utf8",
    );
    expect(packageJson.packageManager).toBe("pnpm@11.19.0");
    expect(packageJson.engines.node).toBe(">=24 <25");
    expect(plist).toMatch(/LSMinimumSystemVersion<\/key><string>14\.0/);
    expect(forge).toContain('LSMinimumSystemVersion: "14.0"');
    expect(sourceGuide).toContain("macOS 14 or later");
    expect(sourceGuide).toContain("Node 24");
    expect(sourceGuide).toContain("pnpm 11.19.0");
  });

  it("routes public release preparation through frozen fresh-export bootstrap", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve("package.json"), "utf8"),
    );
    const bootstrap = readFileSync(
      path.resolve("scripts/prepare-release-mac.sh"),
      "utf8",
    );
    expect(packageJson.scripts["prepare:release:mac"]).toBe(
      "bash scripts/prepare-release-mac.sh",
    );
    expect(bootstrap).toContain("pnpm install --frozen-lockfile --force");
    expect(bootstrap.indexOf("pnpm install")).toBeLessThan(
      bootstrap.indexOf("pnpm exec tsx"),
    );
  });
});
