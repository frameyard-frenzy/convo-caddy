import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "@playwright/test";
import {
  canaries,
  checkAll,
  enterDraft,
  gate,
  type SaveInput,
  test,
} from "../helpers/setup-browser-fixture.js";

test("enter once through actual routes commits, acknowledges, and replaces the runtime in order", async ({
  page,
  setup,
}) => {
  const before = setup.settingsBytes();
  await enterDraft(page);
  await checkAll(page);
  expect(setup.calls.map((call) => call.kind)).toEqual([
    "recall",
    "discovery",
    "assistant",
  ]);
  expect(setup.calls[0]?.input).toMatchObject({
    recallApiKey: canaries["recall-api-key"],
    recallWebhookVerificationSecret:
      canaries["recall-webhook-verification-secret"],
    ngrokAuthtoken: canaries["ngrok-authtoken"],
    ngrokDomain: "fixture.ngrok.app",
  });
  expect(setup.calls[1]?.input).toMatchObject({
    apiKey: canaries["hermes-api-key"],
    mode: "local",
  });
  expect(setup.calls[2]?.input).toMatchObject({
    apiKey: canaries["hermes-api-key"],
    profile: "everyday",
  });
  for (const role of Object.keys(canaries))
    await expect(page.locator(`#${role}`)).toHaveAttribute("type", "password");
  expect(setup.writes).toBe(0);
  expect(setup.commits).toBe(0);
  expect(setup.settingsBytes()).toBe(before);
  expect(existsSync(path.join(setup.paths.configDirectory, ".env"))).toBe(
    false,
  );
  expect(await setup.authority()).toBeNull();
  const save = setup.hold("save");
  const acknowledgement = gate();
  const reload = setup.hold("reload");
  let ackSeen = false;
  await page.route("**/api/setup/save-acknowledgement", async (route) => {
    ackSeen = true;
    setup.events.push("renderer-acknowledgement");
    await acknowledgement.promise;
    await route.continue();
  });
  try {
    await page.locator("#save-connections").click();
    await setup.waitFor("save");
    for (const [role, value] of Object.entries(canaries)) {
      await expect(page.locator(`#${role}`)).toHaveValue(value);
      await expect(page.locator(`#${role}`)).toBeDisabled();
    }
    for (const id of ["reset", "reload"])
      await expect(page.locator(`#${id}`)).toBeDisabled();
    save.release();
    await expect.poll(() => ackSeen).toBe(true);
    expect(setup.commits).toBe(1);
    expect(setup.writes).toBe(4);
    const savedInput = setup.calls.find((call) => call.kind === "save")
      ?.input as SaveInput | undefined;
    expect(savedInput?.replacements).toEqual(canaries);
    expect((await setup.authority())?.secrets).toEqual(canaries);
    expect((await setup.authority())?.connection.hermes.profile).toBe(
      "everyday",
    );
    expect(setup.calls.filter((call) => call.kind === "reload")).toHaveLength(
      0,
    );
    for (const role of Object.keys(canaries)) {
      await expect(page.locator(`#${role}`)).toHaveValue("");
      await expect(page.locator(`#${role}`)).toBeDisabled();
    }
    acknowledgement.release();
    await setup.waitFor("reload");
    expect(setup.runtimeStarts).toBe(1);
    expect(setup.events).not.toContain("setup-close");
    await expect(page.locator("#save-connections")).toBeDisabled();
    reload.release();
    await expect(
      page.getByRole("heading", { name: "Fixture runtime replaced" }),
    ).toBeVisible();
    expect(new URL(page.url()).origin).not.toBe(setup.setupUrl);
    expect(setup.runtimeStarts).toBe(2);
    const ordered = [
      "committed",
      "renderer-acknowledgement",
      "reload",
      "setup-close",
      "setup-closed",
      "session-cleared",
      "replacement-started",
    ];
    let previous = -1;
    for (const event of ordered) {
      const index = setup.events.indexOf(event);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    await expect(page.request.get(setup.setupUrl)).rejects.toThrow();
  } finally {
    save.release();
    acknowledgement.release();
    reload.release();
  }
});

test("lost Save response follows a real committed generation, retains all canaries, and identical retry replaces runtime", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  await checkAll(page);
  await page.route(
    "**/api/setup/connections",
    async (route) => {
      const result = await route.fetch();
      expect(result.status()).toBe(200);
      expect(setup.commits).toBe(1);
      await route.abort("connectionreset");
    },
    { times: 1 },
  );
  await page.locator("#save-connections").click();
  await expect(page.locator("#setup-message")).toContainText(
    "save may have completed",
  );
  expect(setup.commits).toBe(1);
  const first = await setup.authority();
  expect(first?.secrets).toEqual(canaries);
  expect(setup.calls.filter((call) => call.kind === "reload")).toHaveLength(0);
  expect(setup.runtimeStarts).toBe(1);
  for (const [role, value] of Object.entries(canaries)) {
    await expect(page.locator(`#${role}`)).toHaveValue(value);
    await expect(page.locator(`#${role}`)).toBeEnabled();
  }
  await page.locator("#save-connections").click();
  await expect(
    page.getByRole("heading", { name: "Fixture runtime replaced" }),
  ).toBeVisible();
  expect(setup.commits).toBe(2);
  const saves = setup.calls.filter((call) => call.kind === "save");
  expect(saves[1]?.input).toEqual(saves[0]?.input);
  const second = await setup.authority();
  expect(second?.generation).not.toBe(first?.generation);
  expect(second?.secrets).toEqual(canaries);
  expect(setup.secretSlots()).toEqual(
    new Map(
      Object.entries(canaries).map(([role, value]) => [
        `${role}@${second?.generation}`,
        value,
      ]),
    ),
  );
  expect(setup.calls.filter((call) => call.kind === "reload")).toHaveLength(1);
});

