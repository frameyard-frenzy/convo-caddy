import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
it("enrolls public keys only through bounded synthetic filesystem and SSH seams", () => {
  const result = spawnSync(
    "python3",
    ["-I", "tests/fixtures/onboarding/enroll-public-key.py"],
    { encoding: "utf8", timeout: 30000 },
  );
  expect(result.stdout + result.stderr).toContain("OK");
  expect(result.status).toBe(0);
});
