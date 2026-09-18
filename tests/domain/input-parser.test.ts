import { describe, expect, it } from "vitest";
import { parseInput } from "../../src/domain/input-parser.js";

describe("parseInput", () => {
  it.each([
    [
      "/note  Keep  both spaces.  ",
      { kind: "note", text: "Keep  both spaces." },
    ],
    [
      "  /question Why did Lot 7 move?  ",
      { kind: "question", text: "Why did Lot 7 move?" },
    ],
    [
      "/revisit  Who approved containment?  ",
      { kind: "revisit", hint: "Who approved containment?" },
    ],
    ["/revisit", { kind: "revisit" }],
    [" /revisit   ", { kind: "revisit" }],
    [
      "  What did they say about SAP?  ",
      { kind: "askMarty", text: "What did they say about SAP?" },
    ],
  ])("parses %j without rewriting captured text", (input, expected) => {
    expect(parseInput(input)).toEqual(expected);
  });

  it.each([
    ["", "Enter a command or question."],
    ["   ", "Enter a command or question."],
    ["/note", "/note requires text."],
    ["/note   ", "/note requires text."],
    ["/question", "/question requires text."],
    ["/question   ", "/question requires text."],
  ])("rejects missing input %j locally", (input, message) => {
    expect(parseInput(input)).toEqual({ kind: "invalid", message });
  });

  it.each(["/later something", "/Note something", "/revisit-now"])(
    "rejects unknown exact-leading command %j",
    (input) => {
      expect(parseInput(input)).toEqual({
        kind: "invalid",
        message: `Unknown command: ${input.split(/\s/u, 1)[0]}`,
      });
    },
  );
});
