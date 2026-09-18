import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync("docs/source-install-and-upgrade.md", "utf8");
const blocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map(
  (m) => m[1] ?? "",
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
describe("extracted optional source install guards", () => {
  it.each(["existing", "symlink", "clone-failure", "success"])(
    "cannot enter an older checkout after %s",
    (scenario) => {
      const root = mkdtempSync(path.join(tmpdir(), "caddy-recipe-clone-"));
      try {
        const bin = path.join(root, "bin");
        mkdirSync(bin);
        const destination = path.join(root, "convo-caddy");
        if (scenario === "existing") mkdirSync(destination);
        if (scenario === "symlink")
          symlinkSync(path.join(root, "missing"), destination);
        const git = path.join(bin, "git");
        writeFileSync(
          git,
          `#!/bin/bash\nprintf 'git-called\\n'\n${scenario === "clone-failure" ? "exit 1" : '/bin/mkdir "convo-caddy"'}\n`,
          { mode: 0o755 },
        );
        const original = blocks.find((b) => b.includes("git clone"));
        expect(original).toBeDefined();
        if (!original) throw new Error("Documented command missing");
        const command = original
          .replace('"$HOME/Downloads"', quote(root))
          .replace("YOUR-BRANCH", "synthetic");
        const result = spawnSync("/bin/bash", ["-c", command], {
          encoding: "utf8",
          env: { PATH: bin },
        });
        expect(result.status).toBe(scenario === "success" ? 0 : 1);
        expect(result.stdout.includes("Source ready")).toBe(
          scenario === "success",
        );
        expect(result.stdout.includes("git-called")).toBe(
          scenario === "clone-failure" || scenario === "success",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each(["match", "old-bytes", "missing-file", "missing-app"])(
    "checks candidate file identity: %s",
    (scenario) => {
      const root = mkdtempSync(path.join(tmpdir(), "caddy-recipe-identity-"));
      try {
        const built = path.join(root, "built.app");
        const installed = path.join(root, "installed.app");
        mkdirSync(built);
        writeFileSync(path.join(built, "payload"), "synthetic-fresh");
        if (scenario !== "missing-app") mkdirSync(installed);
        if (["match", "old-bytes"].includes(scenario))
          writeFileSync(
            path.join(installed, "payload"),
            scenario === "match" ? "synthetic-fresh" : "synthetic-old",
          );
        const original = blocks.find((b) => b.includes("diff -qr"));
        expect(original).toBeDefined();
        if (!original) throw new Error("Documented command missing");
        const command = original
          .replace(
            '"out/Convo Caddy-darwin-arm64/Convo Caddy.app"',
            quote(built),
          )
          .replace('"/Applications/Convo Caddy.app"', quote(installed));
        const result = spawnSync("/bin/bash", ["-c", command], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        });
        expect(result.status === 0).toBe(scenario === "match");
        expect(
          result.stdout.includes("Installed app matches this fresh build."),
        ).toBe(scenario === "match");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
