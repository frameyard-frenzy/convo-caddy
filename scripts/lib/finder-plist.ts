import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Finder's background alias is NSData, unsupported by plutil's JSON conversion.
// Raw extraction preserves data as base64 and does not resolve or execute it.
export function readFinderValue(bytes: Buffer, key: string): string {
  return execFileSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", "-"],
    { input: bytes, encoding: "utf8" },
  ).trim();
}

// Only the v2 file-alias shape emitted by pinned macos-alias 0.2.12 for our
// mounted HFS+ DMG. Do not resolve the build Mac's original mount path or accept
// arbitrary Alias Manager variants. The volume-relative target and mounted
// catalog IDs must agree; a matching basename elsewhere is never sufficient.
export function assertBackgroundAlias(
  bytes: Buffer,
  expected: { parentId: number; targetId: number },
): void {
  assert(
    bytes.length >= 154 && bytes.length <= 4096,
    "Invalid background alias size",
  );
  assert.equal(bytes.readUInt32BE(0), 0, "Unexpected alias application data");
  assert.equal(
    bytes.readUInt16BE(4),
    bytes.length,
    "Truncated or trailing alias data",
  );
  assert.equal(bytes.readUInt16BE(6), 2, "Unsupported alias version");
  assert.equal(bytes.readUInt16BE(8), 0, "Background alias must name a file");
  const pascal = (offset: number, maximum: number): string => {
    const length = bytes.readUInt8(offset);
    assert(length > 0 && length <= maximum, "Invalid alias Pascal string");
    const value = bytes.subarray(offset + 1, offset + 1 + length);
    const text = value.toString("utf8");
    assert(
      Buffer.from(text, "utf8").equals(value) && !text.includes("\0"),
      "Invalid alias text",
    );
    assert(
      bytes
        .subarray(offset + 1 + length, offset + 1 + maximum)
        .every((byte) => byte === 0),
      "Invalid alias string padding",
    );
    return text;
  };
  const volumeName = pascal(10, 27);
  assert.equal(volumeName, "Convo Caddy", "Wrong alias volume name");
  assert.equal(pascal(50, 63), "dmg-background.tiff", "Wrong alias filename");
  assert.equal(
    bytes.toString("ascii", 42, 44),
    "H+",
    "Unsupported alias filesystem",
  );
  assert.equal(bytes.readUInt16BE(44), 5, "Alias must name a mounted volume");
  for (const [offset, id] of [
    [46, expected.parentId],
    [114, expected.targetId],
  ] as const) {
    assert(Number.isSafeInteger(id) && id > 0, "Invalid mounted catalog ID");
    assert.equal(
      bytes.readUInt32BE(offset),
      id,
      "Alias catalog ID differs from mounted target",
    );
  }
  assert(
    bytes.subarray(122, 130).every((byte) => byte === 0),
    "Unexpected alias file type/creator",
  );
  assert.equal(
    bytes.readUInt32BE(130),
    0xffffffff,
    "Unexpected alias relative levels",
  );
  assert.equal(
    bytes.readUInt32BE(134),
    0x0d02,
    "Unexpected alias volume attributes",
  );
  assert(
    bytes.subarray(138, 150).every((byte) => byte === 0),
    "Unexpected alias reserved data",
  );
  let offset = 150;
  const tags = new Map<number, Buffer>();
  for (const type of [0, 1, 14, 15, 18, 19]) {
    assert(offset + 4 <= bytes.length, "Truncated alias tag header");
    assert.equal(
      bytes.readInt16BE(offset),
      type,
      "Missing, duplicated or unsupported alias tag",
    );
    const length = bytes.readUInt16BE(offset + 2);
    offset += 4;
    assert(
      offset + length + (length % 2) <= bytes.length,
      "Truncated alias tag data",
    );
    tags.set(type, bytes.subarray(offset, offset + length));
    offset += length;
    if (length % 2)
      assert.equal(bytes[offset++], 0, "Invalid alias tag padding");
  }
  assert.equal(
    offset + 4,
    bytes.length,
    "Trailing or missing alias terminator",
  );
  assert.equal(bytes.readInt16BE(offset), -1, "Missing alias terminator");
  assert.equal(
    bytes.readUInt16BE(offset + 2),
    0,
    "Invalid alias terminator length",
  );
  const tag = (type: number): Buffer => {
    const value = tags.get(type);
    assert(value, "Missing required alias tag");
    return value;
  };
  const equalText = (type: number, value: string) =>
    assert(
      tag(type).equals(Buffer.from(value, "utf8")),
      "Wrong alias target path",
    );
  equalText(0, ".background");
  assert.equal(tag(1).length, 4, "Invalid alias parent ID tag");
  assert.equal(
    tag(1).readUInt32BE(0),
    expected.parentId,
    "Conflicting alias parent ID",
  );
  for (const [type, text] of [
    [14, "dmg-background.tiff"],
    [15, volumeName],
  ] as const) {
    const value = tag(type);
    assert.equal(
      value.length,
      2 + text.length * 2,
      "Invalid alias Unicode name length",
    );
    assert.equal(
      value.readUInt16BE(0),
      text.length,
      "Invalid alias Unicode character count",
    );
    assert(
      value.subarray(2).equals(Buffer.from(text, "utf16le").swap16()),
      "Conflicting alias Unicode name",
    );
  }
  equalText(18, "/.background/dmg-background.tiff");
  const mount = tag(19).toString("utf8");
  assert(
    Buffer.from(mount, "utf8").equals(tag(19)) &&
      !mount.includes("\0") &&
      mount.startsWith("/") &&
      mount !== "/" &&
      path.posix.normalize(mount) === mount,
    "Invalid alias volume mount path",
  );
}
