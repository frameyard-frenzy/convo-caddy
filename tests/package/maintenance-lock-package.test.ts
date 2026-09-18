import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("maintenance lock package", () => {
  it("builds a Node-API addon owned by Electron main and fails closed", () => {
    const c = readFileSync("native/lifecycle-lock/lock.c", "utf8"),
      main = readFileSync("src/desktop/main.ts", "utf8");
    expect(c).toContain("NAPI_MODULE");
    expect(c).toContain("LOCK_SH | LOCK_NB");
    expect(c).toContain("static int held_fd");
    expect(
      main.indexOf("const maintenanceLock = acquireMaintenanceLock()"),
    ).toBeLessThan(main.indexOf('app.setName("Convo Caddy")'));
  });
});
