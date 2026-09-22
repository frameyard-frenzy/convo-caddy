import { expect, test, type Page } from "@playwright/test";

// Renderer-only fault injection. setup-acceptance.spec.ts proves real storage,
// authenticated routes, provider draft reuse, and actual runtime replacement.
const url = `http://127.0.0.1:${process.env.CONVO_CADDY_SETUP_FIXTURE_PORT ?? 4318}`;
const overview = {
  mode: "setup_required",
  configured: {},
  ngrokDomain: "fixture.ngrok.app",
  hermesMode: "local",
  hermesLocalPort: 8642,
  hermesRemotePort: 8642,
  hermesEndpointPath: "/",
  hermesProfile: "everyday",
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function boot(page: Page) {
  await page.context().addCookies([
    {
      name: "convo_caddy_launch",
      value: "setup_fixture_token_12345678901234567890123",
      url,
    },
  ]);
  await page.route("**/api/setup", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.goto(url);
  await expect(page.locator("#ngrok-domain")).toHaveValue("fixture.ngrok.app");
}
async function draft(page: Page) {
  await page.locator("#recall-api-key").fill("synthetic-recall");
  await page
    .locator("#recall-webhook-verification-secret")
    .fill("whsec_c3ludGhldGlj");
  await page.locator("#ngrok-authtoken").fill("synthetic-ngrok");
  await page.locator("#hermes-api-key").fill("synthetic-hermes");
}

async function selectModelAfterKeyEdit(page: Page) {
  await page.route("**/api/setup/connections/hermes/discover", (route) =>
    route.fulfill({
      json: { state: "profiles_advertised", profiles: ["everyday"] },
    }),
  );
  await page.locator("#discover-hermes-profiles").click();
  await expect(page.locator("#hermes-outcome")).toContainText("models loaded");
  await page.locator("#hermes-profile").selectOption("everyday");
}

test("save owns secondary controls until confirmation and acknowledgement", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  await selectModelAfterKeyEdit(page);
  const pending = gate();
  await page.route("**/api/setup/connections", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      hermesMode: "local",
      hermesProfile: "everyday",
      hermesApiKey: "synthetic-hermes",
    });
    await pending.promise;
    await route.fulfill({ json: overview });
  });
  await page.route("**/api/setup/save-acknowledgement", (route) =>
    route.fulfill({ status: 202, json: { accepted: true } }),
  );
  try {
    await page.locator("#save-connections").click();
    for (const id of ["reload", "reset"])
      await expect(page.locator(`#${id}`)).toBeDisabled();
    await expect(page.locator("#recall-api-key")).toHaveValue(
      "synthetic-recall",
    );
  } finally {
    pending.release();
  }
  await expect(page.locator("#setup-message")).toContainText("Settings saved");
  await expect(page.locator("#recall-api-key")).toHaveValue("");
  await expect(page.locator("#recall-api-key")).toBeDisabled();
});

test("acknowledgement response loss never unlocks a page that may be reloading", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  await selectModelAfterKeyEdit(page);
  await page.route("**/api/setup/connections", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      hermesMode: "local",
      hermesProfile: "everyday",
      hermesApiKey: "synthetic-hermes",
    });
    return route.fulfill({ json: overview });
  });
  await page.route("**/api/setup/save-acknowledgement", (route) =>
    route.abort("connectionreset"),
  );
  await page.locator("#save-connections").click();
  await expect(page.locator("#setup-message")).toContainText("Settings saved");
  await expect(page.locator("#setup-message")).not.toContainText(
    "save may have completed",
  );
  await expect(page.locator("#recall-api-key")).toBeDisabled();
  await expect(page.locator("#copy-setup-report")).toBeEnabled();
  await page.locator("#copy-setup-report").focus();
  await expect(page.locator("#copy-setup-report")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#copy-setup-report-status")).toHaveText("Copied");
  await expect(page.locator("#setup-report")).toHaveValue(
    /Operation: Confirm saved settings reload/,
  );
  await expect(page.locator("#setup-report")).toHaveValue(
    /Settings were saved and secret drafts were erased/,
  );
});

test("initial load failures keep edits locked but permit a keyboard copy", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "convo_caddy_launch",
      value: "setup_fixture_token_12345678901234567890123",
      url,
    },
  ]);
  await page.route("**/api/setup", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{" }),
  );
  await page.goto(url);
  await expect(page.locator("#recall-api-key")).toBeDisabled();
  await expect(page.locator("#copy-setup-report")).toBeEnabled();
  await page.locator("#copy-setup-report").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#copy-setup-report-status")).toHaveText("Copied");
  await expect(page.locator("#setup-report")).toHaveValue(
    /Operation: Load saved setup/,
  );
  await expect(page.locator("#setup-report")).not.toHaveValue(
    /fixture\.ngrok\.app|synthetic-private/,
  );
});

