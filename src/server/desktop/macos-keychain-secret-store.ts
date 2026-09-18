import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  SECRET_ROLES,
  SecretStoreError,
  type SecretRole,
  type SecretStore,
  type SecretStoreErrorCode,
} from "./secret-store.js";

export const KEYCHAIN_SERVICE = "com.frameyard.convocaddy";
const SECURITY_EXECUTABLE = "/usr/bin/security";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32_768;
const MAX_SECRET_BYTES = 16_384;
const generationPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SecurityCommandRequest = {
  executable: "/usr/bin/security";
  args: string[];
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type SecurityCommandResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  outputExceeded: boolean;
};

export type SecurityCommandRunner = (
  request: SecurityCommandRequest,
) => Promise<SecurityCommandResult>;

export type SecurityProcessFactory = (
  executable: string,
  args: readonly string[],
  options: { shell: false; detached: true; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export class MacosKeychainSecretStore implements SecretStore {
  readonly #runner: SecurityCommandRunner;

  constructor(options: { runner?: SecurityCommandRunner } = {}) {
    this.#runner = options.runner ?? runSecurityCommand;
  }

  async write(
    role: SecretRole,
    generation: string,
    secret: string,
  ): Promise<void> {
    const account = accountName(role, generation);
    validateSecret(secret);
    const result = await this.#run({
      args: [
        "add-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
        "-U",
        "-w",
      ],
      // security prompts for the value and its confirmation when -w is last.
      stdin: `${secret}\n${secret}\n`,
    });
    assertSuccessful(result, "write");
  }

  async read(role: SecretRole, generation: string): Promise<string> {
    const account = accountName(role, generation);
    const result = await this.#run({
      args: [
        "find-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ],
    });
    assertSuccessful(result, "read");
    const secret = removeOneTrailingLineEnding(result.stdout).toString("utf8");
    validateStoredSecret(secret);
    return secret;
  }

  async delete(
    role: SecretRole,
    generation: string,
  ): Promise<"deleted" | "missing"> {
    const account = accountName(role, generation);
    const result = await this.#run({
      args: ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE],
    });
    if (result.exitCode === 44 && !result.timedOut && !result.outputExceeded) {
      return "missing";
    }
    assertSuccessful(result, "delete");
    return "deleted";
  }

  async #run(input: {
    args: string[];
    stdin?: string;
  }): Promise<SecurityCommandResult> {
    try {
      return await this.#runner({
        executable: SECURITY_EXECUTABLE,
        args: input.args,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });
    } catch {
      throw new SecretStoreError(
        "unavailable",
        "The macOS Keychain command could not run.",
      );
    }
  }
}

export async function runSecurityCommand(
  request: SecurityCommandRequest,
  spawnProcess: SecurityProcessFactory = spawn,
): Promise<SecurityCommandResult> {
  if (request.executable !== SECURITY_EXECUTABLE) {
    throw new Error("Unexpected Keychain executable.");
  }
  return new Promise((resolve) => {
    const child = spawnProcess(request.executable, request.args, {
      shell: false,
      // Prevent getpass from opening an inherited controlling terminal.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let stdinFailed = false;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        outputExceeded,
      });
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (settled || outputExceeded) {
        return;
      }
      outputBytes += chunk.byteLength;
      if (outputBytes > request.maxOutputBytes) {
        outputExceeded = true;
        child.kill();
        finish(null);
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => {
      stdinFailed = true;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) =>
      finish(stdinFailed && code === 0 ? null : code),
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null);
    }, request.timeoutMs);

    if (request.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(request.stdin, "utf8");
    }
  });
}

function accountName(role: SecretRole, generation: string): string {
  if (!SECRET_ROLES.includes(role)) {
    throw new SecretStoreError(
      "invalid_request",
      "The requested Keychain secret role is not allowed.",
    );
  }
  if (!generationPattern.test(generation)) {
    throw new SecretStoreError(
      "invalid_request",
      "The Keychain generation identifier is invalid.",
    );
  }
  return `${role}@${generation}`;
}

function validateSecret(secret: string): void {
  if (
    secret.length === 0 ||
    Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES ||
    secret.includes("\u0000") ||
    secret.includes("\r") ||
    secret.includes("\n")
  ) {
    throw new SecretStoreError(
      "invalid_request",
      "The Keychain secret value is invalid.",
    );
  }
}

function validateStoredSecret(secret: string): void {
  try {
    validateSecret(secret);
  } catch {
    throw new SecretStoreError(
      "malformed",
      "The stored Keychain item is malformed.",
    );
  }
}

function removeOneTrailingLineEnding(value: Buffer): Buffer {
  if (value.subarray(-2).equals(Buffer.from("\r\n"))) {
    return value.subarray(0, -2);
  }
  if (value.subarray(-1).equals(Buffer.from("\n"))) {
    return value.subarray(0, -1);
  }
  return value;
}

function assertSuccessful(
  result: SecurityCommandResult,
  operation: "read" | "write" | "delete",
): void {
  const code = mapFailureCode(result, operation);
  if (code !== null) {
    throw new SecretStoreError(code, safeFailureMessage(code));
  }
}

function mapFailureCode(
  result: SecurityCommandResult,
  operation: "read" | "write" | "delete",
): SecretStoreErrorCode | null {
  if (result.timedOut || result.outputExceeded || result.exitCode === null) {
    return "unavailable";
  }
  if (result.exitCode === 0) {
    return null;
  }
  if (result.exitCode === 44 && operation === "read") {
    return "missing";
  }
  if (result.exitCode === 51 || result.exitCode === 128) {
    return "access_denied";
  }
  if (result.exitCode === 36) {
    return "unavailable";
  }
  if (operation === "write") {
    return "write_failed";
  }
  if (operation === "delete") {
    return "delete_failed";
  }
  return "unavailable";
}

function safeFailureMessage(code: SecretStoreErrorCode): string {
  return {
    invalid_request: "The Keychain request is invalid.",
    missing: "The requested Keychain item is missing.",
    access_denied: "Access to the macOS Keychain was denied.",
    unavailable: "The macOS Keychain is unavailable.",
    malformed: "The stored Keychain item is malformed.",
    write_failed: "The macOS Keychain item could not be saved.",
    delete_failed: "The macOS Keychain item could not be removed.",
  }[code];
}