test.describe("uncertain setup mutations use actual storage results", () => {
  test.describe("Reset response loss", () => {
    test.use({ readySetup: true });
    for (const responseLoss of ["network", "json"] as const) {
      test(`lost ${responseLoss} reply reports unconfirmed after actual removal`, async ({
        page,
        setup,
      }) => {
        await enterDraft(page, false);
        const drafts: Record<string, string> = Object.fromEntries(
          await Promise.all(
            Object.keys(canaries).map(async (id) => [
              id,
              await page.locator(`#${id}`).inputValue(),
            ]),
          ),
        );
        await page.route(
          "**/api/setup/credentials",
          async (route) => {
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            expect(await setup.authority()).toBeNull();
            if (responseLoss === "network")
              await route.abort("connectionreset");
            else
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: "{",
              });
          },
          { times: 1 },
        );
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator("#reset").click();
        await expect(page.locator("#setup-report")).toHaveValue(
          /Result: response_unconfirmed/,
        );
        await expect(page.locator("#setup-report")).toHaveValue(
          /credentials may have been removed/i,
        );
        expect(
          setup.calls.filter((call) => call.kind === "reset"),
        ).toHaveLength(1);
        expect(await setup.authority()).toBeNull();
        for (const [id, value] of Object.entries(drafts))
          await expect(page.locator(`#${id}`)).toHaveValue(value);
      });
    }
  });

  for (const responseLoss of ["network", "json"] as const) {
    test(`native-close Save lost ${responseLoss} reply is unconfirmed after actual commit`, async ({
      page,
      setup,
    }) => {
      await enterDraft(page, false);
      await page.route(
        "**/api/setup/connections",
        async (route) => {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          expect(setup.commits).toBe(1);
          if (responseLoss === "network") await route.abort("connectionreset");
          else
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: "{",
            });
        },
        { times: 1 },
      );
      const result = await page.evaluate(() =>
        (
          window as unknown as {
            caddyPrepareClose(action: string): Promise<string>;
          }
        ).caddyPrepareClose("save"),
      );
      expect(result).toBe("blocked");
      expect(setup.commits).toBe(1);
      expect((await setup.authority())?.secrets).toMatchObject({
        "recall-api-key": canaries["recall-api-key"],
      });
      await expect(page.locator("#setup-report")).toHaveValue(
        /Result: response_unconfirmed/,
      );
      await expect(page.locator("#setup-report")).toHaveValue(
        /settings may have been saved/i,
      );
      await expect(page.locator("#recall-api-key")).toHaveValue(
        canaries["recall-api-key"],
      );
    });
  }
});

for (const kind of ["recall", "discovery", "assistant"] as const) {
  for (const rejection of [false, true]) {
    for (const change of ["edit"] as const) {
      test(`${kind} stale ${rejection ? "rejection" : "success"} after ${change} cannot overwrite current evidence`, async ({
        page,
        setup,
      }) => {
        await enterDraft(page);
        await checkAll(page);
        const pending = setup.hold(kind, rejection);
        const control = {
          recall: "test-connections",
          discovery: "discover-hermes-profiles",
          assistant: "test-hermes-assistant",
        }[kind];
        const outcome = {
          recall: "recall-outcome",
          discovery: "hermes-outcome",
          assistant: "assistant-outcome",
        }[kind];
        try {
          await page.locator(`#${control}`).click();
          await setup.waitFor(kind, 2);
          if (kind === "assistant") {
            await page.locator("#hermes-profile").selectOption("backup");
          } else {
            await page
              .locator(
                kind === "recall" ? "#recall-api-key" : "#hermes-api-key",
              )
              .fill("edited-canary");
          }
          const current = await page.locator(`#${outcome}`).textContent();
          expect(current).toMatch(/changed/i);
          pending.release();
          await expect(page.locator("#save-connections")).toBeEnabled();
          await expect(page.locator(`#${outcome}`)).toHaveText(current ?? "");
          if (kind === "discovery")
            await expect(page.locator("#hermes-profile")).not.toContainText(
              "everyday",
            );
          if (change === "edit")
            await expect(
              page.locator(
                kind === "recall" ? "#hermes-outcome" : "#recall-outcome",
              ),
            ).toContainText(
              kind === "recall" ? "models loaded" : "checks passed",
            );
          expect(setup.writes).toBe(0);
        } finally {
          pending.release();
        }
      });
    }
  }
}

test("failed reset retains every draft, preserves saved authority, and recovers controls without removal claims", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  await checkAll(page);
  // Seed existing authority through the real authenticated Save route without
  // renderer acknowledgement; then reset through the actual page and handler.
  const payload = {
    ngrokDomain: "fixture.ngrok.app",
    recallApiKey: "old-recall",
    recallWebhookVerificationSecret:
      canaries["recall-webhook-verification-secret"],
    ngrokAuthtoken: "old-ngrok",
    hermesApiKey: "old-hermes",
    hermesMode: "local",
    hermesLocalPort: 8642,
    hermesRemotePort: 8642,
    hermesSshTarget: null,
    hermesEndpointPath: "/",
    hermesProfile: "everyday",
  };
  const seeded = await page.request.put(
    `${setup.setupUrl}/api/setup/connections`,
    { headers: { Origin: setup.setupUrl }, data: payload },
  );
  expect(seeded.status()).toBe(200);
  const authority = await setup.authority();
  const pending = setup.hold("reset", true);
  page.once("dialog", (dialog) => dialog.accept());
  try {
    await page.locator("#reset").click();
    await setup.waitFor("reset");
    for (const role of Object.keys(canaries))
      await expect(page.locator(`#${role}`)).toBeDisabled();
    pending.release();
    await expect(page.locator("#setup-message")).toContainText(
      "Setup operation failed",
    );
    await expect(page.locator("#setup-message")).not.toContainText("removed");
    for (const [role, value] of Object.entries(canaries)) {
      await expect(page.locator(`#${role}`)).toHaveValue(value);
      await expect(page.locator(`#${role}`)).toBeEnabled();
    }
    expect(await setup.authority()).toEqual(authority);
    await expect(page.locator("#reset")).toBeEnabled();
    await expect(page.locator("#save-connections")).toBeEnabled();
  } finally {
    pending.release();
  }
});

test("partial Recall/ngrok Save uses the real storage transaction and explicit acknowledgement", async ({
  page,
  setup,
}) => {
  await enterDraft(page, false);
  await page.locator("#save-connections").click();
  await expect(
    page.getByRole("heading", { name: "Fixture runtime replaced" }),
  ).toBeVisible();
  const authority = await setup.authority();
  expect(authority?.connection.hermes.mode).toBeNull();
  expect(authority?.secrets["hermes-api-key"]).toBeUndefined();
  expect(setup.writes).toBe(3);
  expect(setup.commits).toBe(1);
});

for (const destination of ["local", ""] as const) {
  test(`invalid hidden remote port does not obstruct ${destination || "deferred"} Hermes`, async ({
    page,
    setup,
  }) => {
    await enterDraft(page, destination === "local");
    await page.locator("#hermes-mode").selectOption("ssh");
    await page.locator("#hermes-remote-port").fill("");
    await page.locator("#hermes-mode").selectOption(destination);
    await expect(page.locator("#remote-fields")).toBeHidden();
    if (destination === "local") await checkAll(page);
    for (const [role, value] of Object.entries(canaries)) {
      if (destination === "local" || role !== "hermes-api-key")
        await expect(page.locator(`#${role}`)).toHaveValue(value);
    }
    await page.locator("#save-connections").click();
    await expect(
      page.getByRole("heading", { name: "Fixture runtime replaced" }),
    ).toBeVisible();
    const authority = await setup.authority();
    expect(authority?.connection.hermes.mode).toBe(destination || null);
    expect(authority?.connection.hermes.remotePort).toBe(8642);
    expect(authority?.secrets["recall-api-key"]).toBe(
      canaries["recall-api-key"],
    );
    expect(setup.commits).toBe(1);
  });
}

