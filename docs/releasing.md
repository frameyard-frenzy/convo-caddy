# macOS release preparation

## Explicitly approved unnotarized alpha publication

The release owner may explicitly authorize an unnotarized alpha, as for 0.1.0 and
0.2.0. That exception uses the ordinary `local-ad-hoc` source build, not the
`release-signed` command below. It does not authorize Apple credential access or
claim Developer ID signing, notarization, downloaded Gatekeeper acceptance,
installation, or live provider verification. Publish only from a reviewed clean
public commit with matching app and uninstaller versions. Verify the image,
bundled bytes, signatures and clean-source provenance; record actual checks and
any blocked native checks without relabeling them passed. Stage a draft with the
DMG, public-safe manifest and checksums, verify downloaded bytes, then publish
with the explicit unnotarized trust warning and recheck anonymous download hashes.
Keep the alpha marked as a prerelease.

## Developer ID signed and notarized releases

Release publication is gated. Source support does not authorize Apple credential access, notarization submission, tag creation, uploads, or repository visibility changes.

Release preparation must run from the reviewed, clean public repository HEAD after its explicit version and documentation are fixed. Set `CONVO_CADDY_SIGNING_MODE=release-signed` and provide a G1-approved `Developer ID Application:` identity, its Team ID, and a local notary Keychain profile. No identity, team, profile, or release version is approved by this guide. Missing or mismatched inputs fail closed; release mode never falls back to ad-hoc signing. Ordinary builds use `local-ad-hoc` and reject release credential variables.

```bash
bash scripts/prepare-release-mac.sh \
  --version 0.2.0 \
  --clean-export-sha FULL_40_CHARACTER_PUBLIC_HEAD_SHA \
  --approved-root-sha FULL_40_CHARACTER_APPROVED_ROOT_SHA \
  --manifest ../convo-caddy-release-manifest.json
```

`0.2.0` is a parser-valid example matching the current source package, not an approved release version. G2 must approve the actual version and the committed package metadata must match it before this command is used. The shell entry point works in a fresh clone: it performs a forced frozen-lockfile dependency installation before loading repository-local `tsx` or any signing/notarization code. A dependency failure stops before release side effects.

The machinery signs nested native/helper code and both applications inside-out. It archives, notarizes, and staples the standalone uninstaller before Forge embeds it; Forge signs/notarizes the main application; then preparation verifies both applications, notarizes/staples the final DMG, and only afterward hashes the artifacts. Validation uses `codesign`, `spctl`, and `xcrun stapler`. These commands must not be invoked before G1 authorizes the actual Apple identity and notarization activity.

The public manifest records the approved version, exact public HEAD SHA, lockfile digest, tool versions, arm64/macOS 14 contract, artifact names/sizes/SHA-256 values, bundle identifiers, verified team, notarization result, and reproducible verification commands. It excludes the private reviewed-source SHA, local paths, account email, notary profile, logs, private history, and developer-home data. The private-to-public provenance mapping belongs only in the approved private operational receipt.

G1 (Apple access/signing/notary), G2 (destination/version), G3 (downloaded real-machine and human/agent acceptance), and G4 (publication) remain required. A locally ad-hoc artifact is never the deliverable for this signed-release path; the explicitly approved alpha exception above is separate.

## Proposed operator action packet — not authorization

Freeze this packet before live release work. Blank fields are intentionally
unbound; source code and local ad-hoc artifacts must not invent their values.

| Gate | Required operator input and blocking evidence |
| --- | --- |
| G1 | Approved Developer ID Application identity, expected Team ID, private build-Mac/keychain scope and notary profile; nested/app/DMG signature, runtime, stapling, notarization and assessment receipts. |
| G2 | Approved public repository/destination and explicit nonhistorical version; final public README/release-note overlay diff and privacy scan before release. |
| G3 | Exact signed DMG/source/export hashes and approved Mac/data scope; browser-downloaded quarantine/Gatekeeper proof, human README pass, fresh independent-agent pass, kept-workspace reselection, and a separate disposable Yes fixture. |
| G4 | Exact tag, release, assets, clean source and manifest publication; post-publication URL existence and freshly downloaded remote hashes matching the frozen packet. |

Candidate fields to bind later: `release_version`, `release_repository`,
`source_sha`, `approved_root_sha`, `dmg_filename`, `dmg_sha256`, `zip_filename`,
`zip_sha256`, `team_id`, `notarization_submission`, `human_receipt`,
`agent_receipt`, and `publication_receipt`. Until all applicable fields are
approved and verified, README continues to say the signed release is pending.

The currently implemented local outputs have exact names, not release status:
`Convo Caddy-0.2.0-arm64.dmg` and
`Convo Caddy-darwin-arm64-0.2.0.zip`. Their hashes are generated anew by
`pnpm verify:package:mac` and `pnpm verify:install-uninstall:mac`; no hash in a
source document is an approved signed-candidate hash.

### Source binding and publication metadata

The release-only `--approved-root-sha` is the full root commit approved by the
release owner after repository cutover. No future root is embedded in source.
The legacy flag name `--clean-export-sha` means exact current public HEAD. The
repository must be non-shallow; HEAD may be that root or any descendant. Dirty,
mismatched, unsafe or untracked build inputs fail before packaging. Ordinary
`pnpm verify:public-tree` inspects committed HEAD without creating another Git
history. It checks every tracked file against the allowlist, scans text for
privacy/secret patterns, and checks local documentation links and commands.
Both source guards disable Git replacement objects for provenance reads, so
replacement trees, blobs or ancestry cannot substitute for committed source.
The public-tree scan batches blob reads by object ID to avoid a Git process per
file while retaining the complete committed-file scan.
The documentation check also inspects every package script for the repository's
plain pnpm chains, local source script paths and `--config` targets. It does not
execute commands or resolve external tools and generated build outputs.
Large/binary content still needs independent review; scanning is not a full audit.

The manifest destination must be outside the checkout, in an existing directory,
and must not already exist. Source provenance embeds HEAD. Record artifact hashes
in the external manifest and release notes after building; never amend a DMG hash
into its own source commit. Only after publication and remote byte verification
may a later documentation commit replace README's pending notice with the exact
version, URL, filename and checksum. No placeholder `latest` URL is permitted.

Pre-publication S1 failure—wrong signature/team/runtime, missing stapling or
notary acceptance, missing/modified local asset, checksum mismatch, or an unsafe
file in the source—stops before G4. Post-publication missing/broken assets or
remote hash mismatch is a failed release verification requiring new explicit
remediation authority; never silently rebuild or claim delivery.

## Installer artwork and acceptance

The DMG presents **Convo Caddy → Applications** above a separate **Remove Convo
Caddy** area containing **Uninstall Convo Caddy.app**. The ZIP contains the main
application only; use the DMG for the graphical uninstaller. Build both ICNS
resources and the multi-resolution background before assembling/signing bundles:
`pnpm build:icon` precedes `pnpm build:uninstaller` in `pnpm build:mac` and native
CI. Never patch bundle resources after signing. The main application icon is
unchanged. The package verifier checks registered removal artwork and mounted
Finder metadata as well as app trees and signatures.

The [post-merge acceptance checklist](installer-acceptance.md) defines exact
revision/build binding, Finder normal/Retina/narrow evidence and two fresh audience
passes. The onboarding program's human source-alpha gates and the release G1–G4
above are distinct: completing local source acceptance grants no Apple or
publication authority. No package test proves live off-LAN connectivity, real
Keychain behavior, Recall retention, or downloaded Gatekeeper acceptance.
