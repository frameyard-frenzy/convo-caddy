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
