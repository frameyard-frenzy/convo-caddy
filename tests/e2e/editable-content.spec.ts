import { closeWindowForQuit } from "../../src/desktop/close-window.js";
import { NavigationPolicy } from "../../src/desktop/window-security.js";
import { startDesktopApplication } from "../../src/desktop/application.js";
import { LocalApiAccess } from "../../src/server/security/local-api-access.js";
import { test as base, expect } from "@playwright/test";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createApp } from "../../src/server/app.js";
import { SessionService } from "../../src/server/session-service.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import {
  initializeUserWorkspace,
  publishFinishedConversation,
  scanFinishedConversations,
} from "../../src/server/workspace/user-workspace.js";

const evidence =
  process.env.CADDY_EDITABLE_EVIDENCE_DIR ?? "test-results/caddy-inline";
const source =
  "# Synthetic interview\nDuration: 25 minutes\n## Must\n- What changed?\n## More Avenues\n- Who helped?\n";
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const test = base.extend<{
  legacyTitleLength: number;
  prep: {
    service: SessionService;
    root: string;
    repository: FileSessionRepository;
    provider: FakeMartyProvider;
    polls: () => number;
    holdEvents: () => () => void;
    observeTransport: (record: (event: string, data?: unknown) => void) => void;
  };
}>({
  legacyTitleLength: [0, { option: true }],
  prep: async ({ page, legacyTitleLength }, use) => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-inline-"));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    initializeUserWorkspace(workspace);
    writeFileSync(path.join(workspace, "prep/current/practice.md"), source);
    if (legacyTitleLength) {
      const checkpoint = JSON.parse(
        readFileSync(
          "tests/fixtures/workspace/legacy-active-session.json",
          "utf8",
        ),
      );
      expect(checkpoint.state.humanContext).toBeUndefined();
      checkpoint.workspace.workspaceRoot = workspace;
      checkpoint.workspace.prep.title = "T".repeat(legacyTitleLength);
      checkpoint.workspace.prep.plannedDurationMinutes = 481;
      checkpoint.workspace.prepSourceFile = "legacy.json";
      checkpoint.workspace.prepSourceBytes = JSON.stringify(
        checkpoint.workspace.prep,
      );
      writeFileSync(
        path.join(workspace, "prep/current/legacy.json"),
        checkpoint.workspace.prepSourceBytes,
      );
      mkdirSync(path.join(root, "private"));
      writeFileSync(
        path.join(root, "private/active-session.json"),
        JSON.stringify(checkpoint),
      );
    }
    const repository = new FileSessionRepository(path.join(root, "private"));
    const provider = new FakeMartyProvider();
    const service = new SessionService({
      topics: [],
      transcript: [],
      provider,
      repository,
      userWorkspaceRoot: workspace,
      initialCaptureMode: "live_ready",
      captureProvider: {
        region: "us-west-2",
        createBot: async () => ({ botId: "synthetic" }),
        stopRecordingNotice: async () => {},
      },
    });
    if (!legacyTitleLength) service.selectPrep("practice.md");
    let heldEvents: Array<() => void> | null = null;
    const subscribe = service.subscribe.bind(service);
    service.subscribe = (listener) =>
      subscribe((state) => {
        if (heldEvents) heldEvents.push(() => listener(state));
        else listener(state);
      });
    const holdEvents = () => {
      heldEvents = [];
      return () => {
        const events = heldEvents ?? [];
        heldEvents = null;
        for (const deliver of events) deliver();
      };
    };
    await page.addInitScript(() => {
      const Original = window.EventSource;
      window.EventSource = class extends Original {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          this.addEventListener("session", (event) => {
            queueMicrotask(() => {
              (window as unknown as { seenRevision: number }).seenRevision =
                JSON.parse(event.data).contentRevision ?? 0;
            });
          });
        }
      };
    });
    let polls = 0;
    const app = createApp({
      service,
      readiness: () => {
        polls++;
        return null;
      },
    });
    app.use(express.static(path.resolve("dist/client")));
    let transport: ((event: string, data?: unknown) => void) | undefined;
    let requestOrdinal = 0;
    const editContent = service.editContent;
    service.editContent = function (this: SessionService, value: unknown) {
      transport?.("service-edit-entry", {
        revision: this.getSnapshot().contentRevision,
      });
      try {
        const result = editContent.call(this, value);
        transport?.("service-edit-return", {
          revision: result.contentRevision,
        });
        return result;
      } catch (error) {
        transport?.("service-edit-throw", {
          revision: this.getSnapshot().contentRevision,
        });
        throw error;
      }
    };
    const server = createServer((req, res) => {
      if (
        transport &&
        req.method === "POST" &&
        ["/api/session/content", "/api/session/save"].includes(req.url ?? "")
      ) {
        const metadata = {
          ordinal: ++requestOrdinal,
          method: req.method,
          path: req.url,
        };
        transport("node-entry", metadata);
        res.once("finish", () =>
          transport?.("node-finish", { ...metadata, status: res.statusCode }),
        );
        res.once("close", () =>
          transport?.("node-close", { ...metadata, status: res.statusCode }),
        );
      }
      app(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No address");
    try {
      await page.goto(`http://127.0.0.1:${address.port}`);
      await expect(page.locator("#choose-prep")).toBeEnabled();
      await use({
        service,
        root,
        repository,
        provider,
        polls: () => polls,
        holdEvents,
        observeTransport: (record) => {
          transport = record;
        },
      });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.goto("about:blank");
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
});

async function ask(
  page: import("@playwright/test").Page,
  input = "/note Command observation",
) {
  await page.getByLabel("Command or question", { exact: true }).fill(input);
  await page.getByRole("button", { name: "Submit", exact: true }).click();
}

test("same cards, no editing controls; empty and filled surfaces type directly, Enter/paste make automatic lists", async ({
  page,
  prep,
}) => {
  await expect(
    page.getByRole("button", {
      name: /^(Add|Edit|Remove|Cancel)(?: |$)/,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator(".content-editor, .content-actions")).toHaveCount(
    0,
  );
  await expect(
    page.locator(".workspace > .prepared-column > .prepared"),
  ).toHaveCount(1);
  await expect(page.locator("#choose-prep")).toHaveAttribute(
    "title",
    "Choose a markdown prep file.",
  );
  await page.screenshot({ path: `${evidence}/normal.png`, fullPage: true });
  const summary = page
    .getByRole("textbox", { name: "Person summary text", exact: true })
    .first();
  await summary.click();
  await page.screenshot({
    path: `${evidence}/empty-focused.png`,
    fullPage: true,
  });
  await summary.pressSequentially("Fictional team lead");
  await summary.press("Enter");
  await page.keyboard.insertText("Uses paper");
  await expect(page.locator(".person-summary li")).toHaveCount(2);
  const question = page
    .getByRole("textbox", { name: "Question text", exact: true })
    .first();
  await question.fill("Why now?");
  await question.press("Enter");
  await page.keyboard.insertText("Who helped?");
  await expect(page.locator(".questions input[type=checkbox]")).toHaveCount(2);
  const topic = page
    .getByRole("textbox", { name: "Prepared question text", exact: true })
    .first();
  await topic.fill("Revised prompt");
  await page.locator(".prepared input[type=checkbox]").first().check();
  await expect(topic).toHaveText("Revised prompt");
  await expect
    .poll(() => prep.service.getSnapshot().topics[0]?.checked)
    .toBe(true);
  await page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first()
    .evaluate((el) => {
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      event.clipboardData!.setData("text/plain", "- One\n- [ ] Two");
      el.dispatchEvent(event);
    });
  await expect(page.locator(".notes li")).toHaveCount(2);
  await page
    .getByRole("textbox", { name: "Interview title", exact: true })
    .fill("Revised synthetic title");
  const minutes = page.getByRole("textbox", {
    name: "Planned minutes",
    exact: true,
  });
  await minutes.fill("");
  const polls = prep.polls();
  await expect.poll(() => prep.polls()).toBeGreaterThan(polls);
  await expect(minutes).toHaveText("");
  await minutes.fill("45");
  await page
    .getByRole("textbox", {
      name: "Saved interview name (optional)",
      exact: true,
    })
    .fill("Synthetic practice");
  await ask(page);
  await expect
    .poll(() => prep.service.getSnapshot().notes.map((x) => x.text))
    .toEqual(["One", "Two", "Command observation"]);
  expect(prep.service.getProviderCallCount()).toBe(0);
  await expect
    .poll(() => prep.service.getSnapshot().humanContext)
    .toMatchObject({
      title: "Revised synthetic title",
      plannedDurationMinutes: 45,
    });
  expect(prep.service.getSnapshot().lifecycle.displayName).toBe(
    "Synthetic practice",
  );
  await page.screenshot({ path: `${evidence}/filled.png`, fullPage: true });
  await topic.focus();
  await page.screenshot({ path: `${evidence}/focused.png`, fullPage: true });
  expect(await topic.evaluate((el) => getComputedStyle(el).outlineOffset)).toBe(
    "0px",
  );
  await expect(topic).toHaveCSS("outline-style", "solid");
  await page
    .locator(".prepared")
    .screenshot({ path: `${evidence}/focus-text-detail.png` });
  const checkbox = page.locator(".prepared input").first();
  await page.keyboard.press("Tab");
  await checkbox.focus();
  expect(
    await checkbox.evaluate((el) => getComputedStyle(el).outlineOffset),
  ).toBe("0px");
  await expect(checkbox).toHaveCSS("outline-style", "solid");
  await page
    .locator(".prepared")
    .screenshot({ path: `${evidence}/focus-checkbox-detail.png` });
  const metadata = page.getByRole("textbox", {
    name: "Interview title",
    exact: true,
  });
  await metadata.focus();
  expect(
    await metadata.evaluate((el) => getComputedStyle(el).outlineOffset),
  ).toBe("0px");
  await expect(metadata).toHaveCSS("outline-style", "solid");
  await page
    .locator(".workspace-prep")
    .screenshot({ path: `${evidence}/focus-metadata-detail.png` });
  await topic.focus();
  await page.setViewportSize({ width: 640, height: 900 });
  await page.screenshot({ path: `${evidence}/narrow.png`, fullPage: true });
  await page.reload();
  await expect(page.locator(".person-summary li")).toHaveCount(2);
  await expect(
    page.locator(".prepared input[type=checkbox]").first(),
  ).toBeChecked();
});

test("type then Ask flushes exact edited context, pending acknowledgements never drop newer typing or SSE additions", async ({
  page,
  prep,
}) => {
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  await note.fill("First revision");
  const ready = gate(),
    release = gate();
  let requests = 0;
  await page.route("**/api/session/content", async (route) => {
    requests++;
    if (requests > 1) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    ready.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    const contexts: unknown[] = [];
    const original = prep.provider.ask.bind(prep.provider);
    prep.provider.ask = async (question, context) => {
      contexts.push(context);
      return original(question, context);
    };
    await ask(page, "What matters?");
    await ready.promise;
    await note.fill("Latest revision");
    await note.press("ArrowLeft");
    await note.evaluate((el) => {
      (window as unknown as { activeEdit: Element }).activeEdit = el;
    });
    const selection = await page.evaluate(
      () => document.getSelection()?.anchorOffset,
    );
    prep.service.editContent({
      sessionId: prep.service.getSnapshot().sessionId,
      revision: prep.service.getSnapshot().contentRevision ?? 0,
      mutationId: "background",
      section: "notes",
      text: "Background observation",
    });
    await expect(page.locator(".notes")).toContainText(
      "Background observation",
    );
    await expect(note).toBeFocused();
    expect(
      await note.evaluate(
        (el) =>
          el === (window as unknown as { activeEdit: Element }).activeEdit,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.getSelection()?.anchorOffset),
    ).toBe(selection);
    release.resolve();
    await expect.poll(() => contexts.length).toBe(1);
    expect(JSON.stringify(contexts)).toContain("Latest revision");
    expect(JSON.stringify(contexts)).toContain("Background observation");
    await expect(note).toHaveText("Latest revision");
    const checkpoint = readFileSync(
      path.join(prep.root, "private/active-session.json"),
      "utf8",
    );
    expect(checkpoint).toContain("Latest revision");
  } finally {
    release.resolve();
  }
});

for (const action of ["ask", "finish"] as const)
  test(`failed flush blocks ${action}, retains draft, retry writes exact finished files`, async ({
    page,
    prep,
  }) => {
    if (action === "finish")
      await prep.service.startRecallCapture({
        meetingUrl: "https://teams.live.com/meet/123456789",
      });
    const note = page
      .getByRole("textbox", { name: "Note text", exact: true })
      .first();
    await note.fill("Exact final observation");
    const original = prep.repository.save.bind(prep.repository);
    prep.repository.save = (state, receipts) => {
      if (state.notes.some((n) => n.text === "Exact final observation"))
        throw Error("Synthetic disk full");
      return original(state, receipts);
    };
    let downstream = 0;
    page.on("request", (request) => {
      if (/\/api\/(input|session\/finish-saving)/.test(request.url()))
        downstream++;
    });
    if (action === "ask") await ask(page, "What matters?");
    else endCapture(prep.service);
    await expect(page.getByRole("alert")).toContainText("Synthetic disk full");
    await expect(note).toHaveText("Exact final observation");
    expect(downstream).toBe(0);
    expect(prep.service.getProviderCallCount()).toBe(0);
    prep.repository.save = original;
    if (action === "ask") {
      await ask(page, "What matters?");
      await expect
        .poll(() => prep.service.getSnapshot().notes[0]?.text)
        .toBe("Exact final observation");
      return;
    }
    await page
      .getByRole("button", { name: "Finish saving", exact: true })
      .click();
    await expect
      .poll(
        () =>
          scanFinishedConversations(path.join(prep.root, "workspace")).valid
            .length,
      )
      .toBe(1);
    const finished = scanFinishedConversations(
      path.join(prep.root, "workspace"),
    ).valid[0]!;
    expect(JSON.stringify(finished.conversation)).toContain(
      "Exact final observation",
    );
    const directory = path.join(
      prep.root,
      "workspace/finished-conversations",
      finished.name,
    );
    expect(
      readFileSync(path.join(directory, "conversation.md"), "utf8"),
    ).toContain("Exact final observation");
    expect(readFileSync(path.join(directory, "prep.md"), "utf8")).toBe(source);
  });

test("IME DOM survives background updates, deletion and Backspace merge preserve original identity", async ({
  page,
  prep,
}) => {
  const topic = page
    .getByRole("textbox", { name: "Prepared question text", exact: true })
    .first();
  await topic.focus();
  await topic.dispatchEvent("compositionstart");
  await topic.fill("Composing text");
  prep.service.setTopicChecked("prep-1", true);
  await expect(topic).toHaveText("Composing text");
  await expect(topic).toBeFocused();
  await topic.dispatchEvent("compositionend");
  await topic.press("End");
  await topic.press("Enter");
  await page.keyboard.insertText("Next line");
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await ask(page);
  await expect
    .poll(() => prep.service.getSnapshot().topics[0])
    .toMatchObject({
      id: "prep-1",
      checked: true,
      text: "Composing textNext line",
    });
  await topic.fill("");
  await ask(page);
  await expect
    .poll(() =>
      prep.service.getSnapshot().topics.some((x) => x.id === "prep-1"),
    )
    .toBe(false);
});

for (const length of [239, 110000])
  test.describe(`legacy title ${length}`, () => {
    test.use({ legacyTitleLength: length });
    test("actual old checkpoint hydrates, partial metadata edits persist unchanged boundaries and export", async ({
      page,
      prep,
    }) => {
      const title = page.getByRole("textbox", {
        name: "Interview title",
        exact: true,
      });
      const minutes = page.getByRole("textbox", {
        name: "Planned minutes",
        exact: true,
      });
      await expect(title).toHaveText("T".repeat(length));
      await expect(minutes).toHaveText("481");
      await page
        .getByRole("textbox", {
          name: "Saved interview name (optional)",
          exact: true,
        })
        .fill("New saved name");
      let request = page.waitForRequest("**/api/session/content");
      await ask(page);
      expect(JSON.parse((await request).postDataJSON().text)).toEqual({
        displayName: "New saved name",
      });
      await expect
        .poll(() => prep.service.getSnapshot().lifecycle.displayName)
        .toBe("New saved name");
      await page.reload();
      await expect(title).toHaveText("T".repeat(length));
      await expect(minutes).toHaveText("481");
      await minutes.fill("");
      const before = prep.polls();
      await expect.poll(() => prep.polls()).toBeGreaterThan(before);
      await expect(minutes).toHaveText("");
      await minutes.fill("40");
      request = page.waitForRequest("**/api/session/content");
      await ask(page);
      expect(JSON.parse((await request).postDataJSON().text)).toEqual({
        plannedDurationMinutes: 40,
      });
      await expect
        .poll(
          () => prep.service.getSnapshot().humanContext?.plannedDurationMinutes,
        )
        .toBe(40);
      const saved = new FileSessionRepository(
        path.join(prep.root, "private"),
      ).load()!.state;
      expect(saved.humanContext?.title).toBe("T".repeat(length));
      expect(saved.lifecycle.displayName).toBe("New saved name");
      await prep.service.startRecallCapture({
        meetingUrl: "https://teams.live.com/meet/123456789",
      });
      endCapture(prep.service);
      await expect
        .poll(
          () =>
            scanFinishedConversations(path.join(prep.root, "workspace")).valid
              .length,
        )
        .toBe(1);
      expect(
        scanFinishedConversations(path.join(prep.root, "workspace")).valid[0]!
          .conversation.session.humanContext?.title,
      ).toBe("T".repeat(length));
    });
  });

function endCapture(service: SessionService) {
  for (const milestone of [
    "call_ended",
    "transcript_done",
    "bot_done",
  ] as const)
    service.ingestRecallLifecycle({
      botId: "synthetic",
      recordingId: "synthetic-recording",
      status: "ended",
      milestone,
      occurredAt: "2026-09-16T00:00:00.000Z",
    });
}

test("capture refresh keeps the stale inline draft and caret, refusing to overwrite positional IDs", async ({
  page,
  prep,
}) => {
  const topic = page
    .getByRole("textbox", { name: "Prepared question text", exact: true })
    .first();
  await topic.fill("My unsaved question");
  await topic.press("ArrowLeft");
  const offset = await page.evaluate(() => window.getSelection()?.anchorOffset);
  writeFileSync(
    path.join(prep.root, "workspace/prep/current/practice.md"),
    "# Refreshed prep\nDuration: 40 minutes\n## Must\n- New question from prep?",
  );
  expect(
    await prep.service.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789",
    }),
  ).toMatchObject({ ok: true });
  await expect(
    page.getByRole("textbox", { name: "Interview title", exact: true }),
  ).toHaveText("Refreshed prep");
  await expect(topic).toHaveText("My unsaved question");
  await expect(topic).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.anchorOffset)).toBe(
    offset,
  );
  await ask(page, "What matters?");
  await expect(page.getByRole("alert")).toContainText(
    "Interview content changed. Your draft was kept",
  );
  expect(prep.provider.invocationCount).toBe(0);
  expect(prep.service.getSnapshot().topics[0]?.text).toBe(
    "New question from prep?",
  );
  await expect(topic).toHaveText("My unsaved question");
  await topic.press("Escape");
  await expect(topic).toHaveText("New question from prep?");
});

test("provider completion flushes drafts, waits for composition and includes later typing before its acknowledgement", async ({
  page,
  prep,
}) => {
  await prep.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  await note.focus();
  await note.dispatchEvent("compositionstart");
  await note.fill("First composed observation");
  const ready = gate(),
    release = gate();
  let requests = 0;
  await page.route("**/api/session/content", async (route) => {
    requests++;
    if (requests > 1) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    ready.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    endCapture(prep.service);
    await expect(
      page.getByRole("button", { name: "Finish saving", exact: true }),
    ).toBeVisible();
    expect(
      scanFinishedConversations(path.join(prep.root, "workspace")).valid,
    ).toHaveLength(0);
    await expect(note).toBeFocused();
    await note.dispatchEvent("compositionend");
    await ready.promise;
    await note.fill("Latest composed observation");
    release.resolve();
    await expect
      .poll(
        () =>
          scanFinishedConversations(path.join(prep.root, "workspace")).valid
            .length,
      )
      .toBe(1);
    const record = scanFinishedConversations(path.join(prep.root, "workspace"))
      .valid[0]!;
    expect(record.conversation.session.notes[0]?.text).toBe(
      "Latest composed observation",
    );
    expect(
      readFileSync(
        path.join(
          prep.root,
          "workspace/finished-conversations",
          record.name,
          "conversation.md",
        ),
        "utf8",
      ),
    ).toContain("Latest composed observation");
    expect(
      readFileSync(
        path.join(
          prep.root,
          "workspace/finished-conversations",
          record.name,
          "prep.md",
        ),
        "utf8",
      ),
    ).toBe(source);
    expect(prep.provider.invocationCount).toBe(0);
  } finally {
    release.resolve();
  }
});

test("every explicit assistant command flushes exact human content without replacing references or checked states", async ({
  page,
  prep,
}) => {
  const revisit = page
    .getByRole("textbox", { name: "Revisit text", exact: true })
    .first();
  await revisit.fill("Return to earlier example");
  await ask(page, "/note Initial observation");
  await expect.poll(() => prep.service.getSnapshot().revisit.length).toBe(1);
  const old = prep.service.getSnapshot().revisit[0]!;
  await page.locator(".revisit input").check();
  await revisit.fill("Revised earlier example");
  const contexts: unknown[] = [];
  const original = prep.provider.requestQuestion.bind(prep.provider);
  prep.provider.requestQuestion = async (hint, context) => {
    contexts.push(context);
    return original(hint, context);
  };
  await ask(page, "/question why now");
  await expect.poll(() => contexts.length).toBe(1);
  expect(JSON.stringify(contexts)).toContain("Revised earlier example");
  expect(prep.service.getSnapshot().revisit[0]).toEqual({
    ...old,
    text: "Revised earlier example",
    checked: true,
    humanEdited: true,
  });
  await revisit.fill("");
  await ask(page, "/note Another observation");
  await expect.poll(() => prep.service.getSnapshot().revisit.length).toBe(0);
});

test("a delayed assistant response retains newer typing, checkbox state and unrelated SSE content", async ({
  page,
  prep,
}) => {
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  await note.fill("Saved before ask");
  const ready = gate(),
    release = gate();
  await page.route(
    "**/api/input",
    async (route) => {
      const response = await route.fetch();
      ready.resolve();
      await release.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await ask(page, "What matters?");
  await ready.promise;
  await note.fill("Typing after the question");
  prep.service.setTopicChecked("prep-1", true);
  prep.service.editContent({
    sessionId: prep.service.getSnapshot().sessionId,
    revision: prep.service.getSnapshot().contentRevision ?? 0,
    mutationId: "after-ask",
    section: "notes",
    text: "Newer background note",
  });
  await expect(page.locator(".notes")).toContainText("Newer background note");
  release.resolve();
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".notes")).toContainText("Newer background note");
  await expect(page.locator(".prepared input").first()).toBeChecked();
  await expect(note).toHaveText("Typing after the question");
  await ask(page, "/note Final command");
  await expect
    .poll(() => prep.service.getSnapshot().notes.map((n) => n.text))
    .toEqual([
      "Typing after the question",
      "Newer background note",
      "Final command",
    ]);
});

test("composition begun during a pending flush delays automatic export until its final text", async ({
  page,
  prep,
}) => {
  await prep.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  await note.fill("Before composition");
  const ready = gate(),
    release = gate();
  let requests = 0;
  await page.route("**/api/session/content", async (route) => {
    requests++;
    if (requests > 1) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    ready.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    endCapture(prep.service);
    await ready.promise;
    await note.dispatchEvent("compositionstart");
    await note.fill("Intermediate composing text");
    release.resolve();
    // A readiness round trip establishes that the response had time to arrive.
    const polls = prep.polls();
    await expect.poll(() => prep.polls()).toBeGreaterThan(polls);
    expect(
      scanFinishedConversations(path.join(prep.root, "workspace")).valid,
    ).toHaveLength(0);
    await note.fill("Final composed text");
    await note.dispatchEvent("compositionend");
    await expect
      .poll(
        () =>
          scanFinishedConversations(path.join(prep.root, "workspace")).valid
            .length,
      )
      .toBe(1);
    expect(
      scanFinishedConversations(path.join(prep.root, "workspace")).valid[0]
        ?.conversation.session.notes[0]?.text,
    ).toBe("Final composed text");
  } finally {
    release.resolve();
  }
});

test("Backspace merge can be undone before flushing, and empty card space adds an automatic row", async ({
  page,
  prep,
}) => {
  const question = page
    .getByRole("textbox", { name: "Question text", exact: true })
    .first();
  await question.fill("First");
  await question.press("Enter");
  await page.keyboard.insertText("Second");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".questions li")).toHaveCount(1);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(page.locator(".questions li")).toHaveCount(2);
  await expect(
    page.getByRole("textbox", { name: "Question text", exact: true }).nth(1),
  ).toHaveText("Second");
  const notes = page.locator(".notes");
  const bounds = (await notes.boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width - 8,
    bounds.y + bounds.height - 8,
  );
  await page.keyboard.insertText("Card space observation");
  await ask(page, "/note Command observation");
  await expect
    .poll(() => prep.service.getSnapshot().questions.map((q) => q.text))
    .toEqual(["First", "Second"]);
  await expect
    .poll(() => prep.service.getSnapshot().notes[0]?.text)
    .toBe("Card space observation");
});

test("automatic export waits for an already requested checkbox write", async ({
  page,
  prep,
}) => {
  await prep.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  const ready = gate(),
    release = gate();
  await page.route(
    "**/api/session/topics/prep-1/check",
    async (route) => {
      ready.resolve();
      await release.promise;
      await route.continue();
    },
    { times: 1 },
  );
  await page.locator(".prepared input").first().check();
  await ready.promise;
  endCapture(prep.service);
  const polls = prep.polls();
  await expect.poll(() => prep.polls()).toBeGreaterThan(polls);
  expect(
    scanFinishedConversations(path.join(prep.root, "workspace")).valid,
  ).toHaveLength(0);
  release.resolve();
  await expect
    .poll(
      () =>
        scanFinishedConversations(path.join(prep.root, "workspace")).valid
          .length,
    )
    .toBe(1);
  expect(
    scanFinishedConversations(path.join(prep.root, "workspace")).valid[0]
      ?.conversation.session.topics[0]?.checked,
  ).toBe(true);
});

test("a capture refresh changing only metadata still invalidates an existing prep draft", async ({
  page,
  prep,
}) => {
  const topic = page
    .getByRole("textbox", { name: "Prepared question text", exact: true })
    .first();
  await topic.fill("Unsaved before refresh");
  writeFileSync(
    path.join(prep.root, "workspace/prep/current/practice.md"),
    source.replace("Synthetic interview", "Changed title"),
  );
  await prep.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  await expect(
    page.getByRole("textbox", { name: "Interview title", exact: true }),
  ).toHaveText("Changed title");
  await ask(page, "What matters?");
  await expect(page.getByRole("alert")).toContainText(
    "Interview content changed. Your draft was kept",
  );
  expect(prep.provider.invocationCount).toBe(0);
  await expect(topic).toHaveText("Unsaved before refresh");
  expect(prep.service.getSnapshot().topics[0]?.text).toBe("What changed?");
});

test("capture uses the latest saved-name edit across its original field and inline metadata", async ({
  page,
  prep,
}) => {
  await page
    .getByLabel("Interview name (optional)", { exact: true })
    .fill("Earlier capture name");
  await page
    .getByRole("textbox", {
      name: "Saved interview name (optional)",
      exact: true,
    })
    .fill("Latest inline name");
  await page
    .getByLabel("Personal Microsoft Teams meeting link", { exact: true })
    .fill("https://teams.live.com/meet/123456789");
  await page
    .getByRole("button", { name: "Start live capture", exact: true })
    .click();
  await expect
    .poll(() => prep.service.getSnapshot().capture.mode)
    .toBe("recall");
  expect(prep.service.getSnapshot().lifecycle.displayName).toBe(
    "Latest inline name",
  );
});

test("Enter before existing text preserves that question's identity and checked state", async ({
  page,
  prep,
}) => {
  prep.service.setTopicChecked("prep-1", true);
  await expect(page.locator(".prepared input").first()).toBeChecked();
  const topic = page
    .getByRole("textbox", { name: "Prepared question text", exact: true })
    .first();
  await topic.fill("What changed?");
  for (let i = 0; i < "What changed?".length; i++)
    await topic.press("ArrowLeft");
  await topic.press("Enter");
  await ask(page, "/note After insertion");
  await expect.poll(() => prep.service.getSnapshot().notes.length).toBe(1);
  expect(prep.service.getSnapshot().topics[0]).toMatchObject({
    id: "prep-1",
    checked: true,
    text: "What changed?",
  });
});

test.describe("oversized legacy metadata draft", () => {
  test.use({ legacyTitleLength: 110000 });
  test("request byte-cap rejection retains a correctable draft and never submits stale context", async ({
    page,
    prep,
  }) => {
    const title = page.getByRole("textbox", {
      name: "Interview title",
      exact: true,
    });
    await title.fill("X".repeat(110001));
    await ask(page, "What matters?");
    await expect(page.getByRole("alert")).toBeVisible();
    expect(prep.provider.invocationCount).toBe(0);
    await expect(title).toHaveText("X".repeat(110001));
    await title.fill("Corrected title");
    await ask(page, "What matters?");
    await expect
      .poll(() => prep.service.getSnapshot().humanContext?.title)
      .toBe("Corrected title");
    await expect.poll(() => prep.provider.invocationCount).toBe(1);
  });
});

// Actual browser event ordering: stop the request before persistence, type the
// later value, then independently release the durable SSE and HTTP responses.
for (const order of ["SSE-first", "HTTP-first"] as const) {
  for (const field of [
    "Prepared question text",
    "Question text",
    "Interview title",
  ] as const) {
    test(`review undo ${field} survives ${order} acknowledgement`, async ({
      page,
      prep,
    }) => {
      const target = page
        .getByRole("textbox", { name: field, exact: true })
        .first();
      if (field === "Question text") {
        await target.fill("Original question A");
        await ask(page);
        await expect
          .poll(() => prep.service.getSnapshot().questions.length)
          .toBe(1);
        // Finish the setup submission before intercepting the next edit's HTTP.
        await expect(
          page.getByLabel("Command or question", { exact: true }),
        ).toBeEnabled();
      }
      const initial = await target.innerText();
      const arrived = gate(),
        send = gate(),
        saved = gate(),
        http = gate(),
        nextSend = gate();
      let requests = 0;
      const releaseEvents =
        order === "HTTP-first" ? prep.holdEvents() : () => {};
      await page.route("**/api/session/content", async (route) => {
        requests++;
        if (requests === 1) {
          arrived.resolve();
          await send.promise;
          const response = await route.fetch();
          saved.resolve();
          await http.promise;
          await route.fulfill({ response });
        } else {
          await nextSend.promise;
          await route.continue();
        }
      });
      const contexts: unknown[] = [];
      const original = prep.provider.ask.bind(prep.provider);
      prep.provider.ask = async (question, context) => {
        contexts.push(context);
        return original(question, context);
      };
      try {
        await target.fill("Submitted B");
        await ask(page, "What matters?");
        await arrived.promise;
        await target.fill(initial);
        send.resolve();
        await saved.promise;
        if (order === "HTTP-first") {
          http.resolve();
          await expect.poll(() => requests).toBe(2);
          releaseEvents();
        }
        const revision = prep.service.getSnapshot().contentRevision ?? 0;
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as { seenRevision: number }).seenRevision,
            ),
          )
          .toBe(revision);
        await expect(target).toHaveText(initial);
        http.resolve();
        nextSend.resolve();
        await expect.poll(() => contexts.length).toBe(1);
        expect(JSON.stringify(contexts)).toContain(initial);
        expect(JSON.stringify(contexts)).not.toContain("Submitted B");
        const checkpoint = JSON.parse(
          readFileSync(
            path.join(prep.root, "private/active-session.json"),
            "utf8",
          ),
        );
        expect(
          field === "Interview title"
            ? checkpoint.state.humanContext.title
            : field === "Question text"
              ? checkpoint.state.questions[0].text
              : checkpoint.state.topics[0].text,
        ).toBe(initial);
        await expect(target).toHaveText(initial);
      } finally {
        send.resolve();
        http.resolve();
        nextSend.resolve();
        releaseEvents();
      }
    });
  }
}

