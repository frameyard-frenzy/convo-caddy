import { describe, expect, it } from "vitest";
import { RuntimeReadinessStore } from "../../src/server/connectivity/readiness.js";

describe("runtime readiness", () => {
  it("derives Ready without Marty when capture is safe and Hermes is unavailable", () => {
    const readiness = new RuntimeReadinessStore({
      configuration: "ready",
      workspace: "ready",
      appServer: "ready",
      webhookServer: "ready",
      ngrok: "starting",
      hermesTunnel: "starting",
      hermes: "unavailable",
      capture: "disabled",
    });

    readiness.update({
      ngrok: "ready",
      hermesTunnel: "unavailable",
      hermes: "unavailable",
      capture: "ready",
    });
    readiness.report("hermes", "hermes_unavailable");

    expect(readiness.snapshot()).toMatchObject({
      state: "ready_without_marty",
      components: {
        ngrok: "ready",
        hermesTunnel: "unavailable",
        hermes: "unavailable",
        capture: "ready",
      },
      diagnostics: [
        {
          component: "hermes",
          code: "hermes_unavailable",
          severity: "warning",
        },
      ],
    });
  });

  it("fails capture readiness when the approved ngrok endpoint is unavailable", () => {
    const readiness = readyComponents();

    readiness.update({ ngrok: "failed", capture: "disabled" });
    readiness.report("ngrok", "ngrok_start_failed");

    expect(readiness.snapshot()).toMatchObject({
      state: "needs_attention",
      components: { ngrok: "failed", capture: "disabled" },
    });
  });

  it("reports an established SSH forward exit without calling it a startup failure", () => {
    const readiness = readyComponents();

    readiness.update({
      hermesTunnel: "unavailable",
      hermes: "unavailable",
    });
    readiness.report("hermesTunnel", "ssh_owned_forward_exited");

    expect(readiness.snapshot()).toMatchObject({
      state: "ready_without_marty",
      diagnostics: [
        {
          component: "hermesTunnel",
          code: "ssh_owned_forward_exited",
          message: "The established Hermes SSH forward exited.",
        },
      ],
    });
  });

  it("never admits arbitrary diagnostic text that could contain a secret", () => {
    const readiness = readyComponents();

    expect(() =>
      readiness.report(
        "ngrok",
        "must-never-be-rendered" as "ngrok_start_failed",
      ),
    ).toThrow("Unknown runtime diagnostic code");
  });
});

function readyComponents(): RuntimeReadinessStore {
  return new RuntimeReadinessStore({
    configuration: "ready",
    workspace: "ready",
    appServer: "ready",
    webhookServer: "ready",
    ngrok: "ready",
    hermesTunnel: "reused",
    hermes: "ready",
    capture: "ready",
  });
}
