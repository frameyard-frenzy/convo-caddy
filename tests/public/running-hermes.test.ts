import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("running Hermes acquisition", () => {
  it("verifies the canonical helper through synthetic filesystem, process, HTTP and clipboard seams", () => {
    const result = spawnSync(
      "python3",
      ["-I", "tests/fixtures/onboarding/running-hermes.py"],
      {
        encoding: "utf8",
        timeout: 30000,
      },
    );
    expect(result.stdout + result.stderr).toContain("OK");
    expect(result.status).toBe(0);
  });
});