test("review own deletion cancels its queued check after validation failure and permits Ask and manual Finish", async ({
  page,
  prep,
}) => {
  await prep.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  const duration = page.getByRole("textbox", {
    name: "Planned minutes",
    exact: true,
  });
  const topic = page
    .getByRole("textbox", { name: "Prepared question text", exact: true })
    .first();
  const removedId = prep.service.getSnapshot().topics[0]!.id;
  await duration.fill("0");
  await page.locator(".prepared input[type=checkbox]").first().check();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(prep.service.getSnapshot().topics[0]?.checked).toBe(false);
  await duration.fill("30");
  await topic.fill("");
  const original = prep.repository.save.bind(prep.repository);
  prep.repository.save = (state, receipts) => {
    if (!state.topics.some((t) => t.id === removedId))
      throw Error("Synthetic deletion failure");
    return original(state, receipts);
  };
  await ask(page, "What matters?");
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic deletion failure",
  );
  await expect(topic).toHaveText("");
  await expect(
    page.locator(".prepared input[type=checkbox]").first(),
  ).toBeChecked();
  expect(
    prep.service.getSnapshot().topics.some((t) => t.id === removedId),
  ).toBe(true);
  expect(prep.provider.invocationCount).toBe(0);
  prep.repository.save = original;
  await ask(page, "What matters?");
  await expect.poll(() => prep.provider.invocationCount).toBe(1);
  expect(
    prep.service.getSnapshot().topics.some((t) => t.id === removedId),
  ).toBe(false);
  prep.repository.save = (state, receipts) => {
    if (!state.contentFlushRequired)
      throw Error("Synthetic final barrier failure");
    return original(state, receipts);
  };
  endCapture(prep.service);
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic final barrier failure",
  );
  prep.repository.save = original;
  await page
    .getByRole("button", { name: "Finish saving", exact: true })
    .click();
  await expect
    .poll(
      () =>
        scanFinishedConversations(path.join(prep.root, "workspace")).valid
          .length,
    )
    .toBe(1);
  expect(
    scanFinishedConversations(
      path.join(prep.root, "workspace"),
    ).valid[0]!.conversation.session.topics.some((t) => t.id === removedId),
  ).toBe(false);
});

