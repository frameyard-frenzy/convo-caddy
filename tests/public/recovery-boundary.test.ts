import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PUBLIC_TREE_ALLOWLIST } from "../../scripts/verify-public-tree.js";
const internal = ".collab/runbooks/install-uninstall-acceptance.md";
const recovery = readFileSync("docs/install-uninstall-verification.md", "utf8");
it("keeps ordinary recovery independent of personal harness instructions", () => {
  expect(recovery).not.toMatch(
    /\bMo\b|\bG3\b|--mode real-machine|I APPROVE THIS EXACT G3 SCOPE|collab\//,
  );
  expect(recovery).toContain("## Manual recovery fallback");
  expect(recovery).toContain("../README.md#install");
  expect(recovery).toContain("Stop if preservation or verification fails");
});
it("includes sanitized collaboration and keeps operational receipts external", () => {
  expect(PUBLIC_TREE_ALLOWLIST).toContain(".collab");
  expect(existsSync(internal)).toBe(true);
  const runbook = readFileSync(internal, "utf8");
  expect(runbook).toContain("Real disposable Keychain remains G3");
  expect(runbook).not.toMatch(
    /VERBATIM HISTORICAL|projects\/frameyard\/artifacts/,
  );
  expect(existsSync("collab")).toBe(false);
});
