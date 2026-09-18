import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const source = path.resolve("native/lifecycle-lock");
const output = path.resolve("dist/desktop/lifecycle-lock.node");
execFileSync(
  "pnpm",
  [
    "exec",
    "node-gyp",
    "rebuild",
    "--directory",
    source,
    "--target=44.0.0",
    "--dist-url=https://electronjs.org/headers",
  ],
  { stdio: "inherit" },
);
mkdirSync(path.dirname(output), { recursive: true });
rmSync(output, { force: true });
cpSync(
  path.join(source, "build/Release/convo_caddy_lifecycle_lock.node"),
  output,
);