for (const order of ["SSE-first", "HTTP-first"] as const)
  for (const section of ["topics", "questions"] as const)
    test(`review replacement ${section} during own deletion survives ${order} and automatic export`, async ({
      page,
      prep,
    }) => {
      await prep.service.startRecallCapture({
        meetingUrl: "https://teams.live.com/meet/123456789",
      });
      const target = page
        .getByRole("textbox", {
          name:
            section === "topics" ? "Prepared question text" : "Question text",
          exact: true,
        })
        .first();
      if (section === "questions") {
        await target.fill("Original marked question");
        await ask(page);
        await expect
          .poll(() => prep.service.getSnapshot().questions.length)
          .toBe(1);
      }
      await page
        .locator(
          `${section === "topics" ? ".prepared" : ".questions"} input[type=checkbox]`,
        )
        .first()
        .check();
      await expect
        .poll(() => prep.service.getSnapshot()[section][0]?.checked)
        .toBe(true);
      const old = prep.service.getSnapshot()[section][0]!;
      const arrived = gate(),
        send = gate(),
        saved = gate(),
        http = gate(),
        nextSend = gate();
      let requests = 0;
      const releaseEvents =
        order === "HTTP-first" ? prep.holdEvents() : () => {};
      await page.route("**/api/session/content", async (route) => {
        requests++;
        if (requests === 1) {
          expect(route.request().postDataJSON()).toMatchObject({
            id: old.id,
            remove: true,
          });
          arrived.resolve();
          await send.promise;
          const response = await route.fetch();
          saved.resolve();
          await http.promise;
          await route.fulfill({ response });
        } else {
          await nextSend.promise;
          await route.continue();
        }
      });
      try {
        await target.fill("");
        endCapture(prep.service);
        // HTTP-first holds terminal events too: let those start auto finalization,
        // then hold only the deletion event before its request reaches the server.
        if (order === "HTTP-first") {
          releaseEvents();
        }
        await arrived.promise;
        const releaseDeletion =
          order === "HTTP-first" ? prep.holdEvents() : () => {};
        await target.fill("Replacement after explicit deletion");
        send.resolve();
        await saved.promise;
        if (order === "HTTP-first") {
          http.resolve();
          await expect.poll(() => requests).toBe(2);
          releaseDeletion();
        }
        const revision = prep.service.getSnapshot().contentRevision ?? 0;
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as { seenRevision: number }).seenRevision,
            ),
          )
          .toBe(revision);
        await expect(target).toHaveText("Replacement after explicit deletion");
        http.resolve();
        nextSend.resolve();
        await expect
          .poll(
            () =>
              scanFinishedConversations(path.join(prep.root, "workspace")).valid
                .length,
          )
          .toBe(1);
        const topics = scanFinishedConversations(
          path.join(prep.root, "workspace"),
        ).valid[0]!.conversation.session[section];
        expect(topics.some((t) => t.id === old.id)).toBe(false);
        expect(topics[0]).toMatchObject({
          text: "Replacement after explicit deletion",
          checked: false,
          ...("tier" in old ? { tier: old.tier } : {}),
        });
        expect(topics[0]!.id).not.toBe(old.id);
        expect(prep.provider.invocationCount).toBe(0);
      } finally {
        send.resolve();
        http.resolve();
        nextSend.resolve();
        releaseEvents();
      }
    });

