import assert from "node:assert/strict";
import { createHash } from "node:crypto";

type Icons = Record<string, { x: number; y: number }>;
// Deliberately limited to the pinned ds-store writer used by appdmg: one leaf
// at 4100, with a 3840-byte record area. Reject other layouts instead of finding
// byte patterns that might not be live Finder records. This is metadata proof,
// never a substitute for inspecting the mounted disk in Finder.
export function readAppDmgStore(bytes: Buffer): {
  icons: Icons;
  plists: Record<string, Buffer>;
} {
  // ds-store 0.1.6 copies its 15364-byte template, changing only the DSDB
  // record count [76,80) and leaf [4100,7940). Bind EVERY other byte before
  // trusting offset 4100: allocator header at 0, allocator/table at 8196,
  // block addresses [0x200b,0x45,0x100c], DSDB -> block 1 at 68, whose root
  // is block 2, height 0, node count 1, page size 4096, plus free lists/padding.
  // This deliberately rejects any writer/layout change, not just known attacks.
  // The real writer fixture and generation provenance live under fixtures/installer.
  assert.equal(
    bytes.length,
    15364,
    "Unsupported or truncated DS_Store allocation",
  );
  const structure = Buffer.from(bytes);
  structure.fill(0, 76, 80);
  structure.fill(0, 4100, 7940);
  assert.equal(
    createHash("sha256").update(structure).digest("hex"),
    "7296a1abb4d34ebfd2fe6eeb5d202f8c2d230f053cc2b041f0dca57a5e110037",
    "DS_Store allocator, DSDB root/table or tree metadata differs from pinned writer",
  );
  assert.equal(bytes.readUInt32BE(0), 1);
  assert.equal(bytes.toString("ascii", 4, 8), "Bud1");
  assert.equal(bytes.readUInt32BE(4100), 0, "Unsupported DS_Store branch");
  const count = bytes.readUInt32BE(4104);
  assert(count > 0 && count <= 32, "Unexpected DS_Store record count");
  assert.equal(count, bytes.readUInt32BE(76), "DS_Store count mismatch");
  let offset = 4108;
  function take(length: number): Buffer {
    assert(length >= 0 && offset + length <= 7940, "Truncated DS_Store record");
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  }
  const icons: Icons = {};
  const plists: Record<string, Buffer> = {};
  const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    const name = Buffer.from(take(take(4).readUInt32BE(0) * 2))
      .swap16()
      .toString("utf16le");
    const code = take(4).toString("ascii");
    assert(!seen.has(`${name}/${code}`), "Duplicate DS_Store record");
    seen.add(`${name}/${code}`);
    const type = take(4).toString("ascii");
    if (type === "long" && code === "vSrn") {
      take(4);
      continue;
    }
    assert.equal(type, "blob", "Unsupported DS_Store value");
    const value = take(take(4).readUInt32BE(0));
    if (code === "Iloc") {
      assert.equal(value.length, 16);
      icons[name] = { x: value.readUInt32BE(0), y: value.readUInt32BE(4) };
    } else {
      assert(
        name === "." && ["bwsp", "icvp"].includes(code),
        "Unexpected Finder record",
      );
      assert.equal(value.toString("ascii", 0, 8), "bplist00");
      plists[code] = value;
    }
  }
  assert(
    bytes.subarray(offset, 7940).every((byte) => byte === 0),
    "DS_Store contains undeclared records after its declared count",
  );
  return { icons, plists };
}

export function assertFinderLayout(
  icons: Icons,
  window: Record<string, unknown>,
  view: Record<string, unknown>,
): void {
  assert.deepEqual(
    icons,
    {
      "Convo Caddy.app": { x: 150, y: 150 },
      Applications: { x: 410, y: 150 },
      "Uninstall Convo Caddy.app": { x: 150, y: 300 },
      ".background": { x: 640, y: 460 },
      ".VolumeIcon.icns": { x: 640, y: 460 },
      ".DS_Store": { x: 640, y: 460 },
    },
    "Finder icon positions differ from the installer contract",
  );
  // ds-store adds the native 22-point title bar to the 400-point content area.
  assert.equal(window.WindowBounds, "{{180, 140}, {560, 422}}");
  assert.equal(window.ShowToolbar, false);
  assert.equal(window.ShowStatusBar, false);
  assert.equal(view.iconSize, 72);
  assert.equal(view.textSize, 12);
  assert.equal(view.labelOnBottom, true);
  assert.equal(view.arrangeBy, "none");
  assert.equal(view.backgroundType, 2);
  assert(view.backgroundImageAlias, "Missing Finder background alias");
}
