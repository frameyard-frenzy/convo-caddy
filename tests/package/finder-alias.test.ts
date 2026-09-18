import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import * as store from "../../scripts/lib/dmg-store.js";
import * as plist from "../../scripts/lib/finder-plist.js";

const fixture = () => readFileSync("tests/fixtures/installer/background.alias");
// Exercise the actual private package-verifier function, with synthetic native
// filesystem/plutil ports. Its preceding layout check reads the real writer's
// DSStore fixture. No copy of the production alias predicate lives in this test.
function verify(alias: Buffer, ids = { parentId: 16, targetId: 17 }) {
  const source = readFileSync("scripts/verify-package-mac.ts", "utf8");
  const body = source.slice(
    source.indexOf("function verifyFinderArtwork("),
    source.indexOf("function packagedVersion("),
  );
  const values: Record<string, unknown> = {
    iconSize: 72,
    textSize: 12,
    labelOnBottom: true,
    arrangeBy: "none",
    backgroundType: 2,
    backgroundImageAlias: alias.toString("base64"),
    WindowBounds: "{{180, 140}, {560, 422}}",
    ShowToolbar: false,
    ShowStatusBar: false,
  };
  const check = runInNewContext(
    `${transformSync(body, { loader: "ts" }).code}; verifyFinderArtwork`,
    {
      ...store,
      ...plist,
      path,
      Buffer,
      assertSameFile: () => {},
      readFileSync: () =>
        readFileSync("tests/fixtures/installer/finder-store.bin"),
      readlinkSync: () => "/Applications",
      readFinderValue: (_bytes: Buffer, key: string) => String(values[key]),
      statSync: (file: string) => ({
        ino: file.endsWith(".background") ? ids.parentId : ids.targetId,
      }),
    },
  );
  check("/synthetic-mounted-dmg");
}

describe("exact mounted Finder background alias", () => {
  it("accepts the pinned encoder's complete v2 fixture", () => {
    expect(() => verify(fixture())).not.toThrow();
  });
  it("rejects a different volume even with the expected relative path and IDs", () => {
    const bytes = fixture();
    Buffer.from("Other Caddy").copy(bytes, 11);
    const original = Buffer.from("Convo Caddy", "utf16le").swap16();
    const index = bytes.indexOf(original);
    expect(index).toBeGreaterThan(150);
    Buffer.from("Other Caddy", "utf16le").swap16().copy(bytes, index);
    expect(() => verify(bytes)).toThrow();
  });
  it("rejects arbitrary bytes containing the expected basename", () => {
    expect(() =>
      verify(Buffer.from("arbitrary dmg-background.tiff bytes")),
    ).toThrow();
  });
  it("rejects a valid alias to another directory with the same basename", () => {
    expect(() =>
      verify(readFileSync("tests/fixtures/installer/wrong-directory.alias")),
    ).toThrow();
  });
  it("rejects an otherwise valid alias with the expected name only in its mount path", () => {
    expect(() =>
      verify(readFileSync("tests/fixtures/installer/embedded-name.alias")),
    ).toThrow();
  });
  it("rejects a truncated tag stream even if its header length is repaired", () => {
    const bytes = fixture().subarray(0, 200);
    bytes.writeUInt16BE(bytes.length, 4);
    expect(() => verify(bytes)).toThrow();
  });
  it.each([149, 150, 160, 200, 300])(
    "rejects a real alias truncated at %i",
    (length) => {
      expect(() => verify(fixture().subarray(0, length))).toThrow();
    },
  );
  it.each([
    ["length", 4, 150],
    ["version", 6, 3],
    ["directory kind", 8, 1],
    ["first tag length", 152, 65535],
  ] as const)(
    "rejects malformed %s without substring fallback",
    (_label, offset, value) => {
      const bytes = fixture();
      bytes.writeUInt16BE(value, offset);
      expect(() => verify(bytes)).toThrow();
    },
  );
  it("rejects missing terminator", () => {
    const bytes = fixture().subarray(0, fixture().length - 4);
    bytes.writeUInt16BE(bytes.length, 4);
    expect(() => verify(bytes)).toThrow();
  });
  it("rejects trailing embedded-name bytes", () => {
    const trailing = Buffer.concat([
      fixture(),
      Buffer.from("dmg-background.tiff"),
    ]);
    trailing.writeUInt16BE(trailing.length, 4);
    expect(() => verify(trailing)).toThrow();
  });
  it("rejects alias catalog IDs that name different mounted objects", () => {
    expect(() => verify(fixture(), { parentId: 99, targetId: 17 })).toThrow();
    expect(() => verify(fixture(), { parentId: 16, targetId: 99 })).toThrow();
  });
});
