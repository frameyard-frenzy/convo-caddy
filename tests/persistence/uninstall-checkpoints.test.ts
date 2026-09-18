import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { produceUninstallCheckpoints } from "../helpers/uninstall-checkpoints.js";
it("native uninstall fixtures match actual startup and checkpoint writer shapes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "caddy-checkpoint-producer-"));
  try {
    const fixtures = await produceUninstallCheckpoints(root);
    for (const [name, bytes] of Object.entries(fixtures)) {
      expect(bytes).toBe(
        readFileSync(
          `native/uninstaller/Tests/Fixtures/UninstallCheckpoints/${name}.json`,
          "utf8",
        ),
      );
    }
    expect(JSON.parse(fixtures.idle)).toMatchObject({
      schemaVersion: 1,
      workspace: null,
      state: { capture: { mode: "live_ready" } },
    });
    expect(JSON.parse(fixtures.joining)).toMatchObject({
      workspace: null,
      state: {
        capture: {
          mode: "recall",
          status: "joining",
          provider: { botId: "synthetic-uninstall-bot" },
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