test("review competing removal does not cancel an unrelated queued check", async ({
  page,
  prep,
}) => {
  const duration = page.getByRole("textbox", {
    name: "Planned minutes",
    exact: true,
  });
  await duration.fill("0");
  await page.locator(".prepared input[type=checkbox]").first().check();
  await expect(page.getByRole("alert")).toBeVisible();
  const state = prep.service.getSnapshot();
  prep.service.editContent({
    sessionId: state.sessionId,
    revision: state.contentRevision ?? 0,
    mutationId: "competing-removal",
    section: "topics",
    id: state.topics[0]!.id,
    text: "",
    remove: true,
  });
  await duration.fill("30");
  await ask(page, "What matters?");
  await expect(page.getByRole("alert")).toContainText(
    "The checked item changed",
  );
  await ask(page, "Retry must not discard the check");
  await expect(page.getByRole("alert")).toContainText(
    "The checked item changed",
  );
  expect(prep.provider.invocationCount).toBe(0);
});

test("review competing text changes still reject a dirty draft", async ({
  page,
  prep,
}) => {
  const target = page
    .getByRole("textbox", { name: "Prepared question text", exact: true })
    .first();
  await target.fill("Local unsaved text");
  const state = prep.service.getSnapshot();
  prep.service.editContent({
    sessionId: state.sessionId,
    revision: state.contentRevision ?? 0,
    mutationId: "competing-text",
    section: "topics",
    id: state.topics[0]!.id,
    text: "Other writer text",
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { seenRevision: number }).seenRevision,
      ),
    )
    .toBe((state.contentRevision ?? 0) + 1);
  await ask(page, "What matters?");
  await expect(page.getByRole("alert")).toContainText(
    "Interview content changed. Your draft was kept",
  );
  await expect(target).toHaveText("Local unsaved text");
  expect(prep.provider.invocationCount).toBe(0);
  expect(prep.service.getSnapshot().topics[0]?.text).toBe("Other writer text");
});