test("successful reset invalidates an older unacknowledged Save", async ({
  page,
  setup,
}) => {
  await enterDraft(page, false);
  const reload = setup.hold("reload");
  await page.route("**/api/setup/save-acknowledgement", (route) =>
    route.abort(),
  );
  try {
    await page.locator("#save-connections").click();
    await expect(page.locator("#setup-message")).toContainText(
      "Reload confirmation was not received",
    );
    const reset = await page.request.delete(
      `${setup.setupUrl}/api/setup/credentials`,
      { headers: { Origin: setup.setupUrl }, data: { confirm: true } },
    );
    expect(reset.status()).toBe(200);
    const staleAck = await page.request.post(
      `${setup.setupUrl}/api/setup/save-acknowledgement`,
      { headers: { Origin: setup.setupUrl }, data: {} },
    );
    expect(staleAck.status()).toBe(409);
    expect(setup.calls.filter((call) => call.kind === "reload")).toHaveLength(
      0,
    );
  } finally {
    reload.release();
  }
});

for (const fails of [false, true]) {
  test(`pending ${fails ? "failed" : "successful"} reset permanently retires outstanding Save acknowledgement`, async ({
    page,
    setup,
  }) => {
    await enterDraft(page, false);
    await page.route("**/api/setup/save-acknowledgement", (route) =>
      route.abort(),
    );
    await page.locator("#save-connections").click();
    await expect(page.locator("#setup-message")).toContainText(
      "Reload confirmation was not received",
    );
    expect(setup.commits).toBe(1);
    const authority = await setup.authority();
    const pending = setup.hold("reset", fails);
    const reload = setup.hold("reload");
    const reset = page.request.delete(
      `${setup.setupUrl}/api/setup/credentials`,
      {
        headers: { Origin: setup.setupUrl },
        data: { confirm: true },
      },
    );
    const assertNoReplacement = () => {
      expect(setup.runtimeStarts).toBe(1);
      for (const event of [
        "reload",
        "setup-close",
        "setup-closed",
        "session-cleared",
        "replacement-started",
      ])
        expect(setup.events).not.toContain(event);
    };
    const acknowledge = () =>
      page.request.post(`${setup.setupUrl}/api/setup/save-acknowledgement`, {
        headers: { Origin: setup.setupUrl },
        data: {},
      });
    try {
      await setup.waitFor("reset");
      expect((await acknowledge()).status()).toBe(409);
      assertNoReplacement();
      pending.release();
      expect((await reset).status()).toBe(fails ? 500 : 200);
      expect((await acknowledge()).status()).toBe(409);
      assertNoReplacement();
      expect(await setup.authority()).toEqual(fails ? authority : null);
    } finally {
      pending.release();
      await reset.catch(() => undefined);
      reload.release();
    }
  });
}

for (const reject of [false, true]) {
  test(`remote setup prerequisites and stale ${reject ? "failure" : "success"} preserve the draft`, async ({
    page,
    setup,
  }) => {
    await expect(page.locator("#discover-hermes-profiles")).toBeDisabled();
    await expect(page.locator("#hermes-ssh-target")).toBeHidden();
    await enterDraft(page);
    await page.locator("#hermes-mode").selectOption("ssh");
    await expect(page.locator("#discover-hermes-profiles")).toBeDisabled();
    await page
      .getByText("Hermes connection setup (Markdown guide)", { exact: true })
      .click();
    await expect(page.locator("#remote-guide")).toContainText(
      "Only these users",
    );
    await page.locator("#hermes-ssh-target").fill("operator@100.101.102.103");
    const hold = setup.hold("discovery", reject);
    await page.locator("#discover-hermes-profiles").click();
    await setup.waitFor("discovery");
    await page
      .locator("#hermes-ssh-target")
      .fill("operator@other.example.ts.net");
    hold.release();
    await expect(page.locator("#discover-hermes-profiles")).toBeEnabled();
    await expect(page.locator("#hermes-outcome")).toContainText("Changed");
    await expect(page.locator("#hermes-profile")).toBeDisabled();
    for (const [role, value] of Object.entries(canaries))
      await expect(page.locator(`#${role}`)).toHaveValue(value);
    await page.locator("#hermes-ssh-target").fill("operator@192.168.1.25");
    await expect(page.locator("#remote-network-note")).toContainText(
      "usually works only on that network",
    );
    expect(setup.writes).toBe(0);
  });
}

test("remote actual-route journey scopes outcomes, keeps drafts and renders a readable guide", async ({
  page,
  setup,
}, testInfo) => {
  await enterDraft(page);
  await page.locator("#hermes-mode").selectOption("ssh");
  await page.locator("#hermes-ssh-target").fill("operator@100.101.102.103");
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText("passed");
  await page.locator("#discover-hermes-profiles").click();
  await expect(page.locator("#hermes-outcome")).toContainText(
    "Connected — models loaded",
  );
  await expect(page.locator("#hermes-profile")).toHaveValue("");
  await expect(page.locator("#test-hermes-assistant")).toBeDisabled();
  await page.locator("#hermes-profile").selectOption("everyday");
  await page.locator("#test-hermes-assistant").click();
  await expect(page.locator("#assistant-outcome")).toContainText("passed");
  expect(setup.calls[1]?.input).toMatchObject({
    mode: "ssh",
    sshTarget: "operator@100.101.102.103",
  });
  const failure = setup.hold("assistant", true);
  await page.locator("#test-hermes-assistant").click();
  failure.release();
  await expect(page.locator("#assistant-outcome")).toContainText("failed");
  await expect(page.locator("#hermes-outcome")).toContainText("models loaded");
  await expect(page.locator("#recall-outcome")).toContainText("passed");
  for (const [role, value] of Object.entries(canaries))
    await expect(page.locator(`#${role}`)).toHaveValue(value);
  await page.locator("#hermes-heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("remote-outcomes.png") });
  await page.setViewportSize({ width: 420, height: 850 });
  await page.locator("#remote-guide > summary").focus();
  await page.screenshot({
    path: testInfo.outputPath("remote-narrow-focus.png"),
  });
  await page.locator("#remote-guide > summary").click();
  await expect(page.locator("#remote-guide")).toContainText("API_SERVER_KEY");
  const remoteRecipe = page.locator('section[aria-labelledby="another-mac"]');
  await page.getByRole("link", { name: "Another Mac", exact: true }).click();
  await expect(page.locator("#another-mac")).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("remote-preparation.png"),
  });
  await expect(remoteRecipe).toContainText("interview Mac's local clipboard");
  await expect(remoteRecipe).toContainText("acquire-hermes.py");
  const pathCheck = [
    ...readFileSync("docs/hermes-connection-setup.md", "utf8").matchAll(
      /```bash\n([\s\S]*?)\n```/g,
    ),
  ].find((match) => match[1]?.includes("--public-key"))?.[1];
  expect(pathCheck).toBeTruthy();
  const renderedCheck = remoteRecipe
    .locator("pre")
    .filter({ hasText: "--public-key" });
  await expect(renderedCheck).toBeVisible();
  expect(await renderedCheck.textContent()).toBe(pathCheck);
  await expect(remoteRecipe).toContainText("ALREADY_ENROLLED");

  const acquisition = remoteRecipe
    .getByRole("textbox", {
      name: "Copy complete command",
    })
    .filter({ hasText: "--copy" });
  await expect(acquisition).toBeVisible();
  await expect(acquisition).toContainText("--copy");
  await expect(acquisition).toContainText(
    '--ssh "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}"',
  );
  const expectedRemote = [
    ...readFileSync("docs/hermes-connection-setup.md", "utf8").matchAll(
      /```command\n([\s\S]*?)\n```/g,
    ),
  ][1]?.[1];
  expect(await acquisition.inputValue()).toBe(expectedRemote);
  await acquisition.focus();
  await acquisition.press("ControlOrMeta+A");
  expect(
    await acquisition.evaluate((el: HTMLTextAreaElement) =>
      el.value.slice(el.selectionStart, el.selectionEnd),
    ),
  ).toBe(expectedRemote);
  await acquisition.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("remote-acquisition.png"),
  });
  for (const [role, value] of Object.entries(canaries))
    await expect(page.locator(`#${role}`)).toHaveValue(value);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(setup.writes).toBe(0);
});

