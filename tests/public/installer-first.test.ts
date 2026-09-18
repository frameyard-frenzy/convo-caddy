import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETUP_HTML } from "../../src/desktop/setup-page.js";
const readme = readFileSync("README.md", "utf8");
const people =
  readme.split("## For people")[1]?.split("## For agents")[0] ?? "";
function ordered(text: string, values: string[]) {
  let previous = -1;
  for (const value of values) {
    const index = text.indexOf(value);
    expect(index, value).toBeGreaterThan(previous);
    previous = index;
  }
}
describe("installer-first first-time onboarding", () => {
  it("has a pitch, concise requirements and GUI installation with an honest release gate", () => {
    expect(readme.split("## For people")[0]).toContain("interview questions");
    expect(people).toContain("### Requirements");
    expect(people).toContain("No installer is currently published");
    ordered(people, [
      "### Install",
      "Download",
      "double-click",
      "drag",
      "Applications",
      "### Recall",
      "### ngrok",
      "### Hermes",
    ]);
    for (const forbidden of [
      "git clone",
      "pnpm",
      "xcode-select",
      "node --version",
      "diff -qr",
      "older app",
      "About This Mac",
      "Expected:",
      "Next:",
      "<a id=",
    ])
      expect(people).not.toContain(forbidden);
    expect(people).not.toMatch(/```bash|releases\/latest\/download/);
    expect(people.indexOf("Where Hermes runs")).toBeGreaterThan(
      people.indexOf("### Hermes"),
    );
  });
  it("follows actual provider form order and keeps callback prerequisites before testing", () => {
    ordered(SETUP_HTML, [
      'id="recall-heading"',
      'id="ngrok-heading"',
      'id="hermes-heading"',
    ]);
    ordered(people, [
      "### Recall",
      "Workspace verification secret",
      "### ngrok",
      "Your Authtoken",
      "Webhook URL",
      "Test Recall & ngrok",
      "### Hermes",
      "Load models",
      "Test assistant",
      "### Save and choose a workspace",
    ]);
    expect(people).toContain("ALL connection fields");
    expect(readFileSync("docs/hermes-connection-setup.md", "utf8")).toContain(
      "provider cost",
    );
    expect(people).toContain("Diagnostic details");
  });
  it("ends the human guide with the shipped graphical uninstall choices", () => {
    const uninstall = people.split("### Uninstall")[1] ?? "";
    const flow = readFileSync(
      "native/uninstaller/Sources/UninstallCore/UninstallFlow.swift",
      "utf8",
    );
    expect(flow).toContain('buttons:["No","Yes","Cancel"]');
    expect(flow).toContain("defaultButton: Int = 0");
    expect(flow).toContain(
      "guard response == 0 || (hasWorkspace && response == 1) else{return}",
    );
    expect(flow).toContain("Convo Caddy uninstalled");
    for (const phrase of [
      "Quit Convo Caddy",
      "Uninstall Convo Caddy",
      "Also delete your workspace?",
      "**No**",
      "**Yes**",
      "**Cancel**",
      "default",
      "private app data",
      "credentials",
      "entire",
      "parent",
      "Convo Caddy uninstalled",
      "already removed",
    ])
      expect(uninstall).toContain(phrase);
    expect(people.lastIndexOf("### ")).toBe(people.indexOf("### Uninstall"));
    const agents = readme.split("## For agents")[1] ?? "";
    for (const value of [
      "explicit removal permission",
      "No",
      "Yes",
      "Cancel",
      "docs/hermes-owner-handoff.md",
    ])
      expect(agents).toContain(value);
  });
  it("uses real heading destinations and preserves source/upgrade/practice references", () => {
    for (const file of [
      "docs/build-from-source.md",
      "docs/source-install-and-upgrade.md",
      "docs/practice-interview.md",
      "docs/install-uninstall-verification.md",
    ]) {
      const doc = readFileSync(file, "utf8");
      expect(doc).not.toContain("README steps 9a");
      expect(doc).not.toContain("#install-and-set-up");
    }
    expect(readme).not.toContain("<a id=");
    expect(readme).toContain("](#uninstall)");
    const guide = readFileSync("docs/hermes-connection-setup.md", "utf8");
    expect(guide).toContain("README — Save and choose a workspace");
    expect(guide).not.toMatch(/README step|freshly built|fresh build/);
  });
});

it("binds menu, installer and callback instructions to shipped source", () => {
  const menu = readFileSync("src/desktop/menu.ts", "utf8");
  for (const label of [
    "Configuration",
    "Connection Settings…",
    "Quit Convo Caddy",
  ]) {
    expect(menu).toContain(`label: "${label}"`);
    expect(readme).toContain(label);
  }
  const artwork = readFileSync("assets/dmg-background.svg", "utf8");
  for (const text of ["Drag Convo Caddy to Applications", "Remove Convo Caddy"])
    expect(artwork).toContain(text);
  const formEvents = SETUP_HTML.match(
    /<pre>(bot\.joining_call[\s\S]*?)<\/pre>/,
  )?.[1]?.split("\n");
  const recipeEvents = readme
    .match(/```text\n([\s\S]*?)\n```/)?.[1]
    ?.split("\n");
  expect(recipeEvents).toEqual(formEvents);
  expect(recipeEvents).toHaveLength(10);
});

it("resolves relative links and heading fragments across the rewritten navigation", () => {
  const files = [
    "README.md",
    "docs/build-from-source.md",
    "docs/source-install-and-upgrade.md",
    "docs/practice-interview.md",
    "docs/hermes-owner-handoff.md",
    "docs/hermes-connection-setup.md",
    "docs/install-uninstall-verification.md",
  ];
  const slug = (heading: string) =>
    heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, "")
      .replaceAll(" ", "-");
  for (const file of files) {
    const body = readFileSync(file, "utf8");
    for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1] ?? "";
      if (/^https?:/.test(target)) continue;
      const [relative, fragment] = target.split("#");
      const destination = relative
        ? path.resolve(path.dirname(file), relative)
        : path.resolve(file);
      const linked = readFileSync(destination, "utf8");
      if (fragment) {
        const headings = [...linked.matchAll(/^#+ (.+)$/gm)].map((m) =>
          slug(m[1] ?? ""),
        );
        expect(headings, `${file} -> ${target}`).toContain(fragment);
      }
    }
  }
});
