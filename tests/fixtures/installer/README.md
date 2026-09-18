# Pinned installer-format fixtures

Generated synthetically by the installed `ds-store` **0.1.6** writer and
`macos-alias` **0.2.12** v2 encoder (both MIT), reached through the pinned
Forge → electron-installer-dmg → appdmg dependency chain. No participant,
filesystem inventory, native alias lookup, credentials or real mount metadata
is used. Catalog IDs 16/17 and the 2026-01-01 date are synthetic constants.

Regenerate from the repository root on a Mac with packaging dependencies:

```bash
node tests/fixtures/installer/generate.cjs
```

`finder-store.bin` is the writer's complete 15364-byte DSStore: six icon
positions, real binary `bwsp`/`icvp` plists and vSrn=1. The allocator at 8196
has three addresses `0x200b`, `0x45`, `0x100c`; the DSDB table entry at 9233
names block 1 (offset 68), whose root is block 2 (offset 4100), height zero,
one node and a 4096-byte page. It is not a zero-filled invented header.

The writer copies its fixed template and changes only bytes `[76,80)` (record
count) and `[4100,7940)` (leaf header/records/zero padding). Normalizing exactly
those two ranges to zero gives SHA-256
`7296a1abb4d34ebfd2fe6eeb5d202f8c2d230f053cc2b041f0dca57a5e110037`.
The verifier binds all remaining bytes before trusting the fixed leaf location,
including allocator/free lists, table, live-root and tree metadata. A dependency
format change needs a reviewed fixture/reader change, never a silent new hash.

`background.alias` targets `/.background/dmg-background.tiff` within the named
volume. `wrong-directory.alias` is a complete valid v2 alias with the same
basename in `/other/`. `embedded-name.alias` targets `other-artwork.tiff`, with
`dmg-background.tiff` appearing only in its volume mount path. The latter two
are structurally real aliases, but are invalid installer background references.
Tests mutate copies for truncated allocator/root/count and alias/tag cases.

The alias verifier accepts only the encoder's fixed header and tag sequence
0/1/14/15/18/19 plus the exact terminator. It checks Pascal/Unicode names,
the fixed Convo Caddy volume name, parent and target catalog IDs, and the exact
volume-relative path. The original
absolute volume mount path is validated syntactically, never resolved: a DMG
can legitimately be remounted at another location. This is bounded package
metadata verification, not a general Alias Manager or DSStore parser.
