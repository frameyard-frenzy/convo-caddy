import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";

const outputDirectory = path.resolve("dist/desktop");
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const sourceStatus = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { encoding: "utf8" },
).trim();
writeFileSync(
  path.join(outputDirectory, "build-provenance.json"),
  `${JSON.stringify({ schemaVersion: 1, sourceSha, sourceClean: sourceStatus === "" }, null, 2)}\n`,
);

await build({
  entryPoints: [path.resolve("src/desktop/main.ts")],
  outfile: path.join(outputDirectory, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  external: ["electron"],
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
});

cpSync(
  path.resolve("src/server/capture/recall/recording-notice.jpg"),
  path.join(outputDirectory, "recording-notice.jpg"),
);
cpSync(
  path.resolve(
    "node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2",
  ),
  path.join(outputDirectory, "instrument-sans.woff2"),
);

execFileSync("pnpm", ["tsx", "scripts/build-maintenance-lock.ts"], {
  stdio: "inherit",
});

cpSync(
  path.resolve("docs/hermes-connection-setup.md"),
  path.join(outputDirectory, "hermes-connection-setup.md"),
);
