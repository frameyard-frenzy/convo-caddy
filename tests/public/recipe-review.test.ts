import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSetupGuide } from "../../src/desktop/setup-guide.js";
import { SETUP_HTML } from "../../src/desktop/setup-page.js";

const readme = readFileSync("README.md", "utf8");
const guide = readFileSync("docs/hermes-connection-setup.md", "utf8");
const technical = readFileSync("docs/hermes-owner-handoff.md", "utf8");
describe("cold-reader findings", () => {
  it("offers self-service with physical preparation first", () => {
    const start = readme.split("### Hermes")[1]?.split("### Save")[0] ?? "";
    expect(start).toContain("If you own both Macs");
    expect(start).toContain("prepare the Hermes Mac first");
    expect(start).not.toContain("only after receiving");
    expect(guide).toContain("acquire-hermes.py");
    expect(guide).not.toContain("launch command");
    for (const label of ["This Mac", "Another Mac"]) {
      const section = guide.split(`## ${label}\n`)[1]?.split("\n## ")[0] ?? "";
      expect(section).toContain("python3 --version");
      expect(section.indexOf("python3 --version")).toBeLessThan(
        section.indexOf(
          'python3 -I -S "/Applications/Convo Caddy.app/Contents/Resources/acquire-hermes.py"',
        ),
      );
      expect(section).not.toContain("config env-path");
      expect(section).toContain("API_SERVER_KEY");
      expect(section).toContain("--copy");
      expect(section).toContain("clipboard");
    }
  });
  it("has separate executable technical sequences with prerequisites first", () => {
    for (const location of ["On the interview laptop"]) {
      const part =
        technical.split(`## ${location}`)[1]?.split("\n## ")[0] ?? "";
      expect(part).toContain("python3 --version");
      expect(part.indexOf("python3 --version")).toBeLessThan(
        part.indexOf("python3 -I "),
      );
      expect(part).not.toContain("config env-path");
      expect(part).toContain("metadata");
      expect(part).not.toMatch(
        /same SSH prefix|Python body|omitting SSH|inside the SSH quotes/,
      );
    }
  });
  it("keeps local and remote acquisition reachable in setup without a stale step reference", () => {
    expect(SETUP_HTML).not.toContain("Follow README step 5");
    expect(SETUP_HTML.indexOf('id="remote-guide"')).toBeLessThan(
      SETUP_HTML.indexOf('id="remote-fields"'),
    );
    const rendered = renderSetupGuide(guide);
    expect(rendered).toContain('section aria-labelledby="this-mac"');
    expect(rendered).toContain("API_SERVER_KEY");
    expect(rendered).not.toMatch(/href="(?!#(?:this-mac|another-mac)")/);
  });
  it("guards source acquisition and compares installed candidate bytes before launch", () => {
    const source = readFileSync("docs/source-install-and-upgrade.md", "utf8");
    expect(source).toContain('test ! -e "convo-caddy"');
    expect(source).toContain('test ! -L "convo-caddy"');
    expect(source).toMatch(/git clone[^\n]+ &&/);
    expect(source).toContain(
      'diff -qr "out/Convo Caddy-darwin-arm64/Convo Caddy.app"',
    );
    expect(source.indexOf("diff -qr")).toBeLessThan(
      source.indexOf('open "/Applications/Convo Caddy.app"'),
    );
    expect(source).toContain("### 9a. Quit");
    expect(source).toContain("### 9d. Compare");
    const practice = readFileSync("docs/practice-interview.md", "utf8");
    expect(practice).toContain("### 20c. End");
    expect(practice).toContain("### 20e. Reopen");
  });
  it("renders fenced commands intact and arbitrary HTML as escaped text", () => {
    const html = renderSetupGuide(
      "<details><summary>Local <unsafe></summary>\n\n```bash\nfirst\n\nsecond\n```\n\n</details>",
    );
    expect(html).toContain(
      "&lt;details&gt;&lt;summary&gt;Local &lt;unsafe&gt;&lt;/summary&gt;",
    );
    expect(html).toContain("<pre>first\n\nsecond</pre>");
    expect(html).toContain("&lt;/details&gt;");
    expect(html).not.toContain("<unsafe>");
  });
  it("makes long commands selectable without selecting the whole setup page", () => {
    const command = Array.from({ length: 12 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const html = renderSetupGuide(`\`\`\`bash\n${command}\n\`\`\``);
    expect(html).toContain(
      '<textarea class="setup-command" readonly wrap="off"',
    );
    expect(html).toContain('aria-label="Copy complete command"');
    expect(html).toContain(command);
  });
});