for (const [failure, code] of [
  ["denied", "keychain_access_denied"],
  ["timeout", "keychain_unavailable"],
  ["mismatch", "keychain_write_failed"],
] as const) {
  test(`green assistant then native ${failure} retains draft and diagnoses Save`, async ({
    page,
    setup,
  }) => {
    await enterDraft(page);
    await checkAll(page);
    setup.setNativeFailure(failure);
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/setup/connections") &&
        r.request().method() === "PUT",
    );
    await page.locator("#save-connections").click();
    const body = await (await response).json();
    expect(body.code).toBe(code);
    await expect(page.locator("#setup-message")).toContainText(code);
    expect(JSON.stringify(body)).not.toMatch(
      /synthetic-private|wrong-synthetic|canary/,
    );
    await expect(page.locator("#setup-message")).toContainText(
      "Your unsaved entries are still here",
    );
    for (const [role, value] of Object.entries(canaries)) {
      await expect(page.locator(`#${role}`)).toHaveValue(value);
      await expect(page.locator(`#${role}`)).toHaveAttribute(
        "type",
        "password",
      );
    }
    expect(setup.commits).toBe(0);
    expect(await setup.authority()).toBeNull();
    expect(setup.calls.some((call) => call.kind === "reload")).toBe(false);
    setup.setNativeFailure(null);
    await page.locator("#save-connections").click();
    await expect(
      page.getByRole("heading", { name: "Fixture runtime replaced" }),
    ).toBeVisible();
    expect(setup.commits).toBe(1);
  });
}

for (const width of [1100, 390]) {
  test(`setup focus touches the input at ${width}px and base path is independent of model`, async ({
    page,
    setup,
  }, testInfo) => {
    void setup;
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: testInfo.outputPath(`actual-route-header-${width}.png`),
    });
    const css = await page.evaluate(async () =>
      (await fetch("/setup.css")).text(),
    );
    writeFileSync(testInfo.outputPath(`actual-route-${width}.css`), css);
    const geometry = await page.evaluate(() =>
      ["main", "header", "#recall-api-key"].map((selector) => {
        const el = document.querySelector(selector)!;
        const rect = el.getBoundingClientRect();
        return {
          selector,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      }),
    );
    writeFileSync(
      testInfo.outputPath(`actual-route-${width}.json`),
      JSON.stringify(geometry, null, 2),
    );
    await page.getByLabel("Where Hermes runs").selectOption("local");
    await page.locator("#hermes-endpoint-path").scrollIntoViewIfNeeded();
    await expect(page.getByLabel("API base path")).toHaveValue("/");
    await expect(page.getByLabel("API base path")).toBeVisible();
    expect(readFileSync("docs/hermes-connection-setup.md", "utf8")).toContain(
      "does not imply `/p/assistant`",
    );
    for (const id of [
      "ngrok-domain",
      "recall-api-key",
      "hermes-endpoint-path",
    ]) {
      const field = page.locator(`#${id}`);
      await field.focus();
      expect(
        await field.evaluate((el) => getComputedStyle(el).outlineOffset),
      ).toBe("0px");
      expect(
        await field.evaluate((el) => getComputedStyle(el).outlineWidth),
      ).toBe("3px");
      await page.screenshot({
        path: testInfo.outputPath(`focus-${id}-${width}.png`),
      });
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("root listener exposes marty without deriving a multiplex path", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  await page.getByRole("button", { name: "Load models" }).click();
  await expect(page.locator("#hermes-outcome")).toContainText("models loaded");
  await page.getByLabel("Model", { exact: true }).selectOption("marty");
  await page.getByRole("button", { name: "Test assistant" }).click();
  await expect(page.locator("#assistant-outcome")).toContainText(
    "Assistant test passed",
  );
  await expect(page.getByLabel("API base path")).toHaveValue("/");
  expect(
    setup.calls.find((call) => call.kind === "assistant")?.input,
  ).toMatchObject({ baseUrl: "http://127.0.0.1:8642", profile: "marty" });
});

test("storage code is visible through the real Save route with drafts retained", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  await checkAll(page);
  setup.setStorageFailure(true);
  await page.locator("#save-connections").click();
  await expect(page.locator("#setup-message")).toContainText(
    "settings_storage_unavailable",
  );
  await expect(page.locator("#setup-message")).not.toContainText(
    "synthetic-private-path",
  );
  for (const [role, value] of Object.entries(canaries))
    await expect(page.locator(`#${role}`)).toHaveValue(value);
  expect(setup.commits).toBe(0);
});

for (const code of [
  "http_status",
  "timeout",
  "dns_failed",
  "tls_certificate_failed",
  "tls_protocol_failed",
  "connection_refused",
  "connection_reset",
  "network_unreachable",
  "connect_failed",
  "not_attempted",
  "ngrok_start_failed",
  "ngrok_domain_mismatch",
  "local_listener_failed",
] as const) {
  test(`callback diagnostic ${code} is visible through the real route`, async ({
    page,
    setup,
  }) => {
    await enterDraft(page);
    setup.setCallbackDiagnostic({
      code,
      ...(code === "http_status" ? { httpStatus: 502 } : {}),
    });
    await page.locator("#test-connections").click();
    const warningCodes = new Set([
      "http_status",
      "timeout",
      "dns_failed",
      "tls_certificate_failed",
      "tls_protocol_failed",
      "connection_refused",
      "connection_reset",
      "network_unreachable",
      "connect_failed",
    ]);
    await expect(page.locator("#recall-outcome")).toContainText(
      warningCodes.has(code) ? "Warning" : "failed",
    );
    await page.locator("#component-results").evaluate((el) => {
      const details = el.closest("details");
      if (details) details.open = true;
    });
    await expect(page.locator("#component-results")).toContainText(code);
    await expect(page.locator("#callback-report")).toHaveValue(/Next action:/);
    await expect(page.locator("#callback-report")).toHaveValue(
      /Safety: do not disable protection globally/,
    );
    if (code === "http_status")
      await expect(page.locator("#component-results")).toContainText(
        "HTTP 502",
      );
    for (const [role, value] of Object.entries(canaries))
      await expect(page.locator(`#${role}`)).toHaveValue(value);
    expect(setup.commits).toBe(0);
  });
}

test("failed public route produces a copyable private-safe report and edits stale it", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setCallbackDiagnostic({ code: "tls_protocol_failed" });
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Warning — Setup not fully verified",
  );
  await expect(page.locator("#recall-outcome")).toContainText(
    "solo Meet or personal Teams call",
  );
  await expect(page.locator("#recall-details")).not.toHaveAttribute("open", "");
  const report = page.locator("#callback-report");
  await expect(report).not.toBeVisible();
  await expect(report).toHaveValue(
    /Recall credentials: authenticated_read_only/,
  );
  await expect(report).toHaveValue(
    /Public callback: failed \[tls_protocol_failed\]/,
  );
  await expect(report).toHaveValue(/does not prove Recall delivery/);
  await expect(report).toHaveValue(/Overall severity: warning/);
  await expect(report).toHaveValue(
    /real private Meet or personal Teams test call/,
  );
  await expect(report).not.toHaveValue(
    /fixture\.ngrok|synthetic-.*canary|https:\/\//,
  );
  const copy = page.getByRole("button", {
    name: "Copy the secret-free diagnostic summary for your agent",
  });
  await copy.focus();
  expect(await copy.evaluate((el) => getComputedStyle(el).outlineOffset)).toBe(
    "0px",
  );
  await copy.click();
  await expect(page.locator("#copy-callback-report-status")).toContainText(
    "Copied",
  );
  await page.locator("#ngrok-domain").fill("changed.example.test");
  await expect(report).toBeHidden();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Changed — test again",
  );
});

