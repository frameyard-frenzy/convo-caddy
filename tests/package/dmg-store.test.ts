import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readAppDmgStore,
  assertFinderLayout,
} from "../../scripts/lib/dmg-store.js";

function store() {
  return readFileSync("tests/fixtures/installer/finder-store.bin");
}
const icons = {
  "Convo Caddy.app": { x: 150, y: 150 },
  Applications: { x: 410, y: 150 },
  "Uninstall Convo Caddy.app": { x: 150, y: 300 },
  ".background": { x: 640, y: 460 },
  ".VolumeIcon.icns": { x: 640, y: 460 },
  ".DS_Store": { x: 640, y: 460 },
};
const window = {
  WindowBounds: "{{180, 140}, {560, 422}}",
  ShowToolbar: false,
  ShowStatusBar: false,
};
const view = {
  iconSize: 72,
  textSize: 12,
  labelOnBottom: true,
  arrangeBy: "none",
  backgroundType: 2,
  backgroundImageAlias: "fixture",
};
describe("mounted appdmg Finder metadata", () => {
  it("reads actual length-delimited icon and plist records", () => {
    const parsed = readAppDmgStore(store());
    expect(parsed.icons).toEqual(icons);
    expect(parsed.plists.bwsp?.subarray(0, 8).toString()).toBe("bplist00");
  });
  it.each([
    ["allocator offset", 8, 12288],
    ["allocator length", 12, 512],
    ["duplicate allocator offset", 16, 12288],
    ["DSDB root redirected with stale expected leaf", 68, 0],
    ["tree height", 72, 1],
    ["tree node count", 80, 2],
    ["tree page size", 84, 8192],
    ["allocated block count", 8196, 4],
    ["leaf block address redirected", 8212, 0x280b],
    ["DSDB table entry redirected", 9237, 2],
  ] as const)("rejects changed live %s", (_label, offset, value) => {
    const bytes = store();
    bytes.writeUInt32BE(value, offset);
    expect(() => readAppDmgStore(bytes)).toThrow();
  });
  it("rejects a zero allocator", () => {
    const bytes = store();
    bytes.fill(0, 8196, 10244);
    expect(() => readAppDmgStore(bytes)).toThrow();
  });
  it("rejects a truncated real allocator", () => {
    expect(() => readAppDmgStore(store().subarray(0, 9000))).toThrow();
  });
  it("rejects understated matching counts leaving undeclared records", () => {
    const bytes = store();
    bytes.writeUInt32BE(8, 76);
    bytes.writeUInt32BE(8, 4104);
    expect(() => readAppDmgStore(bytes)).toThrow();
  });
  it("rejects truncation, unsupported nodes and count mismatch", () => {
    expect(() => readAppDmgStore(store().subarray(0, 4200))).toThrow();
    const branch = store();
    branch.writeUInt32BE(1, 4100);
    expect(() => readAppDmgStore(branch)).toThrow();
    const count = store();
    count.writeUInt32BE(3, 76);
    expect(() => readAppDmgStore(count)).toThrow();
  });
  it("rejects layout drift even when the background and apps exist", () => {
    expect(() => assertFinderLayout(icons, window, view)).not.toThrow();
    expect(() =>
      assertFinderLayout(
        { ...icons, Applications: { x: 330, y: 300 } },
        window,
        view,
      ),
    ).toThrow();
    expect(() =>
      assertFinderLayout(
        icons,
        { ...window, WindowBounds: "{{180, 140}, {900, 800}}" },
        view,
      ),
    ).toThrow();
    expect(() =>
      assertFinderLayout(icons, window, { ...view, backgroundType: 1 }),
    ).toThrow();
    expect(() =>
      assertFinderLayout(icons, window, { ...view, iconSize: 128 }),
    ).toThrow();
  });
});
