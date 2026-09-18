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
    await expect(
      page.getByText(/^Root \/ with model assistant does not imply/),
    ).toBeVisible();
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
    await expect(page.locator("#recall-outcome")).toContainText("failed");
    await page.locator("#component-results").evaluate((el) => {
      const details = el.closest("details");
      if (details) details.open = true;
    });
    await expect(page.locator("#component-results")).toContainText(code);
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
    "public callback network route failed",
  );
  const report = page.locator("#callback-report");
  await expect(report).toBeVisible();
  await expect(report).toHaveValue(
    /Recall credentials: authenticated_read_only/,
  );
  await expect(report).toHaveValue(
    /Public callback: failed \[tls_protocol_failed\]/,
  );
  await expect(report).toHaveValue(/does not prove Recall delivery/);
  await expect(report).not.toHaveValue(
    /fixture\.ngrok|synthetic-.*canary|https:\/\//,
  );
  const copy = page.getByRole("button", { name: "Copy diagnostic summary" });
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

test("diagnostic report rejects an unknown secret-like code", async ({
  page,
  setup,
}) => {
  await enterDraft(page);
  setup.setCallbackDiagnostic({
    code: "PRIVATE_TOKEN_synthetic-canary",
  } as never);
  await page.locator("#test-connections").click();
  await expect(page.locator("#callback-report")).toHaveValue(
    /\[connect_failed\]/,
  );
  await expect(page.locator("#callback-report")).not.toHaveValue(
    /PRIVATE_TOKEN/,
  );
});

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