test("authentication failure, unavailable Recall, and mixed failures remain blocking", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setRecallCredentialState("authentication_rejected");
  setup.setCallbackDiagnostic({ code: "connection_reset" });
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Recall authentication was rejected",
  );
  await expect(page.locator("#recall-outcome")).not.toContainText("Warning");
  await expect(page.locator("#recall-details")).toHaveAttribute("open", "");
  await expect(page.locator("#callback-report")).toHaveValue(
    /Overall severity: failure/,
  );
  await expect(page.locator("#callback-report")).not.toHaveValue(
    /real private Meet or personal Teams test call/,
  );

  setup.setRecallCredentialState("unavailable");
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Recall authentication could not be verified",
  );
  await expect(page.locator("#recall-outcome")).not.toContainText(
    "API key was rejected",
  );
});

test("malformed connection results fail closed and open diagnostics", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setMalformedConnectionResult(true);
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Connection checks failed",
  );
  await expect(page.locator("#recall-outcome")).not.toContainText("Warning");
  await expect(page.locator("#recall-details")).toHaveAttribute("open", "");
  await expect(page.locator("#callback-report")).toHaveValue(
    /Overall severity: failure/,
  );
});

type SyntheticConnectionResult = {
  recallCredentials?: Record<string, unknown>;
  localWebhook?: Record<string, unknown>;
  ngrokEndpoint?: Record<string, unknown>;
  publicWebhook?: Record<string, unknown>;
};
const validConnectionResult = (): SyntheticConnectionResult => ({
  recallCredentials: { state: "authenticated_read_only" },
  localWebhook: { state: "verified_synthetic" },
  ngrokEndpoint: { state: "verified_exact_domain" },
  publicWebhook: { state: "verified_synthetic" },
});

for (const [name, mutate] of [
  [
    "missing Recall",
    (value: SyntheticConnectionResult) => delete value.recallCredentials,
  ],
  [
    "missing local callback",
    (value: SyntheticConnectionResult) => delete value.localWebhook,
  ],
  [
    "missing ngrok endpoint",
    (value: SyntheticConnectionResult) => delete value.ngrokEndpoint,
  ],
  [
    "missing public callback",
    (value: SyntheticConnectionResult) => delete value.publicWebhook,
  ],
  [
    "local success with failure diagnostic",
    (value: SyntheticConnectionResult) => {
      value.localWebhook!.diagnostic = { code: "local_listener_failed" };
    },
  ],
  [
    "ngrok success with failure diagnostic",
    (value: SyntheticConnectionResult) => {
      value.ngrokEndpoint!.diagnostic = { code: "ngrok_domain_mismatch" };
    },
  ],
  [
    "public success with failure diagnostic",
    (value: SyntheticConnectionResult) => {
      value.publicWebhook!.diagnostic = { code: "connection_reset" };
    },
  ],
  [
    "HTTP 204 reported as failure",
    (value: SyntheticConnectionResult) => {
      value.publicWebhook = {
        state: "failed",
        diagnostic: { code: "http_status", httpStatus: 204 },
      };
    },
  ],
  [
    "HTTP status missing",
    (value: SyntheticConnectionResult) => {
      value.publicWebhook = {
        state: "failed",
        diagnostic: { code: "http_status" },
      };
    },
  ],
  [
    "HTTP status string",
    (value: SyntheticConnectionResult) => {
      value.publicWebhook = {
        state: "failed",
        diagnostic: { code: "http_status", httpStatus: "302" },
      };
    },
  ],
  [
    "HTTP status out of range",
    (value: SyntheticConnectionResult) => {
      value.publicWebhook = {
        state: "failed",
        diagnostic: { code: "http_status", httpStatus: 700 },
      };
    },
  ],
  [
    "transport code with HTTP status",
    (value: SyntheticConnectionResult) => {
      value.publicWebhook = {
        state: "failed",
        diagnostic: { code: "connection_reset", httpStatus: 502 },
      };
    },
  ],
] as const) {
  test(`inconsistent result fails closed: ${name}`, async ({ page, setup }) => {
    await enterDraft(page);
    const value = validConnectionResult();
    mutate(value);
    setup.setConnectionResult(value);
    await page.locator("#test-connections").click();
    await expect(page.locator("#recall-outcome")).toContainText(
      "Connection checks failed",
    );
    await expect(page.locator("#recall-outcome")).not.toContainText("Warning");
    await expect(page.locator("#callback-report")).toHaveValue(
      /Overall severity: failure/,
    );
    await expect(page.locator("#callback-report")).toHaveValue(
      /Result: component evidence was missing or inconsistent; whether a public callback was attempted is unknown/,
    );
  });
}

