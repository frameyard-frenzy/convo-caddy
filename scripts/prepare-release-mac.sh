#!/bin/bash
set -u

fail() { printf 'Convo Caddy release preparation: %s\n' "$1" >&2; exit 1; }
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || exit 1
cd -- "$REPO_ROOT" || fail "cannot enter the exported source tree."

[ -f package.json ] && [ -f pnpm-lock.yaml ] || fail "exported source is incomplete."
command -v pnpm >/dev/null 2>&1 || fail "pnpm 11.19.0 is required before release preparation."
pnpm install --frozen-lockfile --force || fail "locked dependency installation failed before signing or notarization."
pnpm exec tsx scripts/prepare-release-mac.ts "$@" || fail "release preparation failed."
