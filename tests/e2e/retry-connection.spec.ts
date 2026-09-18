import { expect, test } from "@playwright/test";

test("connection retry is explicit, locks duplicate clicks and preserves the interview draft", async ({
  page,
}) => {
  const readiness = {
    state: "ready_without_marty",
    components: {
      configuration: "ready",
      workspace: "ready",
      appServer: "ready",
      webhookServer: "ready",
      ngrok: "ready",
      hermesTunnel: "failed",
      hermes: "unavailable",
      capture: "ready",
    },
    diagnostics: [
      {
        component: "hermesTunnel",
        code: "ssh_start_failed",
        severity: "warning",
        message: "Synthetic offline host",
        action: "Restore the private network.",
      },
    ],
  };
  let retryCount = 0,
    inferenceCount = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/runtime/readiness", (route) =>
    route.fulfill({ json: { readiness } }),
  );
  await page.route("**/api/runtime/hermes/retry", async (route) => {
    retryCount++;
    await pending;
    readiness.components.hermesTunnel = "owned";
    readiness.components.hermes = "ready";
    readiness.state = "ready";
    readiness.diagnostics = [];
    await route.fulfill({ json: { readiness } });
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/api/input")) inferenceCount++;
  });
  try {
    await page.goto("/");
    await page
      .getByLabel("Command or question")
      .fill("synthetic unsent thought");
    await expect(
      page.getByRole("button", { name: "Retry connection", exact: true }),
    ).toBeVisible();
    expect(retryCount).toBe(0);
    await page
      .getByRole("button", { name: "Retry connection", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retrying connection…" }),
    ).toBeDisabled();
    await expect.poll(() => retryCount).toBe(1);
    release();
    await expect(
      page.getByRole("button", { name: "Retrying connection…" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Command or question")).toHaveValue(
      "synthetic unsent thought",
    );
    expect(inferenceCount).toBe(0);
    expect(retryCount).toBe(1);
  } finally {
    release();
  }
});
