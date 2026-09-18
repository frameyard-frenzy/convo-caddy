import type { ParsedInput } from "./types.js";

const requiredArgumentMessages = {
  "/note": "/note requires text.",
  "/question": "/question requires text.",
} as const;

export function parseInput(input: string): ParsedInput {
  const trimmed = input.trim();

  if (!trimmed) {
    return { kind: "invalid", message: "Enter a command or question." };
  }

  if (!trimmed.startsWith("/")) {
    return { kind: "askMarty", text: trimmed };
  }

  const separatorIndex = trimmed.search(/\s/u);
  const command =
    separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  const argument =
    separatorIndex === -1 ? "" : trimmed.slice(separatorIndex).trim();

  if (command === "/revisit") {
    return argument ? { kind: "revisit", hint: argument } : { kind: "revisit" };
  }

  if (command === "/note" || command === "/question") {
    if (!argument) {
      return { kind: "invalid", message: requiredArgumentMessages[command] };
    }

    return command === "/note"
      ? { kind: "note", text: argument }
      : { kind: "question", text: argument };
  }

  return { kind: "invalid", message: `Unknown command: ${command}` };
}