test("initial load rejection exposes only a fixed secret-free diagnostic", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "convo_caddy_launch",
      value: "setup_fixture_token_12345678901234567890123",
      url,
    },
  ]);
  await page.route("**/api/setup", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "synthetic-private-/Volumes/fixture.ngrok.app" },
    }),
  );
  await page.goto(url);
  await expect(page.locator("#copy-setup-report")).toBeEnabled();
  await page.locator("#copy-setup-report").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#copy-setup-report-status")).toHaveText("Copied");
  await expect(page.locator("#setup-report")).toHaveValue(/\[setup_unknown\]/);
  await expect(page.locator("#setup-report")).not.toHaveValue(
    /synthetic-private|\/Volumes\/|fixture\.ngrok\.app/,
  );
});

test("assistant renderer and clipboard retain every actual safe failure state", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  await selectModelAfterKeyEdit(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          Object.assign(window, { copiedAssistantReport: value });
          return Promise.resolve();
        },
      },
    });
  });
  const states = [
    "response_rejected",
    "profile_not_advertised",
    "authentication_rejected",
    "identity_rejected",
    "models_rejected",
    "unavailable",
    "ssh_failed",
    "forwarding_unavailable",
    "transport_unknown",
  ];
  for (const state of states) {
    await page.route("**/api/setup/connections/hermes/test", (route) =>
      route.fulfill({ json: { state } }),
    );
    await page.locator("#test-hermes-assistant").click();
    await expect(page.locator("#assistant-results")).toContainText(
      state.replaceAll("_", " "),
    );
    await expect(page.locator("#assistant-report")).toHaveValue(
      new RegExp(`\\[${state}\\]`),
    );
    await page.locator("#copy-assistant-report").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { copiedAssistantReport?: string })
              .copiedAssistantReport ?? "",
        ),
      )
      .toMatch(new RegExp(`\\[${state}\\]`));
    await page.unroute("**/api/setup/connections/hermes/test");
  }
  await page.route("**/api/setup/connections/hermes/test", (route) =>
    route.fulfill({
      json: { state: "unknown_synthetic-private_/Volumes/fixture.ngrok.app" },
    }),
  );
  await page.locator("#test-hermes-assistant").click();
  await expect(page.locator("#assistant-report")).toHaveValue(
    /\[unknown_failure\]/,
  );
  await expect(page.locator("#assistant-report")).not.toHaveValue(
    /synthetic-private|\/Volumes\/|fixture\.ngrok\.app/,
  );
  await page.locator("#copy-assistant-report").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { copiedAssistantReport?: string })
            .copiedAssistantReport ?? "",
      ),
    )
    .toMatch(/\[unknown_failure\]/);
});

test("model discovery immediately retires an old assistant report and feedback", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  await selectModelAfterKeyEdit(page);
  await page.route("**/api/setup/connections/hermes/test", (route) =>
    route.fulfill({ json: { state: "response_rejected" } }),
  );
  await page.locator("#test-hermes-assistant").click();
  await page.locator("#copy-assistant-report").click();
  await expect(page.locator("#copy-assistant-report-status")).toHaveText(
    "Copied",
  );
  const pending = gate();
  await page.route(
    "**/api/setup/connections/hermes/discover",
    async (route) => {
      await pending.promise;
      await route.fulfill({
        json: { state: "profiles_advertised", profiles: ["new"] },
      });
    },
  );
  await page.locator("#discover-hermes-profiles").click();
  await expect(page.locator("#assistant-report-panel")).toBeHidden();
  await expect(page.locator("#copy-assistant-report-status")).toHaveText("");
  pending.release();
  await expect(page.locator("#hermes-outcome")).toContainText("models loaded");
  await expect(page.locator("#assistant-report-panel")).toBeHidden();
});

test("failed held discovery cannot revive an invalidated assistant report", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  await selectModelAfterKeyEdit(page);
  await page.route("**/api/setup/connections/hermes/test", (route) =>
    route.fulfill({ json: { state: "response_rejected" } }),
  );
  await page.locator("#test-hermes-assistant").click();
  await expect(page.locator("#assistant-report-panel")).toBeVisible();
  const pending = gate();
  await page.route(
    "**/api/setup/connections/hermes/discover",
    async (route) => {
      await pending.promise;
      await route.fulfill({ status: 503, json: { code: "setup_unknown" } });
    },
  );
  await page.locator("#discover-hermes-profiles").click();
  await expect(page.locator("#assistant-report-panel")).toBeHidden();
  pending.release();
  await expect(page.locator("#hermes-report-panel")).toBeVisible();
  await expect(page.locator("#assistant-report-panel")).toBeHidden();
});

