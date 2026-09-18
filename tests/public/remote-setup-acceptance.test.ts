import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SETUP_HTML } from "../../src/desktop/setup-page.js";

it("finishes host preparation before a laptop-only remote journey", () => {
  const guide = readFileSync("docs/hermes-connection-setup.md", "utf8");
  expect(guide).toMatch(/^# Hermes connection setup/);
  expect(guide).toContain("Markdown guide");
  const remote = guide.split("## Another Mac")[1] ?? "";
  const prep = remote.split("### 2.")[0] ?? "";
  for (const text of [
    "Remote Login",
    "Only these users",
    "ssh_host_ed25519_key.pub",
    "Python",
    "Already prepared",
  ])
    expect(prep).toContain(text);
  const laptop = remote.slice(remote.indexOf("### 2."));
  expect(laptop).not.toMatch(
    /Hermes Mac, Terminal|AirDrop|nano |whoami|chmod /,
  );
  expect(laptop).toContain("StrictHostKeyChecking=yes");
  expect(laptop).toContain("enroll-hermes-key.py");
  expect(laptop.indexOf("python3 --version")).toBeLessThan(
    laptop.indexOf(
      'python3 -I -S "/Applications/Convo Caddy.app/Contents/Resources/enroll-hermes-key.py"',
    ),
  );
  expect(guide).not.toMatch(/optional owner card|use from anywhere|operator@/);
  const continuation = guide.split("## Finish the Hermes section")[1] ?? "";
  for (const label of [
    "Mac address (SSH)",
    "Remote port",
    "Local port",
    "API base path",
    "Load models",
    "Test assistant",
  ])
    expect(continuation).toContain(label);
  expect(
    guide.match(/return to \*\*README — Save and choose a workspace/g),
  ).toHaveLength(1);
  expect(SETUP_HTML).toContain("Hermes connection setup (Markdown guide)");
  expect(SETUP_HTML).toContain('<option value="ssh">Another Mac</option>');
});

it("renders preparation actions as distinct ordered steps", async () => {
  const { renderSetupGuide } = await import("../../src/desktop/setup-guide.js");
  const html = renderSetupGuide(
    "1. Download\n2. Open\n\n- Keep trust\n- Keep keys",
  );
  expect(html).toContain("<ol><li>Download</li><li>Open</li></ol>");
  expect(html).toContain("<ul><li>Keep trust</li><li>Keep keys</li></ul>");
});

it("keeps linked agent instructions laptop-only after preparation", () => {
  const owner = readFileSync("docs/hermes-owner-handoff.md", "utf8");
  expect(owner).not.toMatch(/AirDrop|whoami|## On the Hermes host/);
  expect(owner).toContain("Reuse `HERMES_SSH_TARGET` from step 2");
  expect(owner).toContain(
    "# Verify public files and run remote metadata from laptop",
  );
});
