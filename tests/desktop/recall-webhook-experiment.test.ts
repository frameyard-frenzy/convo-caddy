import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSyntheticExperiment } from "../../src/server/desktop/recall-webhook-experiment.js";

describe("disposable synthetic command-line proof", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());
  it("S1/S5: passes early attributed callback with no public self POST or ingestion", async () => {
    const result = await runSyntheticExperiment("early-callback");
    expect(result.outcome).toBe("synthetic_attributed");
    expect(result.cleanup).toBe("complete");
    expect(result.publicSelfPosts).toBe(0);
    expect(result.fixtureSends).toBe(1);
    expect(result.liveTranscription).toBe("not_tested");
    expect(result.evidence).toBe("offline_fixture_only");
  });
  it.each([
    ["no-receipt", "not_received"],
    ["wrong-signature", "not_received"],
    ["response-lost", "unattributed"],
    ["self-signed-only", "unattributed"],
    ["unrelated", "unattributed"],
    ["cancelled", "cancelled"],
    ["settings-changed", "settings_changed"],
    ["endpoint-mismatch", "configuration_rejected"],
    ["domain-collision", "endpoint_unavailable"],
    ["send-rejected", "send_rejected"],
  ] as const)(
    "%s cannot turn green or trigger resend",
    async (scenario, outcome) => {
      const result = await runSyntheticExperiment(scenario);
      expect(result.outcome).toBe(outcome);
      expect(result.fixtureSends).toBeLessThanOrEqual(1);
      expect(result.cleanup).toBe("complete");
      expect(JSON.stringify(result)).not.toContain("SECRET-SENTINEL");
    },
  );
  it("rejects concurrent attempts process-wide", async () => {
    const first = runSyntheticExperiment("no-receipt");
    await expect(runSyntheticExperiment("early-callback")).rejects.toThrow(
      "experiment_busy",
    );
    await first;
  });
  it("S7: cleanup failure blocks a new attempt", async () => {
    const isolated = await import(
      "../../src/server/desktop/recall-webhook-experiment.js"
    );
    const result = await isolated.runSyntheticExperiment("cleanup-failed");
    expect(result.cleanup).toBe("blocked");
    expect(result.outcome).not.toBe("synthetic_attributed");
    await expect(
      isolated.runSyntheticExperiment("early-callback"),
    ).rejects.toThrow("cleanup_blocked");
  });
});
