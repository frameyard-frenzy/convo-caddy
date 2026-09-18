import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8");
const people =
  readme.split("## For people")[1]?.split("## For agents")[0] ?? "";
const remote =
  readFileSync("docs/hermes-connection-setup.md", "utf8").split(
    "## Another Mac",
  )[1] ?? "";
function ordered(text: string, actions: string[]) {
  let previous = -1;
  for (const action of actions) {
    const position = text.indexOf(action);
    expect(position, action).toBeGreaterThan(previous);
    previous = position;
  }
}
describe("novice recipe dependencies", () => {
  it("acquires connection values in visible form order", () => {
    ordered(people, [
      "### Install",
      "### Recall",
      "https://us-west-2.recall.ai/auth/signup",
      "### ngrok",
      "Your Authtoken",
      "Test Recall & ngrok",
      "### Hermes",
      "Where Hermes runs",
      "Load models",
      "Test assistant",
      "### Save and choose a workspace",
      "### Uninstall",
    ]);
    expect(people).not.toContain("lsof ");
    expect(people).not.toContain("parser =");
    expect(people).not.toContain("leaving Hermes unconfigured");
    expect(people).toContain("ALL connection fields");
    expect(people).toContain("Diagnostic details");
    expect(readFileSync("docs/practice-interview.md", "utf8")).toContain(
      "Admission is recording authorization",
    );
  });
  it("prepares an existing file before choosing it and separately authorizing capture", () => {
    const practice = readFileSync("docs/practice-interview.md", "utf8");
    ordered(practice, [
      "Save and choose a workspace",
      "prep/TEMPLATE.md",
      "Choose prep…",
      "Personal Microsoft Teams meeting link",
      "Start live capture",
      "Admission is recording authorization",
      "### 20c. End the meeting",
      "### 20d. Wait for saving",
      "### 20e. Reopen the app",
    ]);
    expect(practice).toContain("Cancel leaves the current selection intact");
    expect(practice).toContain("Prep cannot change after capture starts");
  });
  it("establishes host trust before password login and public-only enrollment", () => {
    ordered(remote, [
      "Already connected",
      "Only these users",
      "ssh_host_ed25519_key.pub",
      "StrictHostKeyChecking=ask",
      "python3 --version",
      "ls -ld ~/.ssh",
      "ssh-keygen -t ed25519",
      'python3 -I -S "/Applications/Convo Caddy.app/Contents/Resources/enroll-hermes-key.py"',
      "BatchMode=yes",
    ]);
    expect(remote).toContain("Never overwrite");
    expect(remote).toContain("password login does not enroll");
    expect(remote).toContain("ALL connection fields");
    expect(remote).not.toContain("deferring Hermes");
  });
});
