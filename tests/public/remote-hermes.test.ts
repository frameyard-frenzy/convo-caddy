import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSetupGuide } from "../../src/desktop/setup-guide.js";
import { isHermesSshTarget } from "../../src/server/connectivity/hermes-ssh-target.js";

const guide = readFileSync("docs/hermes-connection-setup.md", "utf8");
describe("remote onboarding contract", () => {
  it("defines each prerequisite before its dependent action", () => {
    const steps = [
      "### 1. Prepare",
      "### 2. Set your remote address",
      "### 3. Check Python",
      "### 4. Reuse or create",
      "### 5. Enroll only",
      "### 6. Unlock and prove",
      "### 7. Acquire",
    ];
    let position = -1;
    for (const step of steps) {
      const next = guide.indexOf(step);
      expect(next).toBeGreaterThan(position);
      position = next;
    }
    const commands = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .join("\n");
    expect(commands.indexOf("ls -ld ~/.ssh")).toBeLessThan(
      commands.indexOf("ssh-keygen -t ed25519"),
    );
    expect(commands).toContain("enroll-hermes-key.py");
    expect(commands).not.toContain("chmod ");
    expect(commands).not.toMatch(
      />\s*~\/.ssh\/authorized_keys|ssh-keyscan|StrictHostKeyChecking=no|--replace|gateway restart|config set API_SERVER_KEY/,
    );
    expect(commands).toContain("-o BatchMode=yes -o StrictHostKeyChecking=yes");
    expect(commands).toContain("--apple-use-keychain");
    expect(guide).toContain(
      "Finder agent availability remains a real-machine acceptance check",
    );
    expect(readFileSync("docs/hermes-owner-handoff.md", "utf8")).toContain(
      "false does not disable an already YAML-enabled API",
    );
  });
  it("renders bundled instructions without permitting HTML or navigation to destroy drafts", () => {
    const html = renderSetupGuide(
      guide + "\n\n<script>leak()</script>\n\n[exit](javascript:leak())",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/href="(?!#(?:this-mac|another-mac)")/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<pre>");
    expect(html).toContain("Only these users");
  });
  it.each([
    "operator@100.101.102.103",
    "operator@hermes.example.ts.net",
    "operator@legacy.local",
    "legacy-host",
  ])("preserves literal target compatibility for %s", (target) =>
    expect(isHermesSshTarget(target)).toBe(true),
  );
  it.each([
    "ssh://operator@100.101.102.103",
    "operator@host:22",
    "-Falias",
    "host; touch bad",
    "host $(whoami)",
    "user@host\n-N",
  ])("rejects non-address input %s", (target) =>
    expect(isHermesSshTarget(target)).toBe(false),
  );
});