test("stale clipboard completions neither relabel nor copy replacement reports", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  await selectModelAfterKeyEdit(page);
  await page.route("**/api/setup/connections/hermes/test", (route) =>
    route.fulfill({ json: { state: "response_rejected" } }),
  );
  await page.locator("#test-hermes-assistant").click();
  await page.evaluate(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => promise },
    });
    Object.assign(window, { resolveClipboard: resolve });
  });
  await page.locator("#copy-assistant-report").click();
  await page.locator("#hermes-profile").selectOption("");
  await page.evaluate(() =>
    (
      window as typeof window & { resolveClipboard: () => void }
    ).resolveClipboard(),
  );
  await expect(page.locator("#copy-assistant-report-status")).toHaveText("");
  await expect(page.locator("#assistant-report-panel")).toBeHidden();
  await expect(page.locator("#copy-assistant-report")).not.toBeFocused();
});

test("stale clipboard rejection does not focus or fallback-copy a replacement", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  await selectModelAfterKeyEdit(page);
  await page.route("**/api/setup/connections/hermes/test", (route) =>
    route.fulfill({ json: { state: "response_rejected" } }),
  );
  await page.locator("#test-hermes-assistant").click();
  await page.evaluate(() => {
    let reject!: () => void;
    const promise = new Promise<void>((_resolve, fail) => (reject = fail));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => promise },
    });
    Object.assign(window, { rejectClipboard: reject });
  });
  await page.locator("#copy-assistant-report").click();
  await page.route("**/api/setup/connections/hermes/test", (route) =>
    route.fulfill({ json: { state: "identity_rejected" } }),
  );
  await page.locator("#test-hermes-assistant").click();
  await page.evaluate(() =>
    (
      window as typeof window & { rejectClipboard: () => void }
    ).rejectClipboard(),
  );
  await expect(page.locator("#assistant-report")).toHaveValue(
    /\[identity_rejected\]/,
  );
  await expect(page.locator("#copy-assistant-report-status")).toHaveText("");
  await expect(page.locator("#assistant-report")).not.toBeFocused();
  await expect(page.locator("#assistant-report")).not.toHaveClass(
    /manual-copy/,
  );
});

test("reset cancel preserves drafts and performs no reset mutation", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#reset").click();
  await expect(page.locator("#recall-api-key")).toHaveValue("synthetic-recall");
  await expect(page.locator("#setup-message")).toHaveText("");
});

test("successful reset returns an editable form and clears dependent evidence", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  page.on("dialog", (dialog) => dialog.accept());
  await page.route("**/api/setup/credentials", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.locator("#reset").click();
  await expect(page.locator("#setup-message")).toContainText("removed");
  await expect(page.locator("#recall-api-key")).toHaveValue("");
  await expect(page.locator("#recall-api-key")).toBeEnabled();
  await expect(page.locator("#save-connections")).toBeEnabled();
});

test("editing retires a delayed discovery without installing its models", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  page.on("dialog", (dialog) => dialog.accept());
  const pending = gate();
  await page.route(
    "**/api/setup/connections/hermes/discover",
    async (route) => {
      await pending.promise;
      await route.fulfill({
        json: { state: "profiles_advertised", profiles: ["late-model"] },
      });
    },
  );
  await page.locator("#discover-hermes-profiles").click();
  await page.locator("#hermes-api-key").fill("");
  pending.release();
  await expect(page.locator("#discover-hermes-profiles")).toBeDisabled();
  await expect(page.locator("#save-connections")).toBeEnabled();
  await expect(page.locator("#hermes-outcome")).toContainText("Changed");
  await expect(page.locator("#hermes-profile")).not.toContainText("late-model");
});

