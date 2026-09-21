import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionState } from "../helpers/session-state.js";
import {
  initializeUserWorkspace,
  publishFinishedConversation,
  readPrep,
  savePrep,
  scanFinishedConversations,
  scanPrep,
} from "../../src/server/workspace/user-workspace.js";

function temporaryWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "convo-caddy-user-workspace-"));
}

describe("user-owned workspace", () => {
  it("initializes only missing required paths and leaves unknown files alone", () => {
    const root = temporaryWorkspace();
    writeFileSync(path.join(root, "mine.txt"), "keep me");
    const initialized = initializeUserWorkspace(root);
    expect(initialized.root).toBe(root);
    expect(readFileSync(path.join(root, "mine.txt"), "utf8")).toBe("keep me");
    expect(readPrep(root, "TEMPLATE.md").prep.title).toBe("Interview prep");
  });

  it("keeps valid prep selectable beside actionable malformed errors", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    writeFileSync(
      path.join(root, "prep/current/good.json"),
      JSON.stringify({
        schemaVersion: 1,
        title: "Good",
        plannedDurationMinutes: 30,
        topics: [{ tier: "must", text: "Tell me what happened." }],
      }),
    );
    writeFileSync(path.join(root, "prep/current/bad.json"), "{");
    const result = scanPrep(root);
    expect(result.valid.map((entry) => entry.basename)).toEqual(["good.json"]);
    expect(result.errors).toEqual([
      { basename: "bad.json", error: expect.stringContaining("malformed") },
    ]);
  });

  it("preserves exact source bytes and refuses an edit after external change", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    const file = path.join(root, "prep/current/custom.json");
    const exact =
      '{ "schemaVersion": 1, "title": "Custom", "plannedDurationMinutes": 25, "topics": [{"tier":"more","text":"Why?"}] }\n';
    writeFileSync(file, exact);
    const opened = readPrep(root, "custom.json");
    expect(opened.sourceBytes).toBe(exact);
    writeFileSync(file, `${exact} `);
    expect(() =>
      savePrep(root, "custom.json", opened.prep, opened.sourceBytes),
    ).toThrow(/changed since/i);
  });

  it("publishes exactly four deterministic files, archives exact prep, and retries safely", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    const source = path.join(root, "prep/current/My Interview.json");
    const bytes =
      '{"schemaVersion":1,"title":"My interview","plannedDurationMinutes":30,"topics":[{"tier":"must","text":"Tell me."}]}\n';
    writeFileSync(source, bytes);
    const state = createSessionState({
      sessionId: "11111111-2222-4333-8444-555555555555",
      startedAt: "2026-09-04T13:14:15.000Z",
    });
    const input = {
      root,
      state,
      prepSourceFile: "My Interview.json",
      prepSourceBytes: bytes,
      completedAt: "2026-09-04T14:15:16.000Z",
    };
    const first = publishFinishedConversation(input);
    const second = publishFinishedConversation(input);
    expect(second).toEqual(first);
    expect(first.directoryName).toBe("Interview 2026-09-04-131415Z");
    expect(first.archiveFileName).toBe("Interview 2026-09-04-131415Z.json");
    expect(scanFinishedConversations(root).valid[0]?.files).toEqual([
      "manifest.json",
      "conversation.json",
      "conversation.md",
      "prep.json",
    ]);
    expect(
      readFileSync(
        path.join(root, "prep/archive", first.archiveFileName),
        "utf8",
      ),
    ).toBe(bytes);
  });

  it("resumes after final-directory publication without duplicate output", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    const bytes =
      '{"schemaVersion":1,"title":"Retry","plannedDurationMinutes":30,"topics":[{"tier":"must","text":"Tell me."}]}';
    writeFileSync(path.join(root, "prep/current/retry.json"), bytes);
    const input = {
      root,
      state: createSessionState({
        sessionId: "11111111-2222-4333-8444-666666666666",
        startedAt: "2026-09-04T13:14:15.000Z",
      }),
      prepSourceFile: "retry.json",
      prepSourceBytes: bytes,
      completedAt: "2026-09-04T14:15:16.000Z",
    };
    expect(() =>
      publishFinishedConversation(input, {
        afterFinalDirectoryPublished: () => {
          throw new Error("interrupted");
        },
      }),
    ).toThrow("interrupted");
    expect(() => publishFinishedConversation(input)).not.toThrow();
    expect(scanFinishedConversations(root).valid).toHaveLength(1);
  });

  it("does not replace an empty final directory created during publication", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    const bytes =
      '{"schemaVersion":1,"title":"Raced","plannedDurationMinutes":30,"topics":[{"tier":"must","text":"Tell me."}]}';
    writeFileSync(path.join(root, "prep/current/raced.json"), bytes);
    const input = {
      root,
      state: createSessionState({
        sessionId: "11111111-2222-4333-8444-171717171717",
        startedAt: "2026-09-04T13:14:15.000Z",
      }),
      prepSourceFile: "raced.json",
      prepSourceBytes: bytes,
      completedAt: "2026-09-04T14:15:16.000Z",
    };

    expect(() =>
      publishFinishedConversation(input, {
        beforeFinalDirectoryPublished: (directory) => mkdirSync(directory),
      }),
    ).toThrow(/collision|different name/i);
  });

  it("does not overwrite collisions and leaves externally changed current prep", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    const source = path.join(root, "prep/current/case.json");
    const bytes =
      '{"schemaVersion":1,"title":"Case","plannedDurationMinutes":30,"topics":[{"tier":"must","text":"Tell me."}]}';
    writeFileSync(source, bytes);
    const state = createSessionState({
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      startedAt: "2026-09-04T13:14:15.000Z",
    });
    const input = {
      root,
      state,
      prepSourceFile: "case.json",
      prepSourceBytes: bytes,
      completedAt: "2026-09-04T14:15:16.000Z",
    };
    const result = publishFinishedConversation(input, {
      afterFinalDirectoryPublished: () => writeFileSync(source, "changed"),
    });
    expect(readFileSync(source, "utf8")).toBe("changed");
    writeFileSync(path.join(result.directory, "prep.json"), "collision");
    expect(() => publishFinishedConversation(input)).toThrow(
      /collision|different name/i,
    );
  });

  it("rejects a finished record whose deterministic markdown was changed", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    const bytes =
      '{"schemaVersion":1,"title":"Exact","plannedDurationMinutes":30,"topics":[{"tier":"must","text":"Tell me."}]}';
    writeFileSync(path.join(root, "prep/current/exact.json"), bytes);
    const published = publishFinishedConversation({
      root,
      state: createSessionState({
        sessionId: "11111111-2222-4333-8444-141414141414",
        startedAt: "2026-09-04T13:14:15.000Z",
      }),
      prepSourceFile: "exact.json",
      prepSourceBytes: bytes,
      completedAt: "2026-09-04T14:15:16.000Z",
    });
    writeFileSync(path.join(published.directory, "conversation.md"), "changed");

    const scanned = scanFinishedConversations(root);
    expect(scanned.valid).toHaveLength(0);
    expect(scanned.errors[0]?.error).toMatch(/inconsistent/i);
  });

  it("removes an incomplete prep archive so finalization can retry", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    const bytes =
      '{"schemaVersion":1,"title":"Retry archive","plannedDurationMinutes":30,"topics":[{"tier":"must","text":"Tell me."}]}';
    writeFileSync(path.join(root, "prep/current/retry-partial.json"), bytes);
    const input = {
      root,
      state: createSessionState({
        sessionId: "11111111-2222-4333-8444-161616161616",
        startedAt: "2026-09-04T13:14:15.000Z",
      }),
      prepSourceFile: "retry-partial.json",
      prepSourceBytes: bytes,
      completedAt: "2026-09-04T14:15:16.000Z",
    };

    expect(() =>
      publishFinishedConversation(input, {
        afterArchiveOpened: (descriptor) => {
          writeFileSync(descriptor, bytes.slice(0, 1));
          throw new Error("simulated archive write failure");
        },
      }),
    ).toThrow(/simulated archive write failure/i);

    expect(() => publishFinishedConversation(input)).not.toThrow();
  });

  it("indexes a valid finished record while reporting malformed siblings", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    const bytes =
      '{"schemaVersion":1,"title":"Valid","plannedDurationMinutes":30,"topics":[{"tier":"must","text":"Tell me."}]}';
    writeFileSync(path.join(root, "prep/current/valid.json"), bytes);
    publishFinishedConversation({
      root,
      state: createSessionState({
        sessionId: "11111111-2222-4333-8444-777777777777",
        startedAt: "2026-09-04T13:14:15.000Z",
      }),
      prepSourceFile: "valid.json",
      prepSourceBytes: bytes,
      completedAt: "2026-09-04T14:15:16.000Z",
    });
    const malformed = path.join(root, "finished-conversations/broken");
    mkdirSync(malformed);
    const malformedManifest = {
      schemaVersion: 1,
      sessionId: "11111111-2222-4333-8444-888888888888",
      startedAt: "2026-09-04T13:14:15.000Z",
      completedAt: "2026-09-04T14:15:16.000Z",
      prepSourceFile: "broken.json",
      files: [
        "manifest.json",
        "conversation.json",
        "conversation.md",
        "prep.json",
      ],
    };
    writeFileSync(
      path.join(malformed, "manifest.json"),
      JSON.stringify(malformedManifest),
    );
    writeFileSync(
      path.join(malformed, "conversation.json"),
      JSON.stringify({
        schemaVersion: 1,
        completedAt: malformedManifest.completedAt,
        session: { sessionId: malformedManifest.sessionId },
      }),
    );
    writeFileSync(path.join(malformed, "conversation.md"), "broken");
    writeFileSync(path.join(malformed, "prep.json"), "{}");
    const result = scanFinishedConversations(root);
    expect(result.valid).toHaveLength(1);
    expect(result.errors.map((entry) => entry.name)).toContain("broken");
  });

  it("resumes after prep-archive publication without duplicate output", () => {
    const root = temporaryWorkspace();
    initializeUserWorkspace(root);
    const bytes =
      '{"schemaVersion":1,"title":"Retry archive","plannedDurationMinutes":30,"topics":[{"tier":"must","text":"Tell me."}]}';
    writeFileSync(path.join(root, "prep/current/retry-archive.json"), bytes);
    const input = {
      root,
      state: createSessionState({
        sessionId: "11111111-2222-4333-8444-999999999999",
        startedAt: "2026-09-04T13:14:15.000Z",
      }),
      prepSourceFile: "retry-archive.json",
      prepSourceBytes: bytes,
      completedAt: "2026-09-04T14:15:16.000Z",
    };
    expect(() =>
      publishFinishedConversation(input, {
        afterArchivePublished: () => {
          throw new Error("interrupted after archive");
        },
      }),
    ).toThrow("interrupted after archive");
    expect(() => publishFinishedConversation(input)).not.toThrow();
    expect(scanFinishedConversations(root).valid).toHaveLength(1);
  });
});

