import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRecallFixtureRecorderServer,
  type RecallFixtureRecorderOutcome,
} from "../../scripts/lib/recall-fixture-recorder.js";

const temporaryDirectories: string[] = [];
const secretBytes = Buffer.from("phase-4-fixture-recorder-secret");
const secret = `whsec_${secretBytes.toString("base64")}`;
const timestamp = "1787100000";
const verificationNow = () => new Date(Number(timestamp) * 1_000);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Recall fixture recorder", () => {
  it("stores only the exact verified body in a private file", async () => {
    const fixtureDirectory = createFixtureDirectory();
    const server = createRecallFixtureRecorderServer({
      secret,
      fixtureDirectory,
      now: verificationNow,
    });
    await listen(server);

    try {
      const body = '{"event":"transcript.data","data":{"fixture":true}}';
      const response = await send(server, "msg_real_fixture_01", body);

      expect(response.status).toBe(204);
      const files = readdirSync(fixtureDirectory);
      expect(files).toEqual(["msg_real_fixture_01.json"]);
      const fixturePath = path.join(fixtureDirectory, files[0] ?? "");
      expect(readFileSync(fixturePath, "utf8")).toBe(body);
      expect(statSync(fixtureDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(fixturePath).mode & 0o777).toBe(0o600);
    } finally {
      await close(server);
    }
  });

  it("rejects an altered body without creating a fixture", async () => {
    const fixtureDirectory = createFixtureDirectory();
    const server = createRecallFixtureRecorderServer({
      secret,
      fixtureDirectory,
      now: verificationNow,
    });
    await listen(server);

    try {
      const signedBody = '{"event":"transcript.data"}';
      const response = await send(
        server,
        "msg_invalid_fixture",
        `${signedBody} `,
        signedBody,
      );

      expect(response.status).toBe(400);
      expect(readdirSync(fixtureDirectory)).toEqual([]);
    } finally {
      await close(server);
    }
  });

  it("is idempotent for an identical delivery and rejects conflicting reuse", async () => {
    const fixtureDirectory = createFixtureDirectory();
    const server = createRecallFixtureRecorderServer({
      secret,
      fixtureDirectory,
      now: verificationNow,
    });
    await listen(server);

    try {
      const firstBody = '{"event":"transcript.data","data":{"turn":1}}';
      expect((await send(server, "msg_duplicate", firstBody)).status).toBe(204);
      expect((await send(server, "msg_duplicate", firstBody)).status).toBe(204);

      const conflictingBody = '{"event":"transcript.data","data":{"turn":2}}';
      expect(
        (await send(server, "msg_duplicate", conflictingBody)).status,
      ).toBe(409);
      expect(
        readFileSync(path.join(fixtureDirectory, "msg_duplicate.json"), "utf8"),
      ).toBe(firstBody);
    } finally {
      await close(server);
    }
  });

  it("reports only sanitized request outcomes for operator diagnostics", async () => {
    const fixtureDirectory = createFixtureDirectory();
    const outcomes: RecallFixtureRecorderOutcome[] = [];
    const server = createRecallFixtureRecorderServer({
      secret,
      fixtureDirectory,
      now: verificationNow,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    await listen(server);

    try {
      const address = server.address() as AddressInfo;
      expect(
        (
          await fetch(
            `http://127.0.0.1:${address.port}/api/capture/recall/webhook`,
          )
        ).status,
      ).toBe(404);

      const privateBody =
        '{"event":"bot.done","data":{"private_marker":"do-not-log"}}';
      expect((await send(server, "msg_observed", privateBody)).status).toBe(
        204,
      );
      expect((await send(server, "msg_observed", privateBody)).status).toBe(
        204,
      );
      expect(
        (await send(server, "msg_observed", '{"event":"bot.fatal"}')).status,
      ).toBe(409);
      expect(
        (
          await send(
            server,
            "msg_invalid_observed",
            `${privateBody} `,
            privateBody,
          )
        ).status,
      ).toBe(400);

      expect(outcomes).toEqual([
        "unexpected_request",
        "stored",
        "duplicate",
        "conflict",
        "invalid",
      ]);
      expect(JSON.stringify(outcomes)).not.toContain("do-not-log");
    } finally {
      await close(server);
    }
  });

  it("distinguishes an oversized request without exposing its body", async () => {
    const fixtureDirectory = createFixtureDirectory();
    const outcomes: RecallFixtureRecorderOutcome[] = [];
    const server = createRecallFixtureRecorderServer({
      secret,
      fixtureDirectory,
      now: verificationNow,
      maxBodyBytes: 8,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    await listen(server);

    try {
      const response = await send(
        server,
        "msg_oversized",
        '{"private_marker":"do-not-log"}',
      );

      expect(response.status).toBe(413);
      expect(outcomes).toEqual(["too_large"]);
      expect(readdirSync(fixtureDirectory)).toEqual([]);
    } finally {
      await close(server);
    }
  });
});

function createFixtureDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "convo-caddy-recall-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "fixtures");
}

async function listen(
  server: ReturnType<typeof createRecallFixtureRecorderServer>,
): Promise<void> {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
}

async function close(
  server: ReturnType<typeof createRecallFixtureRecorderServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function send(
  server: ReturnType<typeof createRecallFixtureRecorderServer>,
  webhookId: string,
  body: string,
  signedBody = body,
): Promise<Response> {
  const address = server.address() as AddressInfo;
  const signature = createHmac("sha256", secretBytes)
    .update(`${webhookId}.${timestamp}.${signedBody}`)
    .digest("base64");
  return fetch(`http://127.0.0.1:${address.port}/api/capture/recall/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    body,
  });
}
