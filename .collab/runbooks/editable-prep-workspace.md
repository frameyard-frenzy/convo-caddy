# Editable prep and workspace

The [prep format and Save contract](../../docs/prep-format.md) and
[workspace relocation procedure](../../docs/workspace-move.md) are canonical.
Preserve selected filenames, direct inline cards, Save/Command-S, structural
undo, explicit revision conflict handling and dirty Quit Save/Discard/Cancel.
Old user-owned JSON prep/checkpoint compatibility remains supported.

Run `pnpm exec vitest run tests/desktop tests/server` and the synthetic browser
suite with `CI=1 pnpm test:e2e`. Source tests do not prove native file-panel,
cross-volume hardware, installed-app or live interview acceptance.
