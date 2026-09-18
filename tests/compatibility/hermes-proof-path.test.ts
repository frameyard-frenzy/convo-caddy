import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Hermes construction proof architecture", () => {
  it("captures the fake provider dispatched by the real API handler, never a hand-built prompt", () => {
    const script = readFileSync(
      "scripts/verify-hermes-profile-context.py",
      "utf8",
    );
    expect(script).toContain("_handle_chat_completions");
    expect(script).toContain("_create_openai_client");
    expect(script).not.toContain("agent._build_system_prompt()");
    expect(script).not.toContain("agent._build_api_kwargs(");
  });
});