for (const [name, publicWebhook, privateValue] of [
  [
    "HTTP status string canary",
    {
      state: "failed",
      diagnostic: {
        code: "http_status",
        httpStatus: "SYNTHETIC_PRIVATE_CANARY",
      },
    },
    "SYNTHETIC_PRIVATE_CANARY",
  ],
  [
    "unknown state canary",
    { state: "SYNTHETIC_PRIVATE_STATE" },
    "SYNTHETIC_PRIVATE_STATE",
  ],
  [
    "success with contradictory diagnostic",
    {
      state: "verified_synthetic",
      diagnostic: { code: "connection_reset" },
    },
    "connection reset",
  ],
  ["failed without diagnostic", { state: "failed" }, "Could not connect"],
  [
    "failed with invalid diagnostic",
    { state: "failed", diagnostic: { code: "SYNTHETIC_PRIVATE_CODE" } },
    "SYNTHETIC_PRIVATE_CODE",
  ],
] as const) {
  test(`invalid public evidence renders consistently: ${name}`, async ({
    page,
    setup,
  }) => {
    await enterDraft(page);
    setup.setConnectionResult({
      ...validConnectionResult(),
      publicWebhook,
    });
    await page.locator("#test-connections").click();
    await expect(page.locator("#component-results")).toContainText(
      "Public callback: unverified",
    );
    await expect(page.locator("#callback-report")).toHaveValue(
      /Public callback: unverified/,
    );
    await expect(page.locator("#component-results")).not.toContainText(
      privateValue,
    );
    await expect(page.locator("#callback-report")).not.toHaveValue(
      new RegExp(privateValue),
    );
  });
}

test("valid component errors stay precise beside malformed evidence", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setConnectionResult({
    ...validConnectionResult(),
    localWebhook: { state: "SYNTHETIC_PRIVATE_STATE" },
    publicWebhook: {
      state: "failed",
      diagnostic: { code: "connection_reset" },
    },
  });
  await page.locator("#test-connections").click();
  await expect(page.locator("#component-results")).toContainText(
    "Local callback: unverified",
  );
  await expect(page.locator("#callback-report")).toHaveValue(
    /Local callback: unverified/,
  );
  await expect(page.locator("#component-results")).toContainText(
    "Connection reset",
  );
  await expect(page.locator("#callback-report")).toHaveValue(
    /Public callback: failed \[connection_reset\]/,
  );
  await expect(page.locator("#component-results")).not.toContainText(
    "SYNTHETIC_PRIVATE_STATE",
  );
});

test("redirect and non-204 HTTP results are warnings", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  for (const httpStatus of [302, 503]) {
    const value = validConnectionResult();
    value.publicWebhook = {
      state: "failed",
      diagnostic: { code: "http_status", httpStatus },
    } as never;
    setup.setConnectionResult(value);
    await page.locator("#test-connections").click();
    await expect(page.locator("#recall-outcome")).toContainText("Warning");
    await expect(page.locator("#callback-report")).toHaveValue(
      new RegExp(`HTTP ${httpStatus}`),
    );
  }
});

test("mixed prerequisite failures dominate an attempted public failure", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setConnectionResult({
    recallCredentials: { state: "authenticated_read_only" },
    localWebhook: {
      state: "failed",
      diagnostic: { code: "local_listener_failed" },
    },
    ngrokEndpoint: {
      state: "failed",
      diagnostic: { code: "ngrok_start_failed" },
    },
    publicWebhook: {
      state: "failed",
      diagnostic: { code: "connection_reset" },
    },
  });
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText("failed");
  await expect(page.locator("#recall-outcome")).not.toContainText("Warning");
  await expect(page.locator("#callback-report")).not.toHaveValue(
    /real private Meet or personal Teams test call/,
  );
});

test("disclosure and copied evidence reset on edit and held rerun", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setLocalListenerFailure(true);
  await page.locator("#test-connections").click();
  await page.locator("#copy-callback-report").click();
  await expect(page.locator("#recall-details")).toHaveAttribute("open", "");
  await page.locator("#ngrok-domain").fill("changed.ngrok.app");
  await expect(page.locator("#recall-details")).not.toHaveAttribute("open", "");
  await expect(page.locator("#callback-report")).toHaveValue("");
  await expect(page.locator("#copy-callback-report-status")).toHaveText("");

  setup.setLocalListenerFailure(false);
  setup.setCallbackDiagnostic({ code: "connection_reset" });
  await page.locator("#test-connections").click();
  await page.locator("#recall-details > summary").click();
  const rerun = setup.hold("recall");
  await page.locator("#test-connections").click();
  await setup.waitFor("recall", 3);
  await expect(page.locator("#test-connections")).toBeDisabled();
  await expect(page.locator("#recall-details")).not.toHaveAttribute("open", "");
  await expect(page.locator("#callback-report")).toHaveValue("");
  await page.locator("#ngrok-domain").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "newer.ngrok.app";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  rerun.release();
  await setup.waitForFinished("recall", 3);
  await expect(page.locator("#test-connections")).toBeEnabled();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Changed — test again",
  );
  await expect(page.locator("#callback-report")).toHaveValue("");
});

test("request failure expands bounded diagnostics after a collapsed result", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setCallbackDiagnostic({ code: "connection_reset" });
  await page.locator("#test-connections").click();
  setup.hold("recall", true).release();
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText("✕");
  await expect(page.locator("#recall-details")).toHaveAttribute("open", "");
  await expect(page.locator("#component-results")).toContainText(
    "The connection test could not complete",
  );
  await expect(page.locator("#component-results")).not.toContainText(
    "Synthetic adapter rejection",
  );
});

test("warning remains advisory and complete settings can still save", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setCallbackDiagnostic({ code: "connection_reset" });
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText("Warning");
  await page.locator("#discover-hermes-profiles").click();
  await page.locator("#hermes-profile").selectOption("everyday");
  await page.locator("#test-hermes-assistant").click();
  await expect(page.locator("#assistant-outcome")).toContainText(
    "Assistant test passed",
  );
  await page.locator("#save-connections").click();
  await expect.poll(() => setup.commits).toBe(1);
  await expect(
    page.getByRole("heading", { name: "Fixture runtime replaced" }),
  ).toBeVisible();
});

