import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installerLayout } from "../../scripts/lib/installer-layout.js";

describe("branded Finder installer", () => {
  it("uses a compact custom background with install primary and remove below", () => {
    const maker = installerLayout(path.resolve("."));
    expect(readFileSync("forge.config.ts", "utf8")).toContain(
      "config: installerLayout(projectRoot)",
    );
    if (!maker || typeof maker.contents !== "function")
      throw new Error("Missing DMG maker");
    expect(maker.background).toBe(
      path.resolve("dist/packaging/dmg-background.tiff"),
    );
    expect(maker.iconSize).toBe(72);
    expect(maker.additionalDMGOptions?.window?.size).toEqual({
      width: 560,
      height: 400,
    });
    const items = maker.contents({
      appPath: "/synthetic/Convo Caddy.app",
      name: "Convo Caddy",
      out: "/synthetic",
    });
    expect(
      items.filter((item: { type: string }) => item.type !== "position"),
    ).toEqual([
      { x: 150, y: 150, type: "file", path: "/synthetic/Convo Caddy.app" },
      { x: 410, y: 150, type: "link", path: "/Applications" },
      {
        x: 150,
        y: 300,
        type: "file",
        path: path.resolve("dist/packaging/Uninstall Convo Caddy.app"),
      },
    ]);
    for (const name of [".background", ".VolumeIcon.icns", ".DS_Store"])
      expect(items).toContainEqual({
        x: 640,
        y: 460,
        type: "position",
        path: name,
      });
  });
  it("binds both rendered resolutions to owned source and the licensed font", () => {
    const provenance = JSON.parse(
      readFileSync("assets/dmg-artwork.json", "utf8"),
    );
    for (const [field, file] of Object.entries({
      source: "assets/dmg-background.svg",
      font: "node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2",
      png: "assets/dmg-background.png",
      retinaPng: "assets/dmg-background@2x.png",
    }))
      expect(
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      ).toBe(provenance[field]);
    for (const [file, scale] of [
      ["assets/dmg-background.png", 1],
      ["assets/dmg-background@2x.png", 2],
    ] as const) {
      const png = readFileSync(file);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        560 * scale,
        400 * scale,
      ]);
    }
  });
  it("registers a distinct icon and copies it before either signing mode", () => {
    const plist = readFileSync("native/uninstaller/Info.plist", "utf8");
    expect(plist).toContain(
      "<key>CFBundleIconFile</key><string>UninstallConvoCaddy.icns</string>",
    );
    const build = readFileSync("scripts/build-uninstaller.ts", "utf8");
    expect(build.indexOf('"UninstallConvoCaddy.icns"')).toBeGreaterThan(0);
    expect(build.indexOf('"UninstallConvoCaddy.icns"')).toBeLessThan(
      build.indexOf('"/usr/bin/codesign"'),
    );
    const icons = readFileSync("scripts/build-app-icon.ts", "utf8");
    expect(icons).not.toContain("rmSync(outputDirectory");
    expect(readFileSync("assets/uninstaller-icon.svg", "utf8")).not.toBe(
      readFileSync("assets/app-icon.svg", "utf8"),
    );
  });
});
