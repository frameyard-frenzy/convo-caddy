import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactRecallFixtures } from "../../scripts/lib/recall-fixture-redactor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Recall fixture redactor", () => {
  it("preserves provider shape and identity while removing private values", () => {
    const { inputDirectory, outputDirectory } = createDirectories();
    writeJson(inputDirectory, "create-bot-private.json", {
      id: "real-bot-id",
      meeting_url:
        "https://teams.live.com/meet/1234567890123?p=private-meeting-token",
      bot_name: "Convo Caddy",
      status_changes: [
        {
          code: "joining_call",
          created_at: "2026-08-19T03:00:00.000Z",
          sub_code: null,
          message: null,
        },
      ],
    });
    writeJson(inputDirectory, "private-webhook-one.json", {
      event: "bot.joining_call",
      data: {
        data: {
          code: "joining_call",
          sub_code: null,
          updated_at: "2026-08-19T03:00:01.000000+00:00",
        },
        bot: {
          id: "real-bot-id",
          metadata: { private_customer_key: "private-metadata" },
        },
      },
    });
    writeJson(inputDirectory, "private-webhook-two.json", {
      event: "transcript.data",
      data: {
        data: {
          words: [
            {
              text: "This is Moritz's private synthetic sentence",
              start_timestamp: { relative: 1.25 },
              end_timestamp: { relative: 3.5 },
            },
          ],
          language_code: "en",
          participant: {
            id: 42,
            name: "Private Participant",
            is_host: true,
            platform: "microsoft_teams",
            extra_data: { display_name: "Private Participant" },
            email: "private@example.com",
          },
        },
        realtime_endpoint: { id: "real-endpoint-id", metadata: {} },
        transcript: { id: "real-transcript-id", metadata: {} },
        recording: { id: "real-recording-id", metadata: {} },
        bot: { id: "real-bot-id", metadata: {} },
      },
    });

    const result = redactRecallFixtures({ inputDirectory, outputDirectory });

    expect(result.files).toEqual([
      "000-create-bot-response.json",
      "001-bot-joining-call.json",
      "002-transcript-data.json",
    ]);
    const createBot = readJson(outputDirectory, result.files[0] ?? "");
    const joining = readJson(outputDirectory, result.files[1] ?? "");
    const transcript = readJson(outputDirectory, result.files[2] ?? "");

    expect(createBot).toMatchObject({
      meeting_url: "https://teams.live.com/meet/1000000000000?p=redacted",
      bot_name: "Convo Caddy",
      status_changes: [
        {
          code: "joining_call",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(joining).toMatchObject({
      event: "bot.joining_call",
      data: {
        data: { updated_at: "2026-01-01T00:00:01.000Z" },
        bot: { metadata: {} },
      },
    });
    expect(readPath(joining, "data", "bot", "id")).toBe(
      readPath(createBot, "id"),
    );
    expect(transcript).toMatchObject({
      event: "transcript.data",
      data: {
        data: {
          words: [
            {
              text: "synthetic fixture utterance 1",
              start_timestamp: { relative: 1.25 },
              end_timestamp: { relative: 3.5 },
            },
          ],
          participant: {
            id: 1001,
            name: "Speaker 1",
            is_host: true,
            platform: "microsoft_teams",
            extra_data: {},
            email: "speaker-1@example.invalid",
          },
        },
      },
    });
    expect(readPath(transcript, "data", "bot", "id")).toBe(
      readPath(createBot, "id"),
    );

    const combinedOutput = result.files
      .map((file) => readFileSync(path.join(outputDirectory, file), "utf8"))
      .join("\n");
    for (const privateValue of [
      "real-bot-id",
      "1234567890123",
      "private-meeting-token",
      "2026-08-19T03:00:00.000Z",
      "Private Participant",
      "private@example.com",
      "private-metadata",
      "Moritz's private synthetic sentence",
    ]) {
      expect(combinedOutput).not.toContain(privateValue);
    }
    expect(statSync(outputDirectory).mode & 0o777).toBe(0o700);
    for (const file of result.files) {
      expect(statSync(path.join(outputDirectory, file)).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("refuses to mix redacted fixtures with an existing output", () => {
    const { inputDirectory, outputDirectory } = createDirectories();
    writeJson(inputDirectory, "private.json", { event: "bot.done" });
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(path.join(outputDirectory, "existing.json"), "{}", "utf8");

    expect(() =>
      redactRecallFixtures({ inputDirectory, outputDirectory }),
    ).toThrow("Redacted fixture output directory must be empty");
  });

  it("fails closed before writing when an object key could contain private data", () => {
    const { inputDirectory, outputDirectory } = createDirectories();
    writeJson(inputDirectory, "private.json", {
      event: "transcript.data",
      "Private Participant": "must not become a fixture key",
    });

    expect(() =>
      redactRecallFixtures({ inputDirectory, outputDirectory }),
    ).toThrow("Unsafe provider object key");
    expect(() => readdirSync(outputDirectory)).toThrow();
  });
});

function createDirectories(): {
  inputDirectory: string;
  outputDirectory: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "recall-redactor-"));
  temporaryDirectories.push(root);
  const inputDirectory = path.join(root, "raw");
  mkdirSync(inputDirectory, { recursive: true });
  return { inputDirectory, outputDirectory: path.join(root, "redacted") };
}

function writeJson(directory: string, filename: string, value: unknown): void {
  writeFileSync(
    path.join(directory, filename),
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
}

function readJson(
  directory: string,
  filename: string,
): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(directory, filename), "utf8"));
}

function readPath(value: unknown, ...pathParts: string[]): unknown {
  let current = value;
  for (const pathPart of pathParts) {
    if (
      typeof current !== "object" ||
      current === null ||
      !(pathPart in current)
    ) {
      throw new Error(`Missing fixture path: ${pathParts.join(".")}`);
    }
    current = (current as Record<string, unknown>)[pathPart];
  }
  return current;
}