test("revised setup keeps the warning concise and separates Save from Reset", async ({
  page,
  setup,
}) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await enterDraft(page);
  setup.setCallbackDiagnostic({ code: "connection_reset" });
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toHaveText(
    "⚠ Warning — Setup not fully verified. Make a solo Meet or personal Teams call and check that transcript text appears.",
  );
  await expect(page.locator("#callback-report")).not.toBeVisible();
  await expect(page.locator("#copy-callback-report")).toBeVisible();
  await expect(page.locator("#hermes-heading").locator("..")).not.toContainText(
    "Full MagicDNS names also work",
  );
  const saveBox = await page.locator("#save-connections").boundingBox();
  const resetBox = await page.locator("#reset").boundingBox();
  expect(saveBox).not.toBeNull();
  expect(resetBox).not.toBeNull();
  expect(resetBox!.y).toBeGreaterThan(saveBox!.y + saveBox!.height + 32);
  await expect(page.locator(".save-row")).toHaveCSS("border-top-width", "0px");
});

test("every setup error offers a current bounded agent copy", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          (
            window as typeof window & { copiedSetupDiagnostic?: string }
          ).copiedSetupDiagnostic = value;
          return Promise.resolve();
        },
      },
    });
  });
  const copied = () =>
    page.evaluate(
      () =>
        (window as typeof window & { copiedSetupDiagnostic?: string })
          .copiedSetupDiagnostic ?? "",
    );
  const expectSafeCopy = async (button: string, operation: RegExp) => {
    await page.locator(button).click();
    await expect.poll(copied).toMatch(operation);
    expect(await copied()).not.toMatch(
      /synthetic-private|synthetic-recall-canary|fixture\.ngrok\.app|\/Volumes\//,
    );
  };

  setup.hold("recall", true).release();
  await page.locator("#test-connections").click();
  await expectSafeCopy("#copy-callback-report", /Recall and ngrok test/);

  setup.hold("discovery", true).release();
  await page.locator("#discover-hermes-profiles").click();
  await expectSafeCopy("#copy-hermes-report", /Hermes model discovery/);

  await page.locator("#discover-hermes-profiles").click();
  await page.locator("#hermes-profile").selectOption("everyday");
  setup.hold("assistant", true).release();
  await page.locator("#test-hermes-assistant").click();
  await expectSafeCopy("#copy-assistant-report", /Hermes assistant test/);

  setup.setStorageFailure(true);
  await page.locator("#save-connections").click();
  await expectSafeCopy("#copy-setup-report", /Save settings/);
  setup.setStorageFailure(false);

  setup.hold("reset", true).release();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#reset").click();
  await expectSafeCopy("#copy-setup-report", /Reset credentials/);
  await page.locator("#ngrok-domain").fill("newer.ngrok.app");
  await expect(page.locator("#setup-report-panel")).toBeHidden();
});

test("success states truthful limits and closes earlier failure details", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setLocalListenerFailure(true);
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-details")).toHaveAttribute("open", "");
  setup.setLocalListenerFailure(false);
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Synthetic checks passed",
  );
  await expect(page.locator("#recall-details")).not.toHaveAttribute("open", "");
  await expect(page.locator("#component-results")).toContainText(
    "Synthetic only: no bot or live delivery was verified",
  );
  await expect(page.locator("#callback-report")).toHaveValue(
    /does not prove Recall delivery.*signing secret/s,
  );
});

