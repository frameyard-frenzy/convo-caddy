# Synthetic production-adapter acceptance

This parent-only integration exercises `SecurityKeychainPort` from the production target. Ordinary native tests inject Security calls; neither the runtime integration nor the Foundation termination control runs by default. Compilation and fake tests do not establish Keychain runtime success.

## Parent commands

After source review, warm the exact checkout with installed tools, then run the ordinary control in the existing authorized parent context:

```bash
bash native/uninstaller/Integration/run-synthetic.sh --build
bash native/uninstaller/Integration/run-synthetic.sh --control
```

The build compiles tests without executing them. The control uses installed Foundation `Process` to launch only `/bin/sleep`, deliberately times out, targets its exact PID, and requires Foundation-observed termination. Its `CONTROL PASS ... termination_confirmed=true` receipt records child PID/PGID and runner PGID. It also verifies that a stopped runner rejects a subsequent command. Require both zero test exit and that receipt. A failure or denial stops here; do not change permissions/context or proceed to Keychain execution.

Only after that control succeeds, the parent can run a fresh synthetic integration:

```bash
bash native/uninstaller/Integration/run-synthetic.sh --run
```

Capture full stdout/stderr with the existing parent tool. Require zero exit, the explicit `PASS actual production adapter` receipt, and inspection of the printed fresh fixture's `events.jsonl`; a build-only, skipped-test or zero-test result is not a pass. Rebuild after any source/head change. Existing Python 3, Swift, Swift Testing and SecurityTool are required. No downloads, installation, packaging, signing, app/uninstaller launch or sandbox overrides occur in this wrapper.

## Creation and scope

The launcher changes **only its own process umask to 0077 before exec**, which the in-process test code and its children inherit. The invoking parent's mask is unchanged. This makes Apple's database/lock creation requests produce the required 0600/0400 files without changing existing fixtures. The earlier c13ea11 parent run used parent mask 0022: primary creation succeeded, then strict validation stopped on database 0644/lock 0444 before inserts or deletion. The parent verified its eight normal configuration getters unchanged afterward. That retained run is not a RED/GREEN adapter result.

Each new integration uses two named private Keychains in a fresh mode-0700 `/private/tmp/caddy-adapter-<UUID>` directory. It never accepts an existing fixture or caller-selected Keychain. Before creation and around phases, independent effective/user/system/common list/default getters must yield successful fingerprints or the exact missing-default diagnostic. Dynamic default is excluded. Failed getters or changed snapshots stop without setters or restoration. Equal endpoints do not prove absence of transient changes.

SecurityTool performs fresh adds into exact private paths, with fixed visibly synthetic passwords and the production service, without `-U`, `-A` or `-T`. The native caller is distinct. Every item query uses a singleton synthetic search list or a validated item/Keychain. No password data is requested or logged. Process-local UI suppression applies only to the test process.

The fixture directory identity, owner, marker, regular type, one-link condition, POSIX canonical path and exact modes remain checked. Normal files require 0600. Only `.fl36DA8FA3` and `.fl5D78C252`, derived from `primary.keychain` and `foreign.keychain`, are allowed as lock companions; each must be current-user-owned, regular, single-linked, zero-size and exactly 0400, without special bits. Arbitrary `.fl` names, `-db`, symlinks and hardlinks stop. POSIX `realpath` avoids Foundation's `/private/tmp` to `/tmp` alias normalization. Database inode changes during controlled writes are not forbidden. This remains a fresh private namespace model, not a hostile same-user filesystem framework.

The actual adapter must reject wrong service/account/foreign Keychain references; the old scoped selector must return -25244 with target and sentinel retained; actual exact legacy deletion must remove only the target. After stale retry and the empty cleaner, target absence and unchanged sentinel/foreign references are checked again before PASS. Configuration checkpoints must remain equal. No fixture cleanup, `SecKeychainDelete`, unlink, restore or global setter exists; retain files for separately reviewed retirement.

## Bounded command ownership

