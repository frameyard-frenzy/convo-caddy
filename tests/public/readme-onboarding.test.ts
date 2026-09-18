import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(path.resolve("README.md"), "utf8");
const recovery = readFileSync("docs/install-uninstall-verification.md", "utf8");

describe("public README onboarding", () => {
  it("requires verified preservation outside every removal ancestor before manual deletion", () => {
    const manual = recovery.split("## Manual recovery fallback")[1] ?? "";
    const preservation = manual.indexOf(
      "Preserve nested workspaces before deletion",
    );
    const removal = manual.indexOf(
      "Finder to move only these exact Caddy items to Trash",
    );
    expect(preservation).toBeGreaterThan(0);
    expect(removal).toBeGreaterThan(preservation);
    const steps = manual.slice(preservation, removal);
    expect(steps).toContain(
      "~/Library/Application Support/Convo Caddy/workspace/",
    );
    expect(steps).toContain("outside every removal ancestor");
    expect(steps).toContain("hidden staging files");
    expect(steps).toContain(
      "relative paths, file counts, sizes, and file-content hashes",
    );
    expect(steps).toContain("Stop if preservation or verification fails");
    expect(steps).toContain("separate explicit permission");
  });

  it("covers a custom default keychain and all generations without equating denial with absence", () => {
    const credentials =
      recovery
        .split("### 2. Remove every saved Caddy credential")[1]
        ?.split("### 3.")[0] ?? "";
    const locate = credentials.indexOf("security default-keychain -d user");
    const inspect = credentials.indexOf("select that exact keychain");
    expect(locate).toBeGreaterThan(0);
    expect(inspect).toBeGreaterThan(locate);
    expect(credentials).toContain("without reading passwords");
    expect(credentials.replace(/\s+/g, " ")).toContain(
      "previous default keychains",
    );
    expect(credentials).toContain("every credential generation");
    for (const role of [
      "recall-api-key",
      "recall-webhook-verification-secret",
      "ngrok-authtoken",
      "hermes-api-key",
    ])
      expect(credentials).toContain(`${role}@`);
    expect(credentials).toContain(
      "Denied, locked, missing, or incomplete inspection is blocked/unverified",
    );
    expect(credentials).toContain(
      "A search of login alone cannot prove absence",
    );
    const completion =
      recovery.split("### 5. Verify removal before reinstalling")[1] ?? "";
    expect(completion).toContain("every identified Caddy-used keychain");
    expect(completion).toContain("blocked/unverified");
  });

  it("keeps dashboard destinations and lifecycle subscriptions actionable", () => {
    for (const text of [
      "https://us-west-2.recall.ai/auth/signup",
      "https://us-west-2.recall.ai/dashboard/developers/api-keys",
      "https://us-west-2.recall.ai/dashboard/webhooks/",
      "https://dashboard.ngrok.com/domains",
      "https://dashboard.ngrok.com/get-started/your-authtoken",
      "not a per-endpoint Svix secret",
      "/api/capture/recall/webhook",
      "bot.joining_call",
      "bot.in_waiting_room",
      "bot.in_call_not_recording",
      "bot.recording_permission_denied",
      "bot.in_call_recording",
      "bot.call_ended",
      "transcript.done",
      "recording.done",
      "bot.done",
      "bot.fatal",
      "Do **not** add `transcript.data`",
    ])
      expect(readme).toContain(text);
  });
  it("preserves optional practice consent and source-upgrade proof outside first install", () => {
    const practice = readFileSync("docs/practice-interview.md", "utf8");
    for (const value of [
      "Choose prep…",
      "prep/TEMPLATE.md",
      "prep/current",
      "Personal Microsoft Teams meeting link",
      "Start live capture",
      "Admission is recording authorization",
      "Quitting Convo Caddy does not remove a meeting bot",
      "possible provider cost/retention",
      "four-file record",
      "archived prep",
    ])
      expect(practice).toContain(value);
    for (const removed of [
      "New prep filename",
      "Create prep",
      "Use for next interview",
    ]) {
      expect(practice).not.toContain(removed);
      expect(readme).not.toContain(removed);
    }
    const source = readFileSync("docs/source-install-and-upgrade.md", "utf8");
    for (const value of [
      'open "/Applications/Convo Caddy.app"',
      "unsaved entries",
      "Options → Show in Finder",
    ])
      expect(source).toContain(value);
    expect(readme).toContain("**No** is the default");
    expect(readme).toContain("explicit removal permission");
    expect(readme).not.toMatch(/releases\/latest\/download/);
  });
  it("separates references from the recipe and keeps their targets valid", () => {
    expect(readme.indexOf("## For agents")).toBeGreaterThan(
      readme.indexOf("## For people"),
    );
    for (const target of [
      "docs/build-from-source.md",
      "docs/hermes-owner-handoff.md",
      "docs/hermes-connection-setup.md#this-mac",
      "docs/hermes-connection-setup.md#another-mac",
      "docs/behavior-and-privacy.md",
      "docs/install-uninstall-verification.md",
      "docs/releasing.md",
      "SECURITY.md",
      "NOTICE.md",
      "public/FONT-LICENSES.txt",
    ]) {
      expect(readme).toContain(`](${target})`);
      const [file = "", fragment] = target.split("#");
      expect(file).toBeTruthy();
      expect(existsSync(path.resolve(file))).toBe(true);
      if (fragment) {
        const headings = [
          ...readFileSync(file, "utf8").matchAll(/^## (.+)$/gm),
        ].map((match) => match[1]?.toLowerCase().replaceAll(" ", "-"));
        expect(headings).toContain(fragment);
      }
    }
    expect(readme).toContain(
      "Do not install, start, stop, restart, or replace Hermes",
    );
    expect(recovery).toContain("../README.md#install");
    const privacy = readFileSync("docs/behavior-and-privacy.md", "utf8");
    expect(privacy).toContain("no analytics, telemetry, cloud persistence");
    expect(privacy).toContain("makes no model call");
  });
});
