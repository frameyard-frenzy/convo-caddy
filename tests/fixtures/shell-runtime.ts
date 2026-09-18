import {
  type SpawnSyncOptionsWithStringEncoding,
  spawnSync,
} from "node:child_process";

export function shellRequired(shell: string, platform: string): boolean {
  return shell === "/bin/bash" || platform === "darwin";
}

export function shellAvailable(shell: string, required: boolean): boolean {
  const result = spawnSync(shell, ["-c", "true"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 5000,
  });
  if (
    !required &&
    result.error &&
    "code" in result.error &&
    result.error.code === "ENOENT"
  )
    return false;
  if (result.error)
    throw new Error(`Shell prerequisite ${shell}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `Shell prerequisite ${shell}: status=${result.status}, signal=${result.signal}, stderr=${result.stderr}`,
    );
  return true;
}

export function runShell(
  shell: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) {
  const result = spawnSync(shell, args, options);
  if (result.error)
    throw new Error(`Shell execution ${shell}: ${result.error.message}`);
  if (result.status === null)
    throw new Error(
      `Shell execution ${shell}: no exit status, signal=${result.signal}, stderr=${result.stderr}`,
    );
  return result;
}
