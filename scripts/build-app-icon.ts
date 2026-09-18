import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error("The macOS app icon can only be built on macOS.");
}

const outputDirectory = path.resolve("dist/packaging");
mkdirSync(outputDirectory, { recursive: true });
for (const [source, name] of [
  ["app-icon.svg", "ConvoCaddy"],
  ["uninstaller-icon.svg", "UninstallConvoCaddy"],
]) {
  const iconset = path.join(outputDirectory, `${name}.iconset`);
  const sourceSvg = path.resolve("assets", source);
  const basePng = path.join(outputDirectory, `${name}-1024.png`);
  const outputIcon = path.join(outputDirectory, `${name}.icns`);

  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  run("/usr/bin/sips", ["-s", "format", "png", sourceSvg, "--out", basePng]);

  for (const [name, pixels] of [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
  ] as const) {
    const destination = path.join(iconset, name);
    copyFileSync(basePng, destination);
    run("/usr/bin/sips", [
      "-z",
      String(pixels),
      String(pixels),
      destination,
      "--out",
      destination,
    ]);
  }
  copyFileSync(basePng, path.join(iconset, "icon_512x512@2x.png"));
  run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", outputIcon]);
  rmSync(iconset, { recursive: true, force: true });
  rmSync(basePng, { force: true });

  console.log(`Built ${outputIcon}`);
}
// Multi-resolution TIFF preserves 560 × 400 logical points on Retina displays.
run("/usr/bin/tiffutil", [
  "-cathidpicheck",
  "assets/dmg-background.png",
  "assets/dmg-background@2x.png",
  "-out",
  path.join(outputDirectory, "dmg-background.tiff"),
]);

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "ignore" });
}
