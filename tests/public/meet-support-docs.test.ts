import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("current Meet support guidance", () => {
  it("does not exclude Meet from the current product contract", () => {
    const product = readFileSync(".collab/PRODUCT_CONTEXT.md", "utf8");
    expect(product).not.toContain("Zoom, Google Meet, multiple transcription");
    expect(product).toContain("nonblocking meeting reminder");
    expect(product).toContain("private Meet or personal Teams test");
  });

  it("gives callback recovery guidance for either supported platform", () => {
    const guide = readFileSync("docs/hermes-connection-setup.md", "utf8");
    expect(guide).toContain("private Meet or personal Teams practice call");
    expect(guide).not.toContain("private Teams practice call");
  });
});
