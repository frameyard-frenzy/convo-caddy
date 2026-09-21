import {
  runSyntheticExperiment,
  SYNTHETIC_SCENARIOS,
  type SyntheticScenario,
} from "../src/server/desktop/recall-webhook-experiment.js";

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
  console.log(`Recall webhook source experiment — offline fixtures only
Usage: node --import tsx scripts/recall-webhook-test-experiment.ts --synthetic <scenario>
Scenarios: ${SYNTHETIC_SCENARIOS.join(", ")}
No real credentials, live MCP requests, or public tunnels are supported.
Live gate: provider schemas, signed receipt linkage, quiescence BEFORE domain takeover,
and a no-delayed-sample strategy across timeout/cancel/crash/resumption remain unresolved.
Local teardown does not cancel provider retries. Live transcription: not tested.`);
} else if (
  args.length === 2 &&
  args[0] === "--synthetic" &&
  SYNTHETIC_SCENARIOS.includes(args[1] as SyntheticScenario)
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runSyntheticExperiment(
      args[1] as SyntheticScenario,
      controller.signal,
    );
    console.log(JSON.stringify(result, null, 2));
    console.log("Live transcription: not tested");
    process.exitCode =
      result.outcome === "synthetic_attributed" && result.cleanup === "complete"
        ? 0
        : 2;
  } catch {
    console.error("Synthetic experiment unavailable; no live test performed.");
    process.exitCode = 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
} else {
  // Never echo arguments: a caller may have mistakenly supplied a secret.
  console.error(
    "Unsupported arguments. Use --help. Real credentials and live mode are unavailable.",
  );
  process.exitCode = 2;
}
