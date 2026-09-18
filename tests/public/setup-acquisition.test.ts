import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8");
const guide = readFileSync("docs/hermes-connection-setup.md", "utf8");
const technical = readFileSync("docs/hermes-owner-handoff.md", "utf8");

describe("listener key acquisition contract", () => {
  it("keeps complete local and remote acquisition in the bundled guide", () => {
    const people =
      readme.split("## For people")[1]?.split("## For agents")[0] ?? "";
    const agents = readme.split("## For agents")[1] ?? "";
    expect(people).toContain("docs/hermes-connection-setup.md");
    expect(agents).toContain("docs/hermes-owner-handoff.md");
    const bodies = [...guide.matchAll(/```command\n([\s\S]*?)\n```/g)].map(
      (m) => m[1] ?? "",
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toContain("--ssh");
    expect(bodies[1]).toContain(
      '--ssh "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}"',
    );
    for (const body of bodies) {
      expect(body).toContain(
        'python3 -I -S "/Applications/Convo Caddy.app/Contents/Resources/acquire-hermes.py"',
      );
      expect(body).toContain("--copy");
    }
    expect(technical).not.toContain("## On the Hermes host");
    expect(technical).toContain("## On the interview laptop");
    expect(guide).toContain("model `assistant` does not imply `/p/assistant`");
  });
  it("ships the canonical helper as a plain Python resource without a second install", () => {
    expect(readFileSync("forge.config.ts", "utf8")).toContain(
      'path.join(projectRoot, "scripts/acquire-hermes.py")',
    );
    const helper = readFileSync("scripts/acquire-hermes.py", "utf8");
    expect(helper).toContain("API_SERVER_KEY");
    expect(helper).toContain("/usr/bin/pbcopy");
    expect(helper).not.toContain("import hermes");
    expect(readFileSync("scripts/verify-package-mac.ts", "utf8")).toContain(
      "Packaged acquisition helper does not match source.",
    );
  });
});