it("uses the exact human name for the record and archive, rejecting equivalent other records", () => {
  const root = temporaryWorkspace();
  initializeUserWorkspace(root);
  const state = createSessionState({
    sessionId: "11111111-2222-4333-8444-555555555555",
    startedAt: "2026-09-20T12:00:00.000Z",
  });
  state.lifecycle.displayName = "Café Team";
  const input = {
    root,
    state,
    prepSourceFile: "TEMPLATE.md",
    prepSourceBytes: readPrep(root, "TEMPLATE.md").sourceBytes,
    completedAt: "2026-09-20T14:00:00.000Z",
  };
  const result = publishFinishedConversation(input);
  expect(result.directoryName).toBe("Café Team");
  expect(result.archiveFileName).toBe("Café Team.md");
  expect(publishFinishedConversation(input)).toEqual(result);
  for (const name of ["Café Team", "CAFÉ TEAM", "Cafe\u0301 Team"]) {
    const other = structuredClone(state);
    other.sessionId = "22222222-2222-4333-8444-555555555555";
    other.lifecycle.displayName = name;
    expect(() =>
      publishFinishedConversation({ ...input, state: other }),
    ).toThrow(/different name/i);
  }
  expect(scanFinishedConversations(root).valid).toHaveLength(1);
});

it.each([
  "../escape",
  "a/b",
  "a\\b",
  ".hidden",
  "ends.",
  " leading",
  "a:b",
  "a\u0000b",
])("rejects unsafe interview name %j before publication", (name) => {
  const root = temporaryWorkspace();
  initializeUserWorkspace(root);
  const state = createSessionState({
    sessionId: "11111111-2222-4333-8444-555555555555",
    startedAt: "2026-09-20T12:00:00.000Z",
  });
  state.lifecycle.displayName = name;
  expect(() =>
    publishFinishedConversation({
      root,
      state,
      prepSourceFile: "TEMPLATE.md",
      prepSourceBytes: readPrep(root, "TEMPLATE.md").sourceBytes,
      completedAt: "2026-09-20T14:00:00.000Z",
    }),
  ).toThrow(/name/i);
  expect(scanFinishedConversations(root).valid).toHaveLength(0);
});

it("rejects a name already used by a legacy named record without migrating it", () => {
  const root = temporaryWorkspace();
  initializeUserWorkspace(root);
  const state = createSessionState({
    sessionId: "11111111-2222-4333-8444-555555555555",
    startedAt: "2026-09-20T12:00:00.000Z",
  });
  state.lifecycle.displayName = "Legacy café";
  const input = {
    root,
    state,
    prepSourceFile: "TEMPLATE.md",
    prepSourceBytes: readPrep(root, "TEMPLATE.md").sourceBytes,
    completedAt: "2026-09-20T14:00:00.000Z",
  };
  const legacy = publishFinishedConversation({ ...input, legacyNames: true });
  const other = structuredClone(state);
  other.sessionId = "22222222-2222-4333-8444-555555555555";
  expect(() => publishFinishedConversation({ ...input, state: other })).toThrow(
    /different name/i,
  );
  expect(
    scanFinishedConversations(root).valid.map((record) => record.name),
  ).toEqual([legacy.directoryName]);
});
