// Explicit macOS acceptance fixture; invoked only against a newly created test volume.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolveDesktopPaths } from "../../src/server/desktop/paths.js";
import {
  createDesktopPreferences,
  selectWorkspaceRoot,
  isDedicatedWorkspace,
} from "../../src/server/desktop/preferences.js";
import { moveWorkspace } from "../../src/server/desktop/workspace-move.js";
const destinationParent = process.argv[2];
assert(
  destinationParent?.startsWith("/private/tmp/caddy-cross-volume.") &&
    destinationParent.endsWith("/volume"),
);
assert.equal(
  readFileSync(path.join(destinationParent, "FIXTURE-ONLY"), "utf8"),
  "caddy-disposable-volume",
);
const base = mkdtempSync(path.join(tmpdir(), "caddy-volume-source-"));
try {
  const paths = resolveDesktopPaths({
    applicationSupportDirectory: path.join(base, "support"),
    logsDirectory: path.join(base, "logs"),
  });
  createDesktopPreferences(paths);
  const parent = path.join(base, "source");
  mkdirSync(parent);
  const source = selectWorkspaceRoot(paths, parent).workspaceRoot!;
  assert.notEqual(statSync(source).dev, statSync(destinationParent).dev);
  writeFileSync(
    path.join(source, "arbitrary.bin"),
    Buffer.from([0, 1, 255, 40]),
  );
  writeFileSync(
    path.join(source, "arbitrary.bin/..namedfork/rsrc"),
    "synthetic resource fork",
  );
  mkdirSync(path.join(source, ".hidden"));
  writeFileSync(path.join(source, ".hidden/content"), "opaque unknown content");
  const destination = moveWorkspace(paths, destinationParent);
  assert.equal(existsSync(source), false);
  assert(isDedicatedWorkspace(destination));
  assert.deepEqual(
    readFileSync(path.join(destination, "arbitrary.bin")),
    Buffer.from([0, 1, 255, 40]),
  );
  assert.equal(
    readFileSync(
      path.join(destination, "arbitrary.bin/..namedfork/rsrc"),
      "utf8",
    ),
    "synthetic resource fork",
  );
  assert.equal(
    readFileSync(path.join(destination, ".hidden/content"), "utf8"),
    "opaque unknown content",
  );
  process.stdout.write(
    JSON.stringify(
      {
        result: "passed",
        sourceDevice: statSync(base).dev,
        destinationDevice: statSync(destination).dev,
        verified: [
          "different devices",
          "binary content",
          "resource fork",
          "dotfiles",
          "source retired",
          "dedicated ownership",
        ],
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}
