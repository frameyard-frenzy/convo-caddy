import { lstatSync } from "node:fs";

export function assertOwnerPrivateDirectory(directory: string): void {
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink()) {
    throw new Error("Private data directories must not be symbolic links.");
  }
  if (!metadata.isDirectory()) {
    throw new Error("Private data path must be a directory.");
  }
  assertOwner(metadata.uid);
  assertPrivateMode(metadata.mode, 0o700, "Private data directory");
}

export function assertOwnerPrivateRegularFile(file: string): void {
  const metadata = lstatSync(file);
  if (metadata.isSymbolicLink()) {
    throw new Error("Private data files must not be symbolic links.");
  }
  if (!metadata.isFile()) {
    throw new Error("Private data path must be a regular file.");
  }
  assertOwner(metadata.uid);
  assertPrivateMode(metadata.mode, 0o600, "Private data file");
}

function assertOwner(uid: number): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && uid !== currentUid) {
    throw new Error("Private data must be owned by the current user.");
  }
}

function assertPrivateMode(
  mode: number,
  expected: 0o600 | 0o700,
  label: string,
): void {
  if ((mode & 0o777) !== expected) {
    throw new Error(`${label} must be owner-private.`);
  }
}
