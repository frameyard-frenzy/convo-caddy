import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePrepTopicLines } from "../../src/client/render.js";

describe("workspace prep editor", () => {
  it("uses neutral public agent language", () => {
    const source = readFileSync(path.resolve("src/client/render.ts"), "utf8");
    expect(source).toContain('createSection("Assistant"');
    expect(source).toContain("or ask your agent");
    expect(source).not.toContain('createSection("Marty"');
    expect(source).not.toContain("ask Marty");
  });
  it("rejects malformed prompt lines instead of silently deleting them", () => {
    expect(() =>
      parsePrepTopicLines("must: Keep this\nmst: Do not delete this"),
    ).toThrow("Line 2 must start with must: or more:");
  });

  it("preserves ordered Must and More prompt lines", () => {
    expect(parsePrepTopicLines("must: First\nmore: Second")).toEqual([
      { tier: "must", text: "First" },
      { tier: "more", text: "Second" },
    ]);
  });
});
