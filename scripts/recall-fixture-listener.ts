import path from "node:path";
import {
  createRecallFixtureRecorderServer,
  type RecallFixtureRecorderOutcome,
} from "./lib/recall-fixture-recorder.js";

const secret = process.env.CONVO_CADDY_RECALL_VERIFICATION_SECRET?.trim();
if (!secret) {
  throw new Error(
    "CONVO_CADDY_RECALL_VERIFICATION_SECRET is required for fixture capture.",
  );
}

const rawPort = process.env.CONVO_CADDY_RECALL_WEBHOOK_PORT?.trim() || "4318";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CONVO_CADDY_RECALL_WEBHOOK_PORT must be a valid port.");
}

const privateFixtureRoot = path.resolve("var/recall-fixtures");
const fixtureDirectory = path.resolve(
  process.env.CONVO_CADDY_RECALL_FIXTURE_RAW_DIR?.trim() ||
    path.join(privateFixtureRoot, "raw"),
);
const relativeFixtureDirectory = path.relative(
  privateFixtureRoot,
  fixtureDirectory,
);
if (
  relativeFixtureDirectory.startsWith("..") ||
  path.isAbsolute(relativeFixtureDirectory)
) {
  throw new Error(
    "CONVO_CADDY_RECALL_FIXTURE_RAW_DIR must stay beneath var/recall-fixtures.",
  );
}
const server = createRecallFixtureRecorderServer({
  secret,
  fixtureDirectory,
  onOutcome: (outcome) => console.log(OUTCOME_MESSAGES[outcome]),
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `Verified Recall fixture listener ready on http://127.0.0.1:${port}/api/capture/recall/webhook`,
  );
  console.log(
    `Raw fixtures will be stored privately beneath ${fixtureDirectory}`,
  );
  console.log(
    "Replay now. A sanitized outcome line will appear for every request that reaches this listener.",
  );
});

const OUTCOME_MESSAGES: Record<RecallFixtureRecorderOutcome, string> = {
  stored: "Stored one verified Recall fixture (HTTP 204).",
  duplicate: "Acknowledged an identical Recall replay (HTTP 204).",
  conflict: "Rejected a conflicting Recall replay (HTTP 409).",
  invalid:
    "Rejected a Recall request that failed signature or header verification (HTTP 400).",
  too_large: "Rejected an oversized Recall request (HTTP 413).",
  internal_error: "Could not store a verified Recall request (HTTP 500).",
  unexpected_request:
    "Ignored a request to the wrong method or path (HTTP 404).",
};
