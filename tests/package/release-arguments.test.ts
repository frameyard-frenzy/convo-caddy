import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const valid = [
  "--version",
  "0.2.0",
  "--clean-export-sha",
  "a".repeat(40),
  "--approved-root-sha",
  "b".repeat(40),
  "--manifest",
  "manifest.json",
];

describe("documented release arguments", () => {
  it("uses a parser-valid package version while stating that approval is still required", async () => {
    const guide = readFileSync(path.resolve("docs/releasing.md"), "utf8");
    const packageVersion = JSON.parse(
      readFileSync(path.resolve("package.json"), "utf8"),
    ).version as string;
    const documentedVersion = /--version\s+(\S+)/.exec(guide)?.[1];
    expect(documentedVersion).toBe(packageVersion);
    const release = await import("../../scripts/prepare-release-mac.js");
    expect(() =>
      release.parseReleaseArguments(
        valid.map((value) =>
          value === "0.2.0" ? (documentedVersion ?? "") : value,
        ),
      ),
    ).not.toThrow();
    expect(guide).toMatch(/example only|not an approved release version/i);
  });
  it("loads without release side effects and accepts the pnpm forwarding separator", async () => {
    const release = await import("../../scripts/prepare-release-mac.js");
    expect(release.parseReleaseArguments(["--", ...valid])).toEqual({
      version: "0.2.0",
      cleanExportSha: "a".repeat(40),
      manifest: "manifest.json",
      approvedRootSha: "b".repeat(40),
    });
  });
  it.each([
    [...valid, "--version", "0.3.0"],
    [...valid, "--unknown", "value"],
    valid.slice(0, -1),
    ["--version", "--manifest", "file"],
    ["--", "--", ...valid],
    valid.map((value) => (value === "0.2.0" ? "latest" : value)),
    valid.map((value) => (value === "a".repeat(40) ? "short" : value)),
  ])("rejects malformed arguments without echoing values", async (...args) => {
    const release = await import("../../scripts/prepare-release-mac.js");
    expect(() => release.parseReleaseArguments(args)).toThrow();
  });
});
