import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as metadata from "../../scripts/lib/release-bundle-metadata.js";

const plist =
  "<plist><dict><key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>";
describe("bundle release metadata", () => {
  it("generates both uninstaller versions from the approved package version", () => {
    const result = metadata.versionUninstallerPlist(plist, "0.2.0");
    expect(result).toContain(
      "<key>CFBundleShortVersionString</key><string>0.2.0</string>",
    );
    expect(result).toContain(
      "<key>CFBundleVersion</key><string>0.2.0</string>",
    );
    expect(() => metadata.versionUninstallerPlist(plist, "bad<xml>")).toThrow();
  });
  it("rejects wrong bundle version before release side effects", () => {
    expect(() =>
      metadata.assertBundleVersion("/fixture.app", "0.2.0", (_cmd, args) =>
        args.includes("CFBundleIdentifier")
          ? "com.frameyard.convocaddy"
          : "0.1.0",
      ),
    ).toThrow(/version/i);
  });
  it("records actual matching bundle identity and both versions", () => {
    expect(
      metadata.assertBundleVersion("/fixture.app", "0.2.0", (_cmd, args) =>
        args.includes("CFBundleIdentifier")
          ? "com.frameyard.convocaddy"
          : "0.2.0",
      ),
    ).toEqual({
      identifier: "com.frameyard.convocaddy",
      version: "0.2.0",
      buildVersion: "0.2.0",
    });
  });
  it.each([
    "cmd LC_BUILD_VERSION\nminos 15.0",
    "cmd LC_VERSION_MIN_MACOSX\nversion 15.0",
    "cmd LC_BUILD_VERSION\nminos 14.1",
    "no load command",
  ])("rejects incompatible runtime %s", (load) => {
    const root = fixtureMachO();
    expect(() =>
      metadata.assertMachOMinimum(root, "14.0", () => load),
    ).toThrow();
  });
  it("inspects all regular Mach-O files including nested native binaries", () => {
    const root = fixtureMachO();
    const calls: string[] = [];
    expect(
      metadata.assertMachOMinimum(root, "14.0", (_cmd, args) => {
        calls.push(args.at(-1) ?? "");
        return "cmd LC_BUILD_VERSION\nplatform 1\nminos 14.0\nsdk 26.0";
      }),
    ).toBe(2);
    expect(calls).toHaveLength(2);
  });
  it("disables archive-member parsing for Electron helper filenames", () => {
    const root = fixtureMachO();
    const argumentSets: string[][] = [];
    metadata.assertMachOMinimum(root, "14.0", (_cmd, args) => {
      argumentSets.push(args);
      return "cmd LC_BUILD_VERSION\nminos 14.0";
    });
    expect(argumentSets).toEqual(
      expect.arrayContaining([expect.arrayContaining(["-m", "-l"])]),
    );
  });
  it("ignores non-deployment version fields in other Mach-O load commands", () => {
    const root = fixtureMachO();
    expect(
      metadata.assertMachOMinimum(root, "14.0", () =>
        [
          "cmd LC_ID_DYLIB",
          "current version 143.0.0",
          "compatibility version 1.0.0",
          "cmd LC_SOURCE_VERSION",
          "version 99.0",
          "cmd LC_BUILD_VERSION",
          "platform 1",
          "minos 14.0",
          "sdk 26.0",
        ].join("\n"),
      ),
    ).toBe(2);
  });
});
function fixtureMachO() {
  const root = mkdtempSync(path.join(tmpdir(), "caddy-minos-"));
  mkdirSync(path.join(root, "nested"));
  for (const name of ["main", "nested/addon.node"])
    writeFileSync(
      path.join(root, name),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]),
    );
  writeFileSync(path.join(root, "README"), "not executable");
  return root;
}
