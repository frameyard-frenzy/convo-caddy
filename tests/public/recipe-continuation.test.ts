import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSetupGuide } from "../../src/desktop/setup-guide.js";
const readme = readFileSync("README.md", "utf8");
const guide = readFileSync("docs/hermes-connection-setup.md", "utf8");
describe("running Hermes audience and continuation", () => {
  it("starts from daily-running Hermes without requiring remembered startup or keys", () => {
    const eligibility =
      readme.split("### Hermes")[1]?.split("### Save")[0] ?? "";
    for (const required of [
      "already use Hermes",
      "HTTP API",
      "Leave Hermes running",
      "Hermes connection setup (Markdown guide)",
      "API key",
    ])
      expect(eligibility).toContain(required);
    expect(readme).not.toContain("original Terminal");
    expect(readme).not.toContain("only when eligible");
    expect(guide).not.toContain("config env-path");
    expect(guide).not.toContain("Read the existing launch information");
    expect(readme.indexOf("### ngrok")).toBeLessThan(
      readme.indexOf("### Hermes"),
    );
  });
  it("converges both topology paths before models and one README Save return", () => {
    const finish =
      guide
        .split("## Finish the Hermes section")[1]
        ?.split("## If acquisition stops")[0] ?? "";
    for (const title of ["This Mac", "Another Mac"]) {
      const section = guide.split(`## ${title}\n`)[1]?.split("\n## ")[0] ?? "";
      expect(section).toContain("--copy");
      expect(section).not.toContain("Click **Save**");
    }
    expect(finish.indexOf("**Load models**")).toBeLessThan(
      finish.indexOf("**Test assistant**"),
    );
    expect(finish.indexOf("**Test assistant**")).toBeLessThan(
      finish.indexOf("README — Save and choose a workspace"),
    );
    expect(
      guide.match(/return to \*\*README — Save and choose a workspace/g),
    ).toHaveLength(1);
    expect(readme).not.toContain("#### Fill the address and ports");
    const html = renderSetupGuide(guide);
    expect(html).toContain("Finish the Hermes section");
    expect(html).toContain("README — Save and choose a workspace");
    expect(html).not.toMatch(/href="(?!#(?:this-mac|another-mac)")/);
  });
});

it("keeps the canonical acceptance runbook aligned with current acquisition evidence", () => {
  const runbook = readFileSync(".collab/runbooks/setup-acceptance.md", "utf8");
  const acquisition =
    runbook
      .split("## Listener acquisition and scope")[1]
      ?.split("## Visual evidence")[0] ?? "";
  for (const value of [
    "scripts/acquire-hermes.py",
    "profile, port and API base path",
    "metadata",
    "two human commands",
    "start-time-producers.json",
  ])
    expect(acquisition).toContain(value);
  expect(acquisition).not.toContain("Inherited profile/environment");
  expect(acquisition).not.toContain("all three published snippets");
  const guide = readFileSync("docs/hermes-connection-setup.md", "utf8");
  expect(guide).toContain("enroll-hermes-key.py");
  expect(renderSetupGuide(guide)).toContain("ALREADY_ENROLLED");
});