for (const field of [
  "Prepared question text",
  "Question text",
  "Interview title",
] as const)
  test(`late acknowledgements after both HTTP saves preserve later ${field} through Ask and Finish`, async ({
    page,
    prep,
  }) => {
    await prep.service.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789",
    });
    const target = page
      .getByRole("textbox", { name: field, exact: true })
      .first();
    if (field === "Question text") {
      await target.fill("Question A");
      await ask(page);
      await expect
        .poll(() => prep.service.getSnapshot().questions.length)
        .toBe(1);
    }
    await expect(
      page.getByRole("button", { name: "Submit", exact: true }),
    ).toBeEnabled();
    const initial = await target.innerText();
    const releaseEvents = prep.holdEvents();
    const arrived = gate(),
      send = gate();
    let commits = 0;
    await page.route("**/api/session/content", async (route) => {
      if (commits === 0) {
        arrived.resolve();
        await send.promise;
      }
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      commits++;
      await route.fulfill({ response });
    });
    const contexts: unknown[] = [];
    const original = prep.provider.ask.bind(prep.provider);
    prep.provider.ask = async (question, context) => {
      contexts.push(context);
      return original(question, context);
    };
    try {
      await target.fill("Submitted B");
      await ask(page, "First ask");
      await arrived.promise;
      await target.fill(initial);
      send.resolve();
      await expect.poll(() => contexts.length).toBe(1);
      await expect(
        page.getByRole("button", { name: "Submit", exact: true }),
      ).toBeEnabled();
      expect(commits).toBe(2);
      await target.fill("Later C");
      await target.press("ArrowLeft");
      const offset = await page.evaluate(
        () => window.getSelection()?.anchorOffset,
      );
      const node = await target.elementHandle();
      const revision = prep.service.getSnapshot().contentRevision ?? 0;
      releaseEvents();
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { seenRevision: number }).seenRevision,
          ),
        )
        .toBe(revision);
      await expect(target).toHaveText("Later C");
      await expect(target).toBeFocused();
      expect(
        await node!.evaluate(
          (el) => el.isConnected && el === document.activeElement,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => window.getSelection()?.anchorOffset),
      ).toBe(offset);
      await ask(page, "Second ask");
      await expect.poll(() => contexts.length).toBe(2);
      expect(JSON.stringify(contexts[1])).toContain("Later C");
      endCapture(prep.service);
      await expect
        .poll(
          () =>
            scanFinishedConversations(path.join(prep.root, "workspace")).valid
              .length,
        )
        .toBe(1);
      const final = scanFinishedConversations(path.join(prep.root, "workspace"))
        .valid[0]!.conversation.session;
      expect(
        field === "Interview title"
          ? final.humanContext?.title
          : field === "Question text"
            ? final.questions[0]?.text
            : final.topics[0]?.text,
      ).toBe("Later C");
    } finally {
      send.resolve();
      releaseEvents();
    }
  });

