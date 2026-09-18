#!/bin/bash
set -u

fail() { printf 'Convo Caddy source build: %s\n' "$1" >&2; exit 1; }
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || exit 1
cd -- "$REPO_ROOT" || fail "cannot enter the source checkout."

platform="$(uname -s)" || fail "could not identify macOS."
arch="$(uname -m)" || fail "could not identify the processor architecture."
[ "$platform" = Darwin ] || fail "requires macOS. Downloadable binaries, when published, do not require source tools."
[ "$arch" = arm64 ] || fail "requires an Apple Silicon Mac (arm64); found $arch."
command -v sw_vers >/dev/null 2>&1 || fail "could not determine the macOS version."
macos_version="$(sw_vers -productVersion)" || fail "could not determine the macOS version."
macos_major="${macos_version%%.*}"
case "$macos_major" in ''|*[!0-9]*) fail "could not determine the macOS version." ;; esac
[ "$macos_major" -ge 14 ] || fail "requires macOS 14 or later; found $macos_version."
[ -f package.json ] && [ -f pnpm-lock.yaml ] || fail "source checkout is incomplete (package.json or pnpm-lock.yaml is missing)."

command -v node >/dev/null 2>&1 || fail "Node 24 is missing. Install Node 24 from https://nodejs.org/ and retry."
node_version="$(node --version 2>/dev/null)" || fail "Node could not run."
case "$node_version" in v24.*) ;; *) fail "requires Node 24; found $node_version. Install Node 24 from https://nodejs.org/." ;; esac
command -v pnpm >/dev/null 2>&1 || fail "pnpm 11.19.0 is missing. Run: corepack enable && corepack prepare pnpm@11.19.0 --activate"
pnpm_version="$(pnpm --version 2>/dev/null)" || fail "pnpm could not run."
[ "$pnpm_version" = 11.19.0 ] || fail "requires pnpm 11.19.0; found $pnpm_version. Run: corepack prepare pnpm@11.19.0 --activate"
command -v git >/dev/null 2>&1 || fail "Git is missing. Install the Xcode Command Line Tools with: xcode-select --install"
command -v xcode-select >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools are missing. Install them with: xcode-select --install"
command -v swift >/dev/null 2>&1 || fail "Swift 6 or later is required. Install current Command Line Tools from https://developer.apple.com/download/all/ or run xcode-select --install."
swift_version="$(swift --version 2>/dev/null)" || fail "Swift 6 or later could not run. Repair the Xcode Command Line Tools."
if [[ "$swift_version" =~ Swift\ version\ ([0-9]+)\. ]]; then
  [ "${BASH_REMATCH[1]}" -ge 6 ] || fail "Swift 6 or later is required. Update Command Line Tools from https://developer.apple.com/download/all/."
else
  fail "Could not verify Swift 6 or later. Check the selected Xcode Command Line Tools."
fi

free_kb="$(df -Pk "$REPO_ROOT" | awk 'NR==2 {print $4}')" || fail "could not determine free disk space."
case "$free_kb" in ''|*[!0-9]*) fail "could not determine free disk space." ;; esac
[ "$free_kb" -ge 8388608 ] || fail "at least 8 GiB free disk space is required in the source volume."

printf 'Installing locked dependencies in %s\n' "$REPO_ROOT"
pnpm install --frozen-lockfile || fail "dependency installation failed; no package was built."
printf 'Building the local ad-hoc macOS disk image…\n'
CONVO_CADDY_SIGNING_MODE=local-ad-hoc pnpm make:mac || fail "package construction failed; no installation was performed."
printf 'Build complete. Artifacts are under: %s\n' "$REPO_ROOT/out/make"
printf 'The disk image was built, not installed. Open it yourself and drag Convo Caddy to Applications.\n'
