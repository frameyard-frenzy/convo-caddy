import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type AtomicWriteOptions = {
  beforeRename?: () => void;
};

export function ensurePrivateDirectory(directory: string): void {
  assertManagedPathHasNoSymlinks(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertManagedPathHasNoSymlinks(directory);
  chmodSync(directory, 0o700);
}

export function assertManagedPathHasNoSymlinks(
  target: string,
  boundary: string = target,
): void {
  const absolute = path.resolve(target);
  const absoluteBoundary = path.resolve(boundary);
  const relative = path.relative(absoluteBoundary, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed data path is outside its configured boundary.");
  }
  const components = relative === "" ? [] : relative.split(path.sep);
  let current = absoluteBoundary;

  for (let index = 0; index <= components.length; index += 1) {
    if (index > 0) {
      current = path.join(current, components[index - 1] ?? "");
    }
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `Managed data directories must not be symbolic links: ${current}`,
        );
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
  }
}

export function atomicWriteText(
  destination: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  const directory = path.dirname(destination);
  ensurePrivateDirectory(directory);

  const temporaryFile = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryFile, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    options.beforeRename?.();
    renameSync(temporaryFile, destination);
    chmodSync(destination, 0o600);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }

    try {
      unlinkSync(temporaryFile);
    } catch (cleanupError) {
      if (!isMissingFileError(cleanupError)) {
        throw new AggregateError(
          [error, cleanupError],
          "Atomic write failed and its temporary file could not be removed.",
        );
      }
    }

    throw error;
  }
}

export function syncDirectory(directory: string): void {
  let descriptor: number | undefined;

  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
