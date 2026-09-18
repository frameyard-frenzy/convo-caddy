#!/bin/bash
set -euo pipefail
if [[ "$#" != 1 || ! "$1" =~ ^--(build|control|run)$ ]]; then
  echo 'Usage: run-synthetic.sh --build | --control | --run (parent runtime only)' >&2
  exit 2
fi
repo_root="$(cd "$(dirname "$0")/../../.." && pwd -P)"
if [[ "$1" == --build ]]; then
  build_scratch="$(mktemp -d /private/tmp/caddy-adapter-build-XXXXXXXX)"
  export CLANG_MODULE_CACHE_PATH="$build_scratch/module-cache"
  export SWIFT_MODULECACHE_PATH="$build_scratch/module-cache"
  unset CADDY_RUN_SYNTHETIC_KEYCHAIN CADDY_HARNESS_CONTROL
  frameworks="$(xcode-select -p)/Library/Developer/Frameworks"
  [[ -d "$frameworks/Testing.framework" ]] || { echo 'Installed Testing framework missing; stop.' >&2; exit 1; }
  # Compilation only, no test or app launch. No sandbox override or downloads.
  swift build --package-path "$repo_root/native/uninstaller" --build-tests \
    -Xswiftc -F -Xswiftc "$frameworks"
  exit
fi
binary="$repo_root/native/uninstaller/.build/debug/ConvoCaddyUninstallerPackageTests.xctest/Contents/MacOS/ConvoCaddyUninstallerPackageTests"
[[ -x "$binary" ]] || { echo 'Build this exact source head first with --build.' >&2; exit 1; }
unset CADDY_RUN_SYNTHETIC_KEYCHAIN CADDY_HARNESS_CONTROL
if [[ "$1" == --control ]]; then
  export CADDY_HARNESS_CONTROL=parent-control
  selected='SyntheticFoundationControlTests/directFoundationChildTimeoutIsObserved'
else
  export CADDY_RUN_SYNTHETIC_KEYCHAIN=parent-reviewed
  selected='ProductionKeychainIntegrationTests/actualAdapterRemovesOnlyValidatedSyntheticItem'
fi
swift_bin="$(xcrun --find swift)"
helper="$(dirname "$swift_bin")/../libexec/swift/pm/swiftpm-testing-helper"
[[ -x "$helper" ]] || { echo 'Installed in-process test-bundle loader missing; stop.' >&2; exit 1; }
# The macOS test output is an MH_BUNDLE. Apple's helper dlopens it in this same process.
# exec removes shell/Python/SwiftPM orchestration; mask changes only in the launched child.
# Capture stdout/stderr with the existing parent tool. Require the explicit CONTROL/PASS receipt.
exec python3 -B "$repo_root/native/uninstaller/Integration/launch-private.py" \
  "$helper" --test-bundle-path "$binary" --testing-library swift-testing --filter "$selected"