for (const section of ["topics", "questions"] as const)
  test(`late acknowledgements after deletion and replacement HTTP preserve ${section} DOM and caret`, async ({
    page,
    prep,
  }) => {
    await prep.service.startRecallCapture({
      meetingUrl: "https://teams.live.com/meet/123456789",
    });
    const target = page
      .getByRole("textbox", {
        name: section === "topics" ? "Prepared question text" : "Question text",
        exact: true,
      })
      .first();
    if (section === "questions") {
      await target.fill("Question to remove");
      await ask(page);
      await expect
        .poll(() => prep.service.getSnapshot().questions.length)
        .toBe(1);
    }
    await expect(
      page.getByRole("button", { name: "Submit", exact: true }),
    ).toBeEnabled();
    const oldId = prep.service.getSnapshot()[section][0]!.id;
    const releaseEvents = prep.holdEvents(),
      arrived = gate(),
      send = gate();
    let commits = 0;
    await page.route("**/api/session/content", async (route) => {
      if (commits === 0) {
        arrived.resolve();
        await send.promise;
      }
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      commits++;
      await route.fulfill({ response });
    });
    try {
      await target.fill("");
      await ask(page, "First ask");
      await arrived.promise;
      await target.fill("Replacement B");
      send.resolve();
      await expect.poll(() => prep.provider.invocationCount).toBe(1);
      await expect(
        page.getByRole("button", { name: "Submit", exact: true }),
      ).toBeEnabled();
      expect(commits).toBe(2);
      const replacementId = prep.service.getSnapshot()[section][0]!.id;
      expect(replacementId).not.toBe(oldId);
      await target.focus();
      await target.press("End");
      await target.press("ArrowLeft");
      const offset = await page.evaluate(
        () => window.getSelection()?.anchorOffset,
      );
      const node = await target.elementHandle();
      const revision = prep.service.getSnapshot().contentRevision ?? 0;
      releaseEvents();
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { seenRevision: number }).seenRevision,
          ),
        )
        .toBe(revision);
      expect(
        await node!.evaluate(
          (el) => el.isConnected && el === document.activeElement,
        ),
      ).toBe(true);
      await expect(target).toBeFocused();
      expect(
        await page.evaluate(() => window.getSelection()?.anchorOffset),
      ).toBe(offset);
      await target.fill("Replacement C");
      await ask(page, "Second ask");
      await expect.poll(() => prep.provider.invocationCount).toBe(2);
      endCapture(prep.service);
      await expect
        .poll(
          () =>
            scanFinishedConversations(path.join(prep.root, "workspace")).valid
              .length,
        )
        .toBe(1);
      const final = scanFinishedConversations(path.join(prep.root, "workspace"))
        .valid[0]!.conversation.session[section][0]!;
      expect(final).toMatchObject({
        id: replacementId,
        text: "Replacement C",
        checked: false,
      });
    } finally {
      send.resolve();
      releaseEvents();
    }
  });

test("late acknowledgement guard admits same-revision checkbox transcript completion and a lower-revision new session", async ({
  page,
  prep,
}) => {
  await prep.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  const title = page.getByRole("textbox", {
    name: "Interview title",
    exact: true,
  });
  await title.fill("Saved title");
  await ask(page);
  await expect
    .poll(() => prep.service.getSnapshot().humanContext?.title)
    .toBe("Saved title");
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeEnabled();
  const revision = prep.service.getSnapshot().contentRevision;
  prep.service.setTopicChecked("prep-1", true);
  await expect(
    page.locator(".prepared input[type=checkbox]").first(),
  ).toBeChecked();
  prep.service.ingestRecallTranscript({
    botId: "synthetic",
    recordingId: "synthetic-recording",
    turn: {
      id: "same-revision-turn",
      providerEventId: "same-revision-event",
      speakerId: "participant",
      speakerLabel: "Participant",
      text: "Same revision testimony",
      startedAtMs: 1000,
      endedAtMs: 2000,
      receivedAt: "2026-09-16T00:00:02.000Z",
      final: true,
    },
  });
  await page
    .getByRole("button", { name: "Show transcript", exact: true })
    .click();
  await expect(page.locator("#transcript-content")).toContainText(
    "Same revision testimony",
  );
  expect(prep.service.getSnapshot().contentRevision).toBe(revision);
  const oldSession = prep.service.getSnapshot().sessionId;
  endCapture(prep.service);
  await expect
    .poll(
      () =>
        scanFinishedConversations(path.join(prep.root, "workspace")).valid
          .length,
    )
    .toBe(1);
  const final = scanFinishedConversations(path.join(prep.root, "workspace"))
    .valid[0]!.conversation.session;
  expect(final.topics[0]?.checked).toBe(true);
  expect(final.transcript[0]?.text).toBe("Same revision testimony");
  await page
    .getByRole("button", { name: "New interview", exact: true })
    .click();
  await expect(page.locator("#choose-prep")).toBeEnabled();
  expect(prep.service.getSnapshot().sessionId).not.toBe(oldSession);
  expect(prep.service.getSnapshot().contentRevision ?? 0).toBeLessThan(
    revision!,
  );
  await expect(page.locator(".selected-prep")).toHaveCount(0);
});

test("explicit Save and Command+S write preparation without inference and preserve later typing", async ({
  page,
  prep,
}) => {
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toHaveCount(1);
  await page.keyboard.press("Tab");
  await save.focus();
  expect(await save.evaluate((el) => getComputedStyle(el).outlineOffset)).toBe(
    "0px",
  );
  await page.screenshot({
    path: `${evidence}/save-focused.png`,
    fullPage: true,
  });
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  await note.fill("Button save");
  await save.click();
  const file = path.join(prep.root, "workspace/prep/current/practice.md");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("Button save");
  await note.fill("Shortcut save");
  await note.press("Meta+s");
  await expect
    .poll(() => readFileSync(file, "utf8"))
    .toContain("Shortcut save");
  expect(prep.provider.invocationCount).toBe(0);
  await page.reload();
  await expect(note).toHaveText("Shortcut save");
});
test("explicit Save external conflict retains text and blocks Ask until repaired", async ({
  page,
  prep,
}) => {
  const file = path.join(prep.root, "workspace/prep/current/practice.md");
  const original = readFileSync(file, "utf8");
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  await note.fill("Retained on conflict");
  writeFileSync(file, original + "\nOutside change\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("changed");
  await expect(note).toHaveText("Retained on conflict");
  await ask(page, "What did they say?");
  await expect(page.getByRole("alert").first()).toContainText("changed");
  expect(prep.provider.invocationCount).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(original + "\nOutside change\n");
  writeFileSync(file, original);
  await note.press("Meta+s");
  await expect
    .poll(() => readFileSync(file, "utf8"))
    .toContain("Retained on conflict");
  await ask(page, "What did they say?");
  await expect.poll(() => prep.provider.invocationCount).toBe(1);
});
test("Save drains typing during a pending receipt and waits for composition without moving the caret", async ({
  page,
  prep,
}) => {
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  const held = gate();
  const reached = gate();
  let first = true;
  await page.route("**/api/session/save", async (route) => {
    const response = await route.fetch();
    if (first) {
      first = false;
      reached.resolve();
      await held.promise;
    }
    await route.fulfill({ response });
  });
  await note.fill("First");
  await note.press("Meta+s");
  await reached.promise;
  await note.press("End");
  await note.pressSequentially(" later");
  const element = await note.elementHandle();
  held.resolve();
  const file = path.join(prep.root, "workspace/prep/current/practice.md");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("First later");
  expect(await note.evaluate((el, original) => el === original, element)).toBe(
    true,
  );
  await expect(note).toBeFocused();
  await note.dispatchEvent("compositionstart");
  await note.fill("Composed draft");
  await note.press("Meta+s");
  await expect(
    page.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  expect(readFileSync(file, "utf8")).not.toContain("Composed draft");
  await note.dispatchEvent("compositionend");
  await expect
    .poll(() => readFileSync(file, "utf8"))
    .toContain("Composed draft");
  expect(prep.provider.invocationCount).toBe(0);
});
test("Save retries a real checkpoint failure after writing prep, and the save route rejects renderer paths", async ({
  page,
  prep,
}) => {
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  await note.fill("Receipt failure draft");
  const original = prep.repository.save.bind(prep.repository);
  let failed = false;
  prep.repository.save = (state, receipts) => {
    const binding = prep.repository.getWorkspaceBinding();
    const file = path.join(prep.root, "workspace/prep/current/practice.md");
    if (
      !failed &&
      !binding?.pendingPrepWrite &&
      readFileSync(file, "utf8").includes("Receipt failure draft")
    ) {
      failed = true;
      throw new Error("synthetic checkpoint failure");
    }
    original(state, receipts);
  };
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "checkpoint failed",
  );
  await expect(note).toHaveText("Receipt failure draft");
  expect(failed).toBe(true);
  await note.press("Meta+s");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  const status = await page.evaluate(async () => {
    const s = await fetch("/api/session").then((r) => r.json());
    return (
      await fetch("/api/session/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: s.state.sessionId,
          revision: s.state.contentRevision ?? 0,
          path: "/outside/forged.md",
        }),
      })
    ).status;
  });
  expect(status).toBe(409);
  expect(prep.provider.invocationCount).toBe(0);
  await page.reload();
  await expect(note).toHaveText("Receipt failure draft");
});