The runtime path does **not** use `swift test`, a Python supervisor or an outer process-group kill. The shell and private-mask Python launcher exec the installed `swiftpm-testing-helper`. On macOS the compiled test output is an MH_BUNDLE, so this helper loads that already-built image and calls its entry point **in the same process**. No SwiftPM build/orchestration process remains during runtime.

The test process owns at most one Foundation child at a time. The fixed permitted commands are SecurityTool list/default getters and fresh synthetic adds; the ordinary control substitutes `/bin/sleep`. `SyntheticCommandRunner` registers the exact Process before spawn completes, records its PID, drains both output pipes without blocking, and caps each at 32 KiB. Each command has a 20-second deadline. A 300-second in-process watchdog and SIGINT/SIGTERM handlers cover the integration lifetime, including native API work between children.

On timeout, output failure or cancellation, the runner refuses further launches and signals only its known positive child PID: TERM, then KILL after one second only if still running. It requires Foundation to observe termination; it does not infer child exit from an outer leader/group exit. Denial stops signalling immediately. Unconfirmed/denied termination reports the owned PID and uncertain execution state, with no further getters, retry or restoration. Global timeout exits 124; handled cancellation exits 128 plus its signal; unconfirmed/denied global termination exits 126. Per-command failures make the test fail. Mutation outcome remains uncertain even when child exit is confirmed.

This is not a general process-tree manager. No scans, descendant discovery, group signalling or service actions occur. The supported commands do not intentionally launch additional application processes; macOS Security services reached through IPC are not owned children and are never signalled. Uncatchable SIGKILL, host failure, or a platform failure before Foundation can establish child ownership cannot promise graceful termination. The worker's previous signal denial was not retried or bypassed; the parent ordinary control must establish termination in its existing authorized context before the real run.

## Source rationale and evidence limits

Apple Security is pinned to `db15acbe6a7f257a859ad9a3bb86097bfe0679d9`:

- [SecKeychain.cpp](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/OSX/libsecurity_keychain/lib/SecKeychain.cpp), [Keychains.cpp](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/OSX/libsecurity_keychain/lib/Keychains.cpp) and [StorageManager.cpp](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/OSX/libsecurity_keychain/lib/StorageManager.cpp): creation reaches `created`, whose default/search-list preference changes are guarded by `shouldAddToSearchList`. These private names exclude the System path and login.keychain substring. Absolute path/HOME alone is not the isolation argument. Storage removal can save preferences, so no Keychain deletion cleanup is used.
- [keychain_add.c](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/SecurityTool/macOS/keychain_add.c): fresh adds stop if the named Keychain cannot open; `-U` is deliberately omitted to avoid its null-Keychain update-search fallback.
- [SecItem.cpp](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/OSX/libsecurity_keychain/lib/SecItem.cpp) and [keychain_find.c](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/SecurityTool/macOS/keychain_find.c): legacy `SecItemDelete` includes the trusted-application gate; SecurityTool uses public exact `SecKeychainItemDelete`.
- [AtomicFile.cpp](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/OSX/libsecurity_filedb/lib/AtomicFile.cpp): local locks use `.fl` plus the first four SHA-1 basename bytes rendered as uppercase hex. Database commits can rename over an old inode. SHA-1 is a filename compatibility rule here.

[Foundation Process source](https://github.com/swiftlang/swift-corelibs-foundation/blob/main/Sources/Foundation/Process.swift) supports separate process groups; an outer-group kill therefore cannot establish child termination. This source is not a verified Darwin binary match. [SwiftPM testing-helper entry point](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/swiftpm-testing-helper/Entrypoint.swift) uses `dlopen` and calls the bundle entry point in process. The installed loader was independently exercised with one injected test, without Keychain or signal operations. The parent control checks the installed Foundation lifecycle separately.

The prior parent full regression/review evidence applies to ba4ee130; the production Sources remain unchanged by subsequent harness corrections. Earlier algorithm-only synthetic RED/GREEN and 26 equal configuration checkpoints remain valid, but do not certify this actual adapter, the retained failed c13 fixture or the laptop. Unsupported nonlegacy backends fail closed. Parent runtime, eventual installer and human laptop retest remain separate acceptance work.