test("checks serialize actions while permitting unrelated edits without invalidation", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  const pending = gate();
  await page.route(
    "**/api/setup/connections/hermes/discover",
    async (route) => {
      await pending.promise;
      await route.fulfill({
        json: { state: "profiles_advertised", profiles: ["fixture-model"] },
      });
    },
  );
  try {
    await page.locator("#discover-hermes-profiles").click();
    await expect(page.locator("#test-connections")).toBeDisabled();
    await expect(page.locator("#save-connections")).toBeDisabled();
    await page.locator("#recall-api-key").fill("unrelated-edit");
  } finally {
    pending.release();
  }
  await expect(page.locator("#hermes-outcome")).toContainText("models loaded");
  await expect(page.locator("#recall-api-key")).toHaveValue("unrelated-edit");
  await expect(page.locator("#test-connections")).toBeEnabled();
});

test("initial overview cannot race editable draft inputs", async ({ page }) => {
  const pending = gate();
  await page.context().addCookies([
    {
      name: "convo_caddy_launch",
      value: "setup_fixture_token_12345678901234567890123",
      url,
    },
  ]);
  await page.route("**/api/setup", async (route) => {
    await pending.promise;
    await route.fulfill({ json: overview });
  });
  try {
    await page.goto(url);
    await expect(page.locator("#recall-api-key")).toBeDisabled();
  } finally {
    pending.release();
  }
  await expect(page.locator("#recall-api-key")).toBeEnabled();
});

test("approved discard cannot be vetoed before native runtime shutdown", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  expect(await page.evaluate("window.caddyPrepareClose('discard')")).toBe(
    "ready",
  );
  const prevented = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
});

test("forced-color select retains a native dropdown affordance", async ({
  page,
}) => {
  await boot(page);
  await page.emulateMedia({ forcedColors: "active" });
  await expect(page.locator("#hermes-mode")).toHaveCSS("appearance", "auto");
});

test("provider instructions contain exact account steps and callback events", async ({
  page,
}) => {
  await boot(page);
  await expect(
    page.getByText("bot.joining_call", { exact: false }),
  ).toBeAttached();
  await expect(
    page.getByText("Get these from Recall", { exact: false }),
  ).toBeAttached();
  await expect(
    page.getByText("not a per-endpoint Svix secret", { exact: false }),
  ).toBeAttached();
  await expect(page.getByLabel("Local port", { exact: true })).toBeAttached();
});

test("model selection preserves connection evidence and invalidates only assistant evidence", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  await page.route("**/api/setup/connections/hermes/discover", (route) =>
    route.fulfill({
      json: { state: "profiles_advertised", profiles: ["fixture-model"] },
    }),
  );
  await page.locator("#discover-hermes-profiles").click();
  await page.locator("#hermes-profile").selectOption("fixture-model");
  await expect(page.locator("#hermes-outcome")).toContainText("models loaded");
  await expect(page.locator("#assistant-outcome")).toContainText(
    "test assistant",
  );
});

test("native close handshake preserves settings drafts on cancel/save failure, then saves without reload", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  const invoke = (action: string) =>
    page.evaluate(
      (action) =>
        (
          window as unknown as {
            caddyPrepareClose(action: string): Promise<string>;
          }
        ).caddyPrepareClose(action),
      action,
    );
  expect(await invoke("status")).toBe("dirty");
  expect(await invoke("cancel")).toBe("clean");
  await expect(page.locator("#recall-api-key")).toHaveValue("synthetic-recall");
  let fail = true,
    acknowledgements = 0;
  await page.route("**/api/setup/save-acknowledgement", (route) => {
    acknowledgements++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/setup/connections", (route) =>
    route.fulfill(
      fail
        ? { status: 500, json: { error: "Synthetic save failure" } }
        : { json: overview },
    ),
  );
  expect(await invoke("save")).toBe("blocked");
  await expect(page.locator("#setup-message")).toContainText(
    "Synthetic save failure",
  );
  await expect(page.locator("#recall-api-key")).toHaveValue("synthetic-recall");
  await expect(page.locator("#save-connections")).toBeEnabled();
  fail = false;
  expect(await invoke("save")).toBe("ready");
  expect(acknowledgements).toBe(0);
  expect(
    await page.evaluate(() =>
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(true);
});
test("native close discard requires explicit choice and does not save settings", async ({
  page,
}) => {
  await boot(page);
  await draft(page);
  let saves = 0;
  await page.route("**/api/setup/connections", (route) => {
    saves++;
    return route.fulfill({ json: overview });
  });
  expect(
    await page.evaluate(() =>
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(false);
  expect(await page.evaluate("window.caddyPrepareClose('discard')")).toBe(
    "ready",
  );
  expect(saves).toBe(0);
  await page.evaluate("window.caddyPrepareClose('cancel')");
  await expect(page.locator("#recall-api-key")).toBeEnabled();
  expect(
    await page.evaluate(() =>
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(false);
});