async function desktopQuitFixture(
  page: import("@playwright/test").Page,
  choice: () => Promise<"save" | "discard" | "cancel">,
  risk: () => "active_interview" | null = () => null,
  confirmRisk = async () => true,
  observe?: (event: string, data?: unknown) => void,
) {
  let runtimeAlive = true,
    windowOpen = true,
    closeListener = () => {},
    vetoListener = () => {};
  const reports: string[] = [];
  const policy = new NavigationPolicy();
  policy.allow(page.url());
  const veto = () =>
    page.evaluate(
      () =>
        !window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    );
  const windowPort = {
    loadURL: async () => {},
    show: () => {},
    focus: () => {},
    restore: () => {},
    isDestroyed: () => !windowOpen,
    isMinimized: () => false,
    onClose: () => {},
    destroy: () => {
      windowOpen = false;
    },
    closeForQuit: (approveClose: () => Promise<boolean>) =>
      closeWindowForQuit(
        {
          url: () => page.url(),
          generation: () => 0,
          evaluate: async (script) => {
            if (!observe) return page.evaluate(script);
            const action = script.match(/caddyPrepareClose\("(\w+)"\)/)?.[1];
            observe("coordinator-evaluate", { action });
            // Execute the exact production expression. The real async renderer
            // function enters up to its first await before the observation.
            const result = await page.evaluate(`(() => {
              const result = (${script});
              console.debug(${JSON.stringify("CADDY_CLOSE_FIXTURE:" + JSON.stringify({ action }))});
              return result;
            })()`);
            observe("coordinator-result", { result });
            return result;
          },
          choose: choice,
          report: async (message) => {
            reports.push(message);
            observe?.("coordinator-report", { message });
          },
          onClosed: (listener) => {
            closeListener = listener;
            return () => {
              closeListener = () => {};
            };
          },
          onVeto: (listener) => {
            vetoListener = listener;
            return () => {
              vetoListener = () => {};
            };
          },
          close: () => {
            void veto().then((prevented) => {
              if (prevented) {
                observe?.("veto");
                vetoListener();
              } else {
                windowOpen = false;
                observe?.("closed");
                closeListener();
              }
            });
          },
        },
        policy,
        approveClose,
      ),
  };
  const controller = await startDesktopApplication({
    app: {
      requestSingleInstanceLock: () => true,
      enableSandbox: () => {},
      whenReady: async () => {},
      quit: () => {
        observe?.("app-quit");
        void veto().then((prevented) => {
          if (!prevented) windowOpen = false;
        });
      },
      onSecondInstance: () => {},
      onActivate: () => {},
      onBeforeQuit: () => {},
    },
    localApiAccess: new LocalApiAccess(),
    createBootstrap: async () => ({
      url: "http://127.0.0.1:4999",
      update: () => {},
      close: async () => {},
    }),
    createBrowserSession: () => ({
      setCookie: async () => {},
      clear: async () => {},
    }),
    createWindow: () => windowPort,
    startRuntime: async () => ({
      mode: "normal",
      applicationUrl: page.url(),
      getQuitRisk: risk,
      close: async () => {
        observe?.("runtime-close", { windowOpen });
        runtimeAlive = false;
      },
    }),
    confirmForceQuit: confirmRisk,
  });
  await controller!.startupSettled;
  return {
    controller: controller!,
    reports,
    veto,
    alive: () => runtimeAlive,
    open: () => windowOpen,
  };
}
for (const action of ["save", "discard", "cancel"] as const) {
  test(`desktop dirty preparation quit ${action} preserves runtime until approved unload`, async ({
    page,
    prep,
  }) => {
    const note = page
      .getByRole("textbox", { name: "Note text", exact: true })
      .first();
    await note.fill("Unsaved preparation");
    let selected: "save" | "discard" | "cancel" = action;
    const h = await desktopQuitFixture(page, async () => selected);
    expect(await h.veto()).toBe(true);
    const before = readFileSync(
      path.join(prep.root, "workspace/prep/current/practice.md"),
      "utf8",
    );
    expect(await h.controller.requestQuit()).toBe(
      action === "cancel" ? "blocked" : "quit",
    );
    expect(h.alive()).toBe(action === "cancel");
    expect(h.open()).toBe(action === "cancel");
    const saved = readFileSync(
      path.join(prep.root, "workspace/prep/current/practice.md"),
      "utf8",
    );
    if (action === "save") expect(saved).toContain("Unsaved preparation");
    else expect(saved).toBe(before);
    if (action === "cancel") {
      await expect(note).toHaveText("Unsaved preparation");
      await ask(page, "/note Still usable");
      await expect.poll(() => prep.service.getSnapshot().notes.length).toBe(2);
      selected = "save";
      expect(await h.controller.requestQuit()).toBe("quit");
    }
    expect(prep.provider.invocationCount).toBe(0);
  });
}
test("desktop Save failure retains page/runtime and subsequent Quit saves successfully", async ({
  page,
  prep,
}) => {
  const file = path.join(prep.root, "workspace/prep/current/practice.md");
  const before = readFileSync(file, "utf8");
  await page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first()
    .fill("Retry retained draft");
  writeFileSync(file, before + "\nExternal author change\n");
  const h = await desktopQuitFixture(page, async () => "save");
  expect(await h.controller.requestQuit()).toBe("blocked");
  expect(h.alive()).toBe(true);
  expect(h.open()).toBe(true);
  expect(readFileSync(file, "utf8")).toContain("External author change");
  await expect(page.getByRole("alert")).toContainText("changed");
  expect(await h.veto()).toBe(true);
  writeFileSync(file, before);
  expect(await h.controller.requestQuit()).toBe("quit");
  expect(readFileSync(file, "utf8")).toContain("Retry retained draft");
});
test("desktop active capture decline preserves draft; approved Save isolates original", async ({
  page,
  prep,
}) => {
  await prep.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  await page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first()
    .fill("Active draft");
  let approved = false,
    choices = 0;
  const h = await desktopQuitFixture(
    page,
    async () => {
      choices++;
      return "save";
    },
    () => "active_interview",
    async () => approved,
  );
  expect(await h.controller.requestQuit()).toBe("blocked");
  expect(choices).toBe(0);
  expect(h.alive()).toBe(true);
  approved = true;
  expect(await h.controller.requestQuit()).toBe("quit");
  expect(
    readFileSync(
      path.join(prep.root, "workspace/prep/current/practice.md"),
      "utf8",
    ),
  ).toBe(source);
  expect(
    readFileSync(path.join(prep.root, "private/active-session.json"), "utf8"),
  ).toContain("Active draft");
});
test("desktop Save drains composition, held acknowledgement and later input before teardown", async ({
  page,
  prep,
}, testInfo) => {
  const record = closeProgress(page, testInfo);
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  await note.dispatchEvent("compositionstart");
  record("composition-started");
  await note.fill("Composing draft");
  const ready = gate(),
    release = gate();
  let requests = 0;
  await page.route("**/api/session/content", async (route) => {
    requests++;
    if (requests > 1) {
      await route.continue();
      return;
    }
    record("route-entry");
    const response = await route.fetch();
    record("route-fetch", { status: response.status() });
    ready.resolve();
    await release.promise;
    record("route-release");
    await route.fulfill({ response });
    record("route-fulfilled");
  });
  try {
    const h = await desktopQuitFixture(
      page,
      async () => "save",
      () => null,
      async () => true,
      record,
    );
    const closing = h.controller.requestQuit();
    expect(h.alive()).toBe(true);
    await note.dispatchEvent("compositionend");
    record("composition-ended");
    await ready.promise;
    await note.fill("Later typing retained");
    record("later-input");
    expect(h.alive()).toBe(true);
    record("release-request");
    release.resolve();
    expect(await closing).toBe("quit");
    expect(
      readFileSync(
        path.join(prep.root, "workspace/prep/current/practice.md"),
        "utf8",
      ),
    ).toContain("Later typing retained");
  } finally {
    release.resolve();
  }
});
test("desktop clean quit needs no draft prompt", async ({ page, prep }) => {
  expect(prep.service.getSnapshot().notes).toHaveLength(0);
  let choices = 0;
  const h = await desktopQuitFixture(page, async () => {
    choices++;
    return "cancel";
  });
  expect(await h.controller.requestQuit()).toBe("quit");
  expect(choices).toBe(0);
  expect(h.open()).toBe(false);
});

