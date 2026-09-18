import path from "node:path";
import type { MakerDMGConfig } from "@electron-forge/maker-dmg";

export function installerLayout(projectRoot: string): MakerDMGConfig {
  return {
    format: "ULFO",
    icon: path.join(projectRoot, "dist/packaging/ConvoCaddy.icns"),
    background: path.join(projectRoot, "dist/packaging/dmg-background.tiff"),
    iconSize: 72,
    additionalDMGOptions: {
      "background-color": "#F3F5F1",
      window: {
        position: { x: 180, y: 140 },
        size: { width: 560, height: 400 },
      },
    },
    contents: (options) => [
      { x: 150, y: 150, type: "file", path: options.appPath },
      { x: 410, y: 150, type: "link", path: "/Applications" },
      {
        x: 150,
        y: 300,
        type: "file",
        path: path.join(
          projectRoot,
          "dist/packaging/Uninstall Convo Caddy.app",
        ),
      },
      // Hidden-file users retain their preference; metadata sits outside the artwork.
      ...[".background", ".VolumeIcon.icns", ".DS_Store"].map((name) => ({
        x: 640,
        y: 460,
        type: "position" as const,
        path: name,
      })),
    ],
  };
}
