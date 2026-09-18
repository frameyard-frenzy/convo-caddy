import {
  constants,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const MAINTENANCE_CONTROL_DIRECTORY = path.join(
  homedir(),
  "Library",
  "Application Support",
  "Convo Caddy Control",
);
export const MAINTENANCE_LOCK_FILE = path.join(
  MAINTENANCE_CONTROL_DIRECTORY,
  "lifecycle.lock",
);

type NativeLock = { acquire(file: string): boolean; release(): void };
export type MaintenanceLockHandle = { readonly file: string; release(): void };

export function acquireMaintenanceLock(
  options: { file?: string; loadNative?: () => NativeLock } = {},
): MaintenanceLockHandle {
  const file = path.resolve(options.file ?? MAINTENANCE_LOCK_FILE);
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = lstatSync(directory);
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    directoryMetadata.uid !== process.getuid?.() ||
    (directoryMetadata.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Maintenance control directory failed ownership validation.",
    );
  }
  const native = (options.loadNative ?? loadPackagedNativeLock)();
  if (native.acquire(file) !== true) {
    throw new Error("The native lifecycle lock did not confirm acquisition.");
  }
  try {
    validateOwnerPrivateMarker(file);
  } catch (error) {
    native.release();
    throw error;
  }
  let released = false;
  return {
    file,
    release() {
      if (released) return;
      native.release();
      released = true;
    },
  };
}

function loadPackagedNativeLock(): NativeLock {
  const require = createRequire(import.meta.url);
  const modulePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "lifecycle-lock.node",
  );
  return require(modulePath) as NativeLock;
}

export function validateOwnerPrivateMarker(file: string): void {
  const descriptor = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("Maintenance marker inode is unsafe.");
    }
    if (metadata.uid !== process.getuid?.()) {
      throw new Error("Maintenance marker owner is unsafe.");
    }
  } finally {
    closeSync(descriptor);
  }
}
