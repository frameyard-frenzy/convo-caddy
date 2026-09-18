import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const files = [
  "docs/source-install-and-upgrade.md",
  "docs/hermes-connection-setup.md",
  "docs/hermes-owner-handoff.md",
  "docs/build-from-source.md",
];
describe("actual recipe commands", () => {
  it.each(files)(
    "parses shell blocks without executing any command: %s",
    (file) => {
      const blocks = [
        ...readFileSync(file, "utf8").matchAll(
          /```(?:bash|command)\n([\s\S]*?)```/g,
        ),
      ];
      expect(blocks.length).toBeGreaterThan(0);
      for (const [, command] of blocks) {
        const result = spawnSync("/bin/bash", ["-n"], {
          input: command,
          encoding: "utf8",
          env: {},
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    },
  );
  it("uses one canonical helper for acquisition instead of parsing process command lines", () => {
    const source = readFileSync("docs/hermes-owner-handoff.md", "utf8");
    expect(source).not.toContain("<<'PROFILE'");
    expect(source).not.toContain("ps -p");
    expect(source).toContain("python3 -I");
    expect(source).toContain(
      '--ssh "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}"',
    );
    expect(source).toContain("metadata only");
  });
});
