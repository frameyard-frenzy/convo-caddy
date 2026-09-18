import path from "node:path";
import { redactRecallFixtures } from "./lib/recall-fixture-redactor.js";

const result = redactRecallFixtures({
  inputDirectory: path.resolve(
    process.env.CONVO_CADDY_RECALL_FIXTURE_INPUT_DIR?.trim() ||
      "var/recall-fixtures/raw",
  ),
  outputDirectory: path.resolve(
    process.env.CONVO_CADDY_RECALL_FIXTURE_OUTPUT_DIR?.trim() ||
      "tests/fixtures/recall",
  ),
});

console.log(`Created ${result.files.length} redacted Recall fixtures:`);
for (const filename of result.files) {
  console.log(`- ${filename}`);
}
console.log(
  "Raw fixtures remain private beneath var/ and must not be committed.",
);