test("desktop Save drains a queued checkbox after metadata correction", async ({
  page,
  prep,
}) => {
  const minutes = page.getByRole("textbox", {
    name: "Planned minutes",
    exact: true,
  });
  await minutes.fill("0");
  await page.locator(".prepared input[type=checkbox]").first().check();
  await expect(page.getByRole("alert")).toBeVisible();
  await minutes.fill("30");
  const h = await desktopQuitFixture(page, async () => "save");
  expect(await h.controller.requestQuit()).toBe("quit");
  expect(prep.service.getSnapshot().topics[0]?.checked).toBe(true);
  const bytes = readFileSync(
    path.join(prep.root, "workspace/prep/current/practice.md"),
    "utf8",
  );
  expect(bytes).toContain("[x] What changed?");
});
test("desktop completed conversation closes cleanly without altering its files", async ({
  page,
  prep,
}) => {
  await prep.service.startRecallCapture({
    meetingUrl: "https://teams.live.com/meet/123456789",
  });
  endCapture(prep.service);
  await expect
    .poll(
      () =>
        scanFinishedConversations(path.join(prep.root, "workspace")).valid
          .length,
    )
    .toBe(1);
  const record = scanFinishedConversations(path.join(prep.root, "workspace"))
    .valid[0]!;
  const file = path.join(
    prep.root,
    "workspace/finished-conversations",
    record.name,
    "conversation.md",
  );
  const before = readFileSync(file, "utf8");
  let choices = 0;
  const h = await desktopQuitFixture(page, async () => {
    choices++;
    return "cancel";
  });
  expect(await h.controller.requestQuit()).toBe("quit");
  expect(choices).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("desktop quit during an existing Save keeps runtime usable until pending and later edits settle", async ({
  page,
  prep,
}) => {
  const note = page
    .getByRole("textbox", { name: "Note text", exact: true })
    .first();
  await note.fill("First save");
  const ready = gate(),
    release = gate();
  let requests = 0;
  await page.route("**/api/session/content", async (route) => {
    requests++;
    if (requests > 1) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    ready.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    await page.locator("#save-content").click();
    await ready.promise;
    const h = await desktopQuitFixture(page, async () => "save");
    expect(await h.controller.requestQuit()).toBe("blocked");
    expect(h.alive()).toBe(true);
    await note.fill("Typed during pending Save");
    release.resolve();
    await expect(page.locator("#save-content")).toBeEnabled();
    expect(await h.controller.requestQuit()).toBe("quit");
    expect(
      readFileSync(
        path.join(prep.root, "workspace/prep/current/practice.md"),
        "utf8",
      ),
    ).toContain("Typed during pending Save");
  } finally {
    release.resolve();
  }
});

// Receipts are written incrementally: a test timeout/page teardown cannot erase
// the last observed phase. Only synthetic lifecycle metadata, never draft text.
function closeProgress(
  page: import("@playwright/test").Page,
  info: import("@playwright/test").TestInfo,
  onRendererSave?: () => void,
  filename = "close-progress.json",
) {
  const events: Array<{ at: number; event: string; data?: unknown }> = [];
  const started = performance.now();
  const file = info.outputPath(filename);
  info.attachments.push({
    name: "close-progress",
    contentType: "application/json",
    path: file,
  });
  const record = (event: string, data?: unknown) => {
    if (events.length >= 200) return;
    events.push({ at: performance.now() - started, event, data });
    writeFileSync(file, JSON.stringify({ phase: event, events }, null, 2));
  };
  page.on("console", (message) => {
    if (!message.text().startsWith("CADDY_CLOSE_FIXTURE:")) return;
    const data = JSON.parse(
      message.text().slice("CADDY_CLOSE_FIXTURE:".length),
    );
    record("renderer-close-entered", data);
    if (data.action === "save") onRendererSave?.();
  });
  page.on("pageerror", (error) =>
    record("page-error", { name: error.name, message: error.message }),
  );
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (["/api/session/content", "/api/session/save"].includes(pathname))
      record("request", { pathname });
  });
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (["/api/session/content", "/api/session/save"].includes(pathname))
      record("response", { pathname, status: response.status() });
  });
  record("setup");
  return record;
}

for (const ordering of [
  "save enters during composition",
  "composition ends before save",
  "save enters during composition, persistent route",
] as const) {
  test(`desktop deterministic close: ${ordering}`, async ({
    page,
    prep,
  }, testInfo) => {
    const entered = gate(),
      ready = gate(),
      release = gate();
    const duringComposition = ordering !== "composition ends before save";
    const progressFile = duringComposition
      ? "transport-progress.json"
      : "close-progress.json";
    const record = closeProgress(page, testInfo, entered.resolve, progressFile);
    if (duringComposition) prep.observeTransport(record);
    const note = page
      .getByRole("textbox", { name: "Note text", exact: true })
      .first();
    let requests = 0;
    // Keep interception installed through the close scenario, holding only the
    // first response. Later edits must reach the real server before shutdown.
    await page.route("**/api/session/content", async (route) => {
      requests++;
      record("route-entry", {
        ordinal: requests,
        revision: prep.service.getSnapshot().contentRevision,
      });
      if (requests > 1) {
        await route.continue();
        record("route-continued", { ordinal: requests });
        return;
      }
      const response = await route.fetch();
      record("route-fetch", {
        status: response.status(),
        revision: prep.service.getSnapshot().contentRevision,
      });
      ready.resolve();
      await release.promise;
      record("route-release");
      await route.fulfill({ response });
      record("route-fulfilled");
    });
    try {
      await note.dispatchEvent("compositionstart");
      record("composition-started");
      await note.fill("Composing draft");
      if (ordering === "composition ends before save") {
        await note.dispatchEvent("compositionend");
        record("composition-ended");
      }
      const h = await desktopQuitFixture(
        page,
        async () => "save",
        () => null,
        async () => true,
        record,
      );
      const closing = h.controller.requestQuit();
      await entered.promise;
      record("save-entry-observed");
      expect(h.alive()).toBe(true);
      expect(h.open()).toBe(true);
      if (duringComposition) {
        expect(requests).toBe(0);
        await note.dispatchEvent("compositionend");
        record("composition-ended");
      }
      await ready.promise;
      await note.fill("Later typing retained");
      record("later-input");
      expect(h.alive()).toBe(true);
      expect(h.open()).toBe(true);
      record("release-request");
      release.resolve();
      expect(await closing).toBe("quit");
      expect(h.alive()).toBe(false);
      expect(h.open()).toBe(false);
      const bytes = readFileSync(
        path.join(prep.root, "workspace/prep/current/practice.md"),
        "utf8",
      );
      expect(bytes).toContain("Later typing retained");
      expect(
        readFileSync(
          path.join(prep.root, "private/active-session.json"),
          "utf8",
        ),
      ).toContain("Later typing retained");
      const receipt = JSON.parse(
        readFileSync(testInfo.outputPath(progressFile), "utf8"),
      );
      const names = receipt.events.map(
        (event: { event: string }) => event.event,
      );
      expect(names.indexOf("closed")).toBeLessThan(
        names.indexOf("runtime-close"),
      );
      expect(names.indexOf("runtime-close")).toBeLessThan(
        names.indexOf("app-quit"),
      );
      expect(
        receipt.events.find(
          (event: { event: string }) => event.event === "runtime-close",
        ).data.windowOpen,
      ).toBe(false);
      record("disk-and-order-verified", {
        revision: prep.service.getSnapshot().contentRevision,
      });
    } finally {
      record("test-finally");
      release.resolve();
    }
  });
}

for (const action of ["ask", "finish", "capture"] as const)
  test(`duplicate name retains the inline draft and blocks ${action}`, async ({
    page,
    prep,
  }) => {
    const workspace = path.join(prep.root, "workspace");
    const other = structuredClone(prep.service.getSnapshot());
    other.sessionId = "55555555-2222-4333-8444-555555555555";
    other.lifecycle.displayName = "Taken café";
    publishFinishedConversation({
      root: workspace,
      state: other,
      prepSourceFile: "TEMPLATE.md",
      prepSourceBytes: source,
      completedAt: "2026-09-20T14:00:00.000Z",
    });
    if (action === "finish")
      await prep.service.startRecallCapture({
        meetingUrl: "https://teams.live.com/meet/123456789",
      });
    const name = page.getByRole("textbox", {
      name: "Saved interview name (optional)",
      exact: true,
    });
    await name.fill("TAKEN CAFÉ");
    let downstream = 0;
    page.on("request", (request) => {
      if (
        /\/api\/(input|session\/finish-saving|capture\/recall\/start)$/.test(
          new URL(request.url()).pathname,
        )
      )
        downstream++;
    });
    if (action === "ask") await ask(page, "What matters?");
    else if (action === "finish") endCapture(prep.service);
    else {
      await page
        .getByLabel("Personal Microsoft Teams meeting link")
        .fill("https://teams.live.com/meet/123456789");
      await page
        .getByRole("button", { name: "Start live capture", exact: true })
        .click();
    }
    await expect(page.getByRole("alert")).toContainText(
      "Choose a different name",
    );
    await expect(name).toHaveText("TAKEN CAFÉ");
    expect(downstream).toBe(0);
    expect(prep.service.getProviderCallCount()).toBe(0);
    expect(scanFinishedConversations(workspace).valid).toHaveLength(1);
    await name.fill("Available café");
    if (action === "finish") {
      await page
        .getByRole("button", { name: "Finish saving", exact: true })
        .click();
      await expect
        .poll(() => scanFinishedConversations(workspace).valid.length)
        .toBe(2);
      expect(
        readFileSync(
          path.join(workspace, "prep/archive/Available café.md"),
          "utf8",
        ),
      ).toBe(source);
    } else {
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() => prep.service.getSnapshot().lifecycle.displayName)
        .toBe("Available café");
    }
  });

test("unsafe saved-name whitespace is rejected without silently renaming the draft", async ({
  page,
  prep,
}) => {
  const name = page.getByRole("textbox", {
    name: "Saved interview name (optional)",
    exact: true,
  });
  await name.fill(" Café Team ");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Choose a different name",
  );
  await expect(name).toHaveText(" Café Team ");
  expect(prep.service.getSnapshot().lifecycle.displayName).toBeNull();
});
