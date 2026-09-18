import { describe, expect, it } from "vitest";
import { parseMartyResponse } from "../../src/server/marty/response-schema.js";

describe("Marty response validation", () => {
  it("accepts one strict response with existing transcript citations", () => {
    expect(
      parseMartyResponse(
        {
          text: "The containment decision followed the serial mismatch.",
          citationTurnIds: ["turn-1"],
        },
        ["turn-1"],
      ),
    ).toEqual({
      text: "The containment decision followed the serial mismatch.",
      citationTurnIds: ["turn-1"],
    });
  });

  it.each([
    null,
    {},
    { text: "", citationTurnIds: [] },
    { text: "Answer", citationTurnIds: [], extra: true },
    { text: "Answer", citationTurnIds: ["turn-1", "turn-1"] },
  ])("rejects malformed structured output %#", (value) => {
    expect(() => parseMartyResponse(value, ["turn-1"])).toThrow();
  });

  it("rejects citations that are absent from the supplied transcript", () => {
    expect(() =>
      parseMartyResponse(
        { text: "Fabricated citation.", citationTurnIds: ["missing-turn"] },
        ["turn-1"],
      ),
    ).toThrow("Assistant returned an invalid transcript citation.");
  });

  it("rejects existing citations returned out of transcript order", () => {
    expect(() =>
      parseMartyResponse(
        {
          text: "The evidence changed over time.",
          citationTurnIds: ["turn-2", "turn-1"],
        },
        ["turn-1", "turn-2"],
      ),
    ).toThrow("Assistant returned an invalid transcript citation.");
  });
});
