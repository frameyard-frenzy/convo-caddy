import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  KEYCHAIN_SERVICE,
  MacosKeychainSecretStore,
  runSecurityCommand,
  type SecurityCommandRequest,
  type SecurityCommandResult,
} from "../../src/server/desktop/macos-keychain-secret-store.js";
import {
  SECRET_ROLES,
  SecretStoreError,
  type SecretRole,
} from "../../src/server/desktop/secret-store.js";

const generation = "00000000-0000-4000-8000-000000000001";

// Hoisted before production imports: no test may fall through to real Keychain.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    throw new Error("Inject a synthetic subprocess in Keychain tests");
  }),
}));

describe("macOS Keychain secret store", () => {
  it("uses the frozen service and generation account while keeping secret bytes out of argv", async () => {
    const secret = "must-stay-off-process-arguments";
    const runner = vi.fn(async (_request: SecurityCommandRequest) => success());
    const store = new MacosKeychainSecretStore({ runner });

    await store.write("recall-api-key", generation, secret);

    expect(KEYCHAIN_SERVICE).toBe("com.frameyard.convocaddy");
    expect(runner).toHaveBeenCalledOnce();
    const request = runner.mock.calls[0]?.[0];
    expect(request).toEqual({
      executable: "/usr/bin/security",
      args: [
        "add-generic-password",
        "-a",
        `recall-api-key@${generation}`,
        "-s",
        KEYCHAIN_SERVICE,
        "-U",
        "-w",
      ],
      stdin: `${secret}\n${secret}\n`,
      timeoutMs: 5_000,
      maxOutputBytes: 32_768,
    });
    expect(request?.args.join(" ")).not.toContain(secret);
  });

  it("supplies both password prompts required by Apple's no-argument -w protocol", async () => {
    const store = new MacosKeychainSecretStore({
      runner: async (request) => {
        const lines = request.stdin?.split("\n") ?? [];
        // Apple SecurityTool promptForPasswordData reads and compares two getpass responses.
        return lines[0] && lines[0] === lines[1]
          ? success()
          : failed(1, "passwords don't match");
      },
    });
    await expect(
      store.write("hermes-api-key", generation, "synthetic-prompt-password"),
    ).resolves.toBeUndefined();
  });

  it("reads each exact role without exposing the other accounts", async () => {
    const runner = vi.fn(async (_request: SecurityCommandRequest) =>
      success("keychain-value\n"),
    );
    const store = new MacosKeychainSecretStore({ runner });

    for (const role of SECRET_ROLES) {
      await expect(store.read(role, generation)).resolves.toBe(
        "keychain-value",
      );
      const request = runner.mock.calls.at(-1)?.[0];
      expect(request?.args).toEqual([
        "find-generic-password",
        "-a",
        `${role}@${generation}`,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      expect(request?.stdin).toBeUndefined();
    }
  });

  it("distinguishes missing, access denial, unavailability, malformed bytes, and write failure", async () => {
    const cases: Array<{
      result: SecurityCommandResult;
      operation: "read" | "write";
      code: SecretStoreError["code"];
    }> = [
      { result: failed(44), operation: "read", code: "missing" },
      { result: failed(51), operation: "read", code: "access_denied" },
      { result: failed(128), operation: "read", code: "access_denied" },
      { result: failed(36), operation: "read", code: "unavailable" },
      {
        result: { ...failed(null), timedOut: true },
        operation: "read",
        code: "unavailable",
      },
      {
        result: { ...failed(null), outputExceeded: true },
        operation: "read",
        code: "unavailable",
      },
      {
        result: success("\u0000invalid\n"),
        operation: "read",
        code: "malformed",
      },
      { result: failed(1), operation: "write", code: "write_failed" },
    ];

    for (const testCase of cases) {
      const secret = "must-not-appear-in-error";
      const store = new MacosKeychainSecretStore({
        runner: async () => testCase.result,
      });
      let caught: unknown;
      try {
        if (testCase.operation === "read") {
          await store.read("hermes-api-key", generation);
        } else {
          await store.write("hermes-api-key", generation, secret);
        }
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretStoreError);
      expect((caught as SecretStoreError).code).toBe(testCase.code);
      expect((caught as Error).message).not.toContain(secret);
      expect((caught as Error).message).not.toContain("security:");
    }
  });

  it("treats deleting a missing exact item as idempotent and maps other failures safely", async () => {
    const missingStore = new MacosKeychainSecretStore({
      runner: async () => failed(44),
    });
    await expect(
      missingStore.delete("ngrok-authtoken", generation),
    ).resolves.toBe("missing");

    const deniedStore = new MacosKeychainSecretStore({
      runner: async () => failed(51, "sensitive diagnostic"),
    });
    await expect(
      deniedStore.delete("ngrok-authtoken", generation),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("rejects unallowlisted roles, noncanonical generations, and unsafe secret bytes before execution", async () => {
    const runner = vi.fn(async (_request: SecurityCommandRequest) => success());
    const store = new MacosKeychainSecretStore({ runner });

    await expect(
      store.read("other-secret" as SecretRole, generation),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.read("recall-api-key", "../generation"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.write("recall-api-key", generation, "line-one\nline-two"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.write("recall-api-key", generation, "x".repeat(16_385)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("waits for the process exit code when stdin closes early", async () => {
    const child = fakeSecurityProcess();
    const result = runSecurityCommand(
      {
        executable: "/usr/bin/security",
        args: ["add-generic-password", "-w"],
        stdin: "secret\n",
        timeoutMs: 5_000,
        maxOutputBytes: 32_768,
      },
      () => child,
    );

    child.stdin.emit(
      "error",
      Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
    );
    child.emit("close", 51);

    await expect(result).resolves.toMatchObject({
      exitCode: 51,
      timedOut: false,
      outputExceeded: false,
    });
  });
});

function fakeSecurityProcess(): ChildProcessWithoutNullStreams {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn(() => true);
  return process;
}

function success(stdout = ""): SecurityCommandResult {
  return {
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    timedOut: false,
    outputExceeded: false,
  };
}

function failed(
  exitCode: number | null,
  stderr = "ignored raw diagnostic",
): SecurityCommandResult {
  return {
    exitCode,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(stderr),
    timedOut: false,
    outputExceeded: false,
  };
}
