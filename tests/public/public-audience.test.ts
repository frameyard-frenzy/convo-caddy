import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { renderSetupGuide } from "../../src/desktop/setup-guide.js";
const readme = readFileSync("README.md", "utf8");
const guide = readFileSync("docs/hermes-connection-setup.md", "utf8");
it("makes Tailscale conditional and links directly to complete visible topology paths", () => {
  const requirements =
    readme.split("### Requirements")[1]?.split("### Install")[0] ?? "";
  expect(requirements).toMatch(
    /Only for two Macs:.*Tailscale.*docs\/hermes-connection-setup.md#1-prepare-before-leaving-the-hermes-mac/,
  );
  expect(readme).toContain("docs/hermes-connection-setup.md#this-mac");
  expect(readme).toContain("docs/hermes-connection-setup.md#another-mac");
  expect(guide).not.toMatch(/<\/?(?:details|summary)/);
  expect(guide.indexOf("## This Mac")).toBeLessThan(
    guide.indexOf("## Another Mac"),
  );
  for (const title of ["This Mac", "Another Mac"]) {
    const section = guide.split(`## ${title}\n`)[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain("API_SERVER_KEY");
    expect(section).toContain("Finish the Hermes section");
    expect(section).toContain("--copy");
  }
  const finish = guide.split("## Finish the Hermes section")[1] ?? "";
  expect(finish).toContain("ALL connection fields");
  expect(finish).toContain("README — Save and choose a workspace");
  expect(finish.indexOf("**Load models**")).toBeLessThan(
    finish.indexOf("**Test assistant**"),
  );
  expect(guide.split("## This Mac\n")[1]?.split("\n## ")[0]).not.toMatch(
    /Tailscale|--ssh|Remote port|forwarding port/,
  );
});
// Legal attribution (LICENSE, NOTICE.md, public/FONT-LICENSES.txt) is preserved.
// Collaboration is public-safe; runtime
// identifiers and synthetic fixtures are not display copy: no repository-wide rename.
it("keeps public configuration help generic and troubleshooting self-service", () => {
  for (const file of [
    "README.md",
    // All authored public docs, including recovery and future nested guides.
    ...readdirSync("docs", { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".md"))
      .map((file) => `docs/${file}`),
    "SECURITY.md",
    // Shipped setup/help and native-facing menu/workspace copy.
    "src/desktop/application.ts",
    "src/desktop/main.ts",
    "src/desktop/bootstrap-server.ts",
    "src/client/main.ts",
    "src/client/api.ts",
    "native/uninstaller/Sources/UninstallApp/main.swift",
    "native/uninstaller/Sources/UninstallCore/UIDecisionModel.swift",
    "src/desktop/menu.ts",
    "src/desktop/workspace-dialog.ts",
    "src/desktop/setup-page.ts",
    "src/desktop/setup-client.ts",
    "src/desktop/setup-runtime.ts",
  ]) {
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toMatch(/\bmarty\b|\bMo\b|\/Users\//i);
    expect(text, file).not.toMatch(
      /report (?:this|the|only diagnostic|only the|code keychain) (?:code|diagnostic)|report code keychain|Report the failed step/i,
    );
  }
});
it("renders only allowlisted local jumps and visible sections while escaping arbitrary links and HTML", () => {
  const html = renderSetupGuide(
    `${guide}\n\n[exit](https://example.com)\n<script>bad()</script>`,
  );
  expect([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
    "#this-mac",
    "#another-mac",
  ]);
  for (const id of ["this-mac", "another-mac"])
    expect(html).toContain(
      `<section aria-labelledby="${id}"><h3 id="${id}" tabindex="-1">`,
    );
  expect(html).not.toContain("<details>");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

it("audits interview display copy while preserving exact internal DOM identifiers", () => {
  let source = readFileSync("src/client/render.ts", "utf8");
  const internalAttributes = [
    '  const section = createSection("Assistant", "marty");',
    '  const form = createElement("form", "marty-form");',
    '  label.htmlFor = "marty-input";',
    '  input.id = "marty-input";',
    '    const response = createElement("div", "marty-response");',
  ];
  for (const line of internalAttributes) {
    expect(source).toContain(line);
    source = source.replace(line, "");
  }
  expect(source).not.toMatch(/\bmarty\b|\bMo\b|\/Users\//i);
});
