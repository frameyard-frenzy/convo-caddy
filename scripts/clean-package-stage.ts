import { rmSync } from "node:fs";
import path from "node:path";

rmSync(path.resolve("dist/package-runtime"), {
  recursive: true,
  force: true,
});
