// Maintainer-only deterministic fixtures; uses the pinned writers, no native ports.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const requireProject = createRequire(path.resolve("package.json"));
const maker = createRequire(
  requireProject.resolve("@electron-forge/maker-dmg"),
);
const installer = createRequire(maker.resolve("electron-installer-dmg"));
const appdmg = createRequire(installer.resolve("appdmg"));
const ds = createRequire(appdmg.resolve("ds-store"));
const macAlias = createRequire(ds.resolve("macos-alias"));
const DSStore = ds("./lib/ds-store");
const Entry = ds("./lib/entry");
const encode = macAlias("./lib/encode");
const utf16 = (s) => Buffer.from(s, "utf16le").swap16();
const unicode = (s) => {
  const b = Buffer.alloc(2 + s.length * 2);
  b.writeUInt16BE(s.length);
  utf16(s).copy(b, 2);
  return b;
};
function alias(
  parent = ".background",
  filename = "dmg-background.tiff",
  mount = "/Volumes/Convo Caddy",
) {
  const extra = [
    [0, Buffer.from(parent)],
    [1, Buffer.from("00000010", "hex")],
    [14, unicode(filename)],
    [15, unicode("Convo Caddy")],
    [18, Buffer.from("/" + parent + "/" + filename)],
    [19, Buffer.from(mount)],
  ].map(([type, data]) => ({ type, length: data.length, data }));
  return encode({
    version: 2,
    volume: {
      name: "Convo Caddy",
      created: new Date("2026-01-01Z"),
      signature: "H+",
      type: "other",
    },
    parent: { id: 16, name: parent },
    target: {
      id: 17,
      type: "file",
      filename,
      created: new Date("2026-01-01Z"),
    },
    extra,
  });
}
const good = alias();
fs.writeFileSync("tests/fixtures/installer/background.alias", good);
fs.writeFileSync(
  "tests/fixtures/installer/wrong-directory.alias",
  alias("other"),
);
fs.writeFileSync(
  "tests/fixtures/installer/embedded-name.alias",
  alias(".background", "other-artwork.tiff", "/Volumes/dmg-background.tiff"),
);
const store = new DSStore();
store.push(
  Entry.construct(".", "bwsp", { x: 180, y: 140, width: 560, height: 422 }),
);
store.push(Entry.construct(".", "icvp", { iconSize: 72, rawAlias: good }));
store.push(Entry.construct(".", "vSrn", { value: 1 }));
for (const [name, x, y] of [
  ["Convo Caddy.app", 150, 150],
  ["Applications", 410, 150],
  ["Uninstall Convo Caddy.app", 150, 300],
  [".background", 640, 460],
  [".VolumeIcon.icns", 640, 460],
  [".DS_Store", 640, 460],
])
  store.push(Entry.construct(name, "Iloc", { x, y }));
store.write("tests/fixtures/installer/finder-store.bin", (e) => {
  if (e) throw e;
});