for (const width of [1100, 390]) {
  test(`connection severity visual evidence at ${width}`, async ({
    page,
    setup,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await enterDraft(page);
    setup.setCallbackDiagnostic({ code: "connection_reset" });
    await page.locator("#test-connections").click();
    await page.screenshot({
      path: testInfo.outputPath(`connection-warning-${width}.png`),
      fullPage: true,
    });

    setup.setLocalListenerFailure(true);
    await page.locator("#test-connections").click();
    await expect(page.locator("#recall-details")).toHaveAttribute("open", "");
    await page.screenshot({
      path: testInfo.outputPath(`connection-failure-expanded-${width}.png`),
      fullPage: true,
    });

    setup.setLocalListenerFailure(false);
    setup.setCallbackDiagnostic(null);
    await page.locator("#test-connections").click();
    await page.screenshot({
      path: testInfo.outputPath(`connection-success-${width}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("diagnostic report rejects an unknown secret-like code", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setCallbackDiagnostic({
    code: "PRIVATE_TOKEN_synthetic-canary",
  } as never);
  await page.locator("#test-connections").click();
  await expect(page.locator("#recall-outcome")).toContainText(
    "Connection checks failed",
  );
  await expect(page.locator("#recall-outcome")).not.toContainText("Warning");
  await expect(page.locator("#callback-report")).toHaveValue(
    /Overall severity: failure/,
  );
  await expect(page.locator("#callback-report")).toHaveValue(
    /Public callback: unverified/,
  );
  await expect(page.locator("#callback-report")).not.toHaveValue(
    /PRIVATE_TOKEN/,
  );
});

test("diagnostic report gives truthful standalone success, not-attempted and certificate actions", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  await page.locator("#test-connections").click();
  await expect(page.locator("#callback-report")).toHaveValue(
    /Result: the signed synthetic public callback reached Caddy/,
  );
  await expect(page.locator("#callback-report")).toHaveValue(
    /Next action: no callback recovery is needed/,
  );
  await expect(page.locator("#callback-report")).not.toHaveValue(
    /compare the route once on another trusted network/,
  );

  setup.setNgrokStartupFailure(true);
  await page.locator("#test-connections").click();
  await expect(page.locator("#callback-report")).toHaveValue(
    /Result: the public callback was not attempted because an earlier prerequisite failed/,
  );
  await expect(page.locator("#callback-report")).toHaveValue(
    /Next action: check the ngrok authtoken, stable domain and domain ownership/,
  );
  await expect(page.locator("#callback-report")).not.toHaveValue(
    /this Mac sent a signed synthetic HTTPS callback/,
  );
  await expect(page.locator("#callback-report")).not.toHaveValue(
    /temporary tunnel closes after the test/,
  );

  setup.setNgrokStartupFailure(false);
  setup.setLocalListenerFailure(true);
  await page.locator("#test-connections").click();
  await expect(page.locator("#callback-report")).toHaveValue(
    /Result: the public callback was not attempted because an earlier prerequisite failed/,
  );
  await expect(page.locator("#callback-report")).not.toHaveValue(
    /because ngrok endpoint setup failed/,
  );
  await expect(page.locator("#component-results")).toContainText(
    "Not attempted; an earlier step failed",
  );

  setup.setLocalListenerFailure(false);
  setup.setCallbackDiagnostic({ code: "tls_certificate_failed" });
  await page.locator("#test-connections").click();
  await expect(page.locator("#callback-report")).toHaveValue(
    /Next action: check this Mac’s clock and the trusted or managed-network certificate policy/,
  );
  await expect(page.locator("#callback-report")).toHaveValue(
    /Do not bypass certificate verification/,
  );
});

test("clipboard denial leaves the complete report selected for manual copy", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setCallbackDiagnostic({ code: "connection_reset" });
  await page.locator("#test-connections").click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
  });
  await page.locator("#copy-callback-report").click();
  await expect(page.locator("#copy-callback-report-status")).toContainText(
    "Press Command-C to copy the selected summary",
  );
  await expect(page.locator("#callback-report")).toBeFocused();
  expect(
    await page.locator("#callback-report").evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return field.selectionEnd - field.selectionStart === field.value.length;
    }),
  ).toBe(true);
});

for (const width of [1100, 390]) {
  test(`diagnostic copy controls have border-attached focus at ${width}`, async ({
    page,
    setup,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await enterDraft(page);
    setup.setCallbackDiagnostic({ code: "connection_reset" });
    await page.locator("#test-connections").click();
    await page.locator("#test-connections").focus();
    for (const id of ["copy-callback-report"]) {
      const control = page.locator(`#${id}`);
      await control.scrollIntoViewIfNeeded();
      for (let presses = 0; presses < 5; presses++) {
        if (await control.evaluate((el) => el === document.activeElement))
          break;
        await page.keyboard.press("Tab");
      }
      await expect(control).toBeFocused();
      expect(await control.evaluate((el) => el.matches(":focus-visible"))).toBe(
        true,
      );
      expect(
        await control.evaluate((el) => getComputedStyle(el).outlineOffset),
      ).toBe("0px");
      expect(
        await control.evaluate((el) => getComputedStyle(el).outlineWidth),
      ).toBe("3px");
      const box = await control.boundingBox();
      const viewport = page.viewportSize();
      expect(box).not.toBeNull();
      expect(viewport).not.toBeNull();
      const margin = 8;
      const x = Math.max(0, (box?.x ?? 0) - margin);
      const y = Math.max(0, (box?.y ?? 0) - margin);
      const right = Math.min(
        viewport?.width ?? 0,
        (box?.x ?? 0) + (box?.width ?? 0) + margin,
      );
      const bottom = Math.min(
        viewport?.height ?? 0,
        (box?.y ?? 0) + (box?.height ?? 0) + margin,
      );
      expect(x).toBeLessThan(box?.x ?? 0);
      expect(y).toBeLessThan(box?.y ?? 0);
      expect(right).toBeGreaterThan((box?.x ?? 0) + (box?.width ?? 0));
      expect(bottom).toBeGreaterThan((box?.y ?? 0) + (box?.height ?? 0));
      await page.screenshot({
        path: testInfo.outputPath(`attached-focus-${id}-${width}.png`),
        clip: { x, y, width: right - x, height: bottom - y },
      });
    }
  });
}

for (const width of [1100, 390]) {
  test(`local acquisition remains accessible with retained drafts at ${width}`, async ({
    page,
    setup,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await enterDraft(page);
    await expect(page.locator("#hermes-mode")).toHaveValue("local");
    await expect(page.locator("#remote-fields")).toBeHidden();
    const initialUrl = page.url();
    await page.locator("#remote-guide > summary").click();
    const local = page.locator('section[aria-labelledby="this-mac"]');
    await page.getByRole("link", { name: "This Mac", exact: true }).click();
    await expect(page.locator("#this-mac")).toBeFocused();
    await expect(local).toContainText("python3 --version");
    await expect(local).toContainText("already running Hermes");
    await expect(local).toContainText("acquire-hermes.py");
    const acquisition = local.getByRole("textbox", {
      name: "Copy complete command",
    });
    await expect(acquisition).toBeVisible();
    await expect(acquisition).not.toContainText("--ssh");
    await expect(local).toContainText("API_SERVER_KEY");
    await expect(acquisition).toContainText("--copy");
    const expectedLocal = [
      ...readFileSync("docs/hermes-connection-setup.md", "utf8").matchAll(
        /```command\n([\s\S]*?)\n```/g,
      ),
    ][0]?.[1];
    expect(await acquisition.inputValue()).toBe(expectedLocal);
    await acquisition.focus();
    await acquisition.press("ControlOrMeta+A");
    expect(
      await acquisition.evaluate((el: HTMLTextAreaElement) =>
        el.value.slice(el.selectionStart, el.selectionEnd),
      ),
    ).toBe(expectedLocal);
    await acquisition.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`local-acquisition-${width}.png`),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator("#remote-guide > summary").click();
    expect(page.url().split("#")[0]).toBe(initialUrl);
    for (const [role, value] of Object.entries(canaries))
      await expect(page.locator(`#${role}`)).toHaveValue(value);
    expect(setup.calls).toHaveLength(0);
    expect(setup.writes).toBe(0);
  });
}

for (const mode of ["local", "ssh"]) {
  test(`guide continuation gives one README return with retained ${mode} draft`, async ({
    page,
    setup,
  }) => {
    await enterDraft(page);
    await page.locator("#hermes-mode").selectOption(mode);
    const initialUrl = page.url();
    await page.locator("#remote-guide > summary").click();
    await expect(page.locator("#remote-guide details")).toHaveCount(0);
    for (const title of ["This Mac", "Another Mac"]) {
      await page.getByRole("link", { name: title, exact: true }).click();
      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeFocused();
    }
    const guide = page.locator(
      `section[aria-labelledby="${mode === "local" ? "this-mac" : "another-mac"}"]`,
    );
    expect(
      (await page.locator("#remote-guide").textContent())?.match(
        /README — Save and choose a workspace/g,
      ),
    ).toHaveLength(1);
    const source =
      readFileSync("docs/hermes-connection-setup.md", "utf8")
        .split(`## ${mode === "local" ? "This Mac" : "Another Mac"}\n`)[1]
        ?.split("\n## ")[0] ?? "";
    const commands = [
      ...source.matchAll(/```(?:bash|command)\n([\s\S]*?)\n```/g),
    ].map((match) => match[1]);
    expect(
      await guide
        .locator("pre, textarea")
        .evaluateAll((elements) =>
          elements.map((element) =>
            element instanceof HTMLTextAreaElement
              ? element.value
              : element.textContent,
          ),
        ),
    ).toEqual(commands);
    await expect(page.locator("#remote-guide")).toContainText(
      "Finish the Hermes section",
    );
    await expect(page.locator("#remote-guide")).toContainText(
      "There is no separate Save in this guide",
    );
    await page.locator("#remote-guide > summary").click();
    expect(page.url().split("#")[0]).toBe(initialUrl);
    for (const [role, value] of Object.entries(canaries))
      await expect(page.locator(`#${role}`)).toHaveValue(value);
    expect(setup.calls).toHaveLength(0);
    expect(setup.writes).toBe(0);
  });
}
