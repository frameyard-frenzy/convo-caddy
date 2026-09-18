import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("pinned Hermes compatibility manifest", () => {
  const manifest = JSON.parse(
    readFileSync("tests/fixtures/hermes-compatibility/manifest.json", "utf8"),
  );
  it("pins installed, stable, and forward-check targets by full commit", () => {
    expect(manifest.targets).toHaveLength(3);
    for (const target of manifest.targets)
      expect(target.commit).toMatch(/^[0-9a-f]{40}$/);
  });
  it("documents synthetic proof markers and limitations", () => {
    expect(manifest.syntheticMarkers).toHaveLength(3);
    expect(manifest.limitations).toContain("no live provider");
  });
});
