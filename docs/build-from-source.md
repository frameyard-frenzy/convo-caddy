# Build Convo Caddy from source

The ordinary source-builder path is one command from a cloned Git source tree:

```bash
bash scripts/build-from-source.sh
```

It requires an Apple Silicon Mac running macOS 14 or later, Node 24, pnpm 11.19.0, Git, Xcode Command Line Tools with Swift, and at least 8 GiB free on the checkout volume. It verifies these prerequisites, installs exactly the locked dependencies, and creates a locally ad-hoc-signed DMG under `out/make/`. It works when the checkout path contains spaces and when invoked from another directory.

The script does not use `sudo`, install or upgrade tools, change shell profiles, open the DMG, replace an installed application, or run the contributor test suite. A completed build is not an installation and is not a signed public release.

Follow the [source installation and upgrade recipe](source-install-and-upgrade.md) for prerequisite acquisition and installation. Node 24 and pnpm 11.19.0 are pinned by this repository; do not assume Node includes Corepack. The recipe installs pnpm with npm into a user-owned prefix and sets PATH for that Terminal session. Official references: [Node installer](https://nodejs.org/en/download), [pnpm installation](https://pnpm.io/installation), and [npm's user-owned prefix procedure](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).

## Toolchain blockers

The script requires Swift 6 or later, not merely any installed Swift. Use `xcode-select --install`, then Apple's Software Update for Command Line Tools updates. If these cannot supply Swift 6, the owner can obtain **Command Line Tools for Xcode** from [Apple Developer Downloads](https://developer.apple.com/download/all/) after signing in with an Apple Account. Choose a version compatible with this Mac using [Apple's toolchain requirements](https://developer.apple.com/xcode/system-requirements), open its DMG and run its installer package, then check `swift --version` again. Xcode 16's toolchain requires macOS Sonoma 14.5 or later; the app's macOS 14 floor does not guarantee every macOS 14 installation can build it. An OS upgrade or toolchain change needs the Mac owner's decision; stop if no compatible Swift 6 toolchain is available. Do not install an unrelated unsigned binary to bypass this requirement.

The independently bundled **Uninstall Convo Caddy** application is included in the resulting DMG. Its minimum supported system is macOS 14. The source toolchain is needed only to build; a future signed downloadable application will not require Node, pnpm, Git, Xcode, or Swift.

## Contributor command matrix

Ordinary users should not run this matrix just to install the app. Install locked dependencies first. The source checks use synthetic providers and state; browser acquisition is separate from packaging.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm format:check
pnpm lint
pnpm typecheck
CI=1 pnpm check
pnpm audit:electron
pnpm verify:public-tree
```

`CI=1 pnpm check` runs format, lint, typecheck, unit tests, the desktop/client build, and Playwright. It is not a signed release. Isolated macOS package construction remains `bash scripts/build-from-source.sh` or `pnpm make:mac`; do not treat those as Developer ID signing, notarization, or publication.

The actual-route setup acceptance suite owns ephemeral loopback servers and
injects provider, credential-store, and desktop-window dependencies. It blocks
native subprocesses and external network requests before importing runtime code:

```bash
CI=1 pnpm exec playwright test --config playwright.setup.config.ts
```

For the full suite, if the default development fixture ports are occupied,
choose two unused ports without stopping or reusing another process:

```bash
CONVO_CADDY_E2E_PORT=14317 CONVO_CADDY_SETUP_FIXTURE_PORT=14318 CI=1 pnpm check
```

The setup font browser test serves source assets; it is not packaged-asset smoke
evidence. Package verification remains a separate check of an isolated build.

## Native source test results

A successful Swift compilation is not evidence that tests executed. Require a
nonempty test-result record with test identities and the expected gated skips.
On Command Line Tools-only hosts, the generated SwiftPM runner can lack access
to `Testing.framework` even when the test target can import it. Pass the installed
framework search path to the runner too:

```bash
swift test --package-path native/uninstaller --disable-keychain --disable-netrc \
  --enable-swift-testing -Xswiftc -F \
  -Xswiftc "$(xcode-select -p)/Library/Developer/Frameworks"
```

Use the same arguments with the `list` subcommand to verify discovery. Leave
`CADDY_RUN_SYNTHETIC_KEYCHAIN` and `CADDY_HARNESS_CONTROL` unset for ordinary
synthetic source tests; their gated tests require separate explicit scope. This
command compiles and tests source, without creating or signing an app bundle.

## Open the installer

```bash
open "out/make/Convo Caddy-0.1.0-arm64.dmg"
```

Use the [source installation and upgrade recipe](source-install-and-upgrade.md)
for safe replacement, fresh bundle comparison and Applications launch. Ordinary
first installation belongs in [Install](../README.md#install). The lower
**Remove Convo Caddy** area is only for separately authorized removal;
**No** keeps an external workspace in place.

The 560 × 400-point pale Finder composition uses real draggable file objects,
the unchanged main application icon, and a distinct removal icon. The background
contains instructions and an arrow, not fake file icons. Its 1× and 2× images
are combined into a multi-resolution TIFF. Finder's filename labels remain
native system text. If hidden files are enabled, `.background`, `.VolumeIcon.icns`
and `.DS_Store` may appear beyond the artwork and add scrollable space. Leave
them alone; the installer never changes your global Finder preferences. Resizing
smaller crops the fixed composition; widen the window to see the full instructions.

Maintainers regenerate artwork after editing `assets/dmg-background.svg` with
`pnpm exec tsx scripts/render-dmg-background.ts` (requires the contributor
Chromium install). This embeds the licensed Instrument Sans font while rendering,
blocks network requests, and writes the two committed PNGs and their source/font
hash receipt. Ordinary builds need no browser: `build:icon` builds both ICNS files
and the TIFF, then `build:uninstaller` copies and registers its icon before signing.
Running `build:icon` again preserves the already-built uninstaller bundle.

`pnpm verify:package:mac` checks mounted DMG bytes, the Applications symlink,
actual `.DS_Store` records, both app trees, signatures, and clean source provenance.
Its reader intentionally targets the pinned appdmg/ds-store single-leaf format;
an incompatible writer update fails closed and needs a reviewed reader update.
Metadata and PNG checks do not prove Finder appearance. Follow the
[post-merge acceptance checklist](installer-acceptance.md) for that evidence.
