# Install/uninstall evidence boundaries

Synthetic tests are not installed acceptance. See [release gates](../../docs/releasing.md)
and [installer acceptance](../../docs/installer-acceptance.md).

## Install/uninstall evidence map

The current authority is the [product contract](../PRODUCT_CONTEXT.md), together
with the release and installer acceptance contracts linked above. Matrix IDs
are stable historical identifiers, retained to map automated source/package
evidence to pending operational proof. The executable copy is `MATRIX_CASES`
in [the acceptance verifier](../../scripts/verify-install-uninstall-mac.ts).
The executable `NATIVE_ASSERTION_EVIDENCE` map binds every automated
subcondition to the exact Swift test identity that must appear in a Testing
Library **passed** record. Printed names, started records, aggregate counts, or
successful unrelated tests are rejected. The lifecycle-addon evidence likewise
requires all three verbose `unittest` `... ok` identities.

| ID | Contract heading | Current evidence |
| --- | --- | --- |
| W1 | **Workspace preservation** | Automated Swift descriptor-filesystem case: current external workspace plus default No; private state is removed and every workspace byte/location is retained. |
| W2 | **Workspace preservation** | Automated tagged-legacy nested case: verified no-overwrite preservation precedes ancestor and legacy `.env` removal; fake Keychain absence is valid. |
| W3 | **Workspace preservation** | Automated dedicated case: Yes in the sole primary prompt confirms the displayed whole-folder scope; only the identity-bound exact workspace is removed. |
| W4 | **Workspace preservation** | Automated old-root case: ordinary private uninstall retains the entire ambiguous external workspace, parent, and unrelated files. |
| W5 | **Inventory and path safety** | Automated assertions separately cover malformed/unreadable preferences; root/home and a true nested symlink ancestor; wrong bundle identity; owner-permission denial; mount-device fault propagation; and descriptor-pinned inode replacement. Each preserves the target and reports blocked/incomplete. |
| W6 | **Workspace preservation** | Automated production-seam fixtures separately inject `ENOSPC` at the data-write seam, interrupt a later cross-volume copy chunk with `EXDEV`, and make the destination-volume open fail with `ENODEV`; each retains the original and its containing root. Additional passed assertions cover copy/sync/publication boundaries, source change, and existing destinations. |
| K1 | **Credential cleanup** | Automated fake metadata-only Keychain port covers multiple generations/custom keychains, exact service only, unrelated entries untouched, no secret reads. Real disposable Keychain remains G3. |
| K2 | **Credential cleanup** | Automated fake locked/denied/unavailable/surviving-entry results are incomplete and require renewed approval. Real Keychain remains G3. |
| L1 | **Lifecycle exclusion** | Automated startup/idle, non-ended, ended, malformed and stale checkpoint cases: private cleanup without backup; concise nonblocking remote-capture information and zero provider calls. |
| L2 | **Lifecycle exclusion** | Automated Swift and real C-addon processes prove stable-inode startup exclusion, addon failure, crash release, helper lifetime, work drain and concurrent uninstall exclusion. |
| L3 | **Lifecycle exclusion** | Automated controlled process ports block legacy relaunch and unknown processes without name kills; reused SSH/Hermes listeners remain untouched. |
| R1 | **Interruption and restart** | Automated crashes at journal/preservation/deletion/verification boundaries prove residual state, renewed confirmation and no-overwrite recovery evidence. |
| R2 | **Interruption and restart** | Automated cancel-before/during, repeated run and two-uninstaller cases prove no implicit Yes, serialization and truthful partial outcomes. |
| P1 | **Packaging and ordinary outcomes** | Automated missing app, already-ejected DMG, absent optional paths and independently reopened uninstaller outcomes. |
| P2 | **Packaging and ordinary outcomes** | Automated non-writable target returns limited manual-permission guidance without root escalation or false success. |
| P3 | **Packaging and ordinary outcomes** | Mixed: packaged app/addon/uninstaller launch under stripped developer-tool PATH is automated. Browser-downloaded quarantine and Gatekeeper without bypass remain G1/G3. |
| D1 | **Independent audience acceptance** | Pending: human README keep-workspace pass, fresh-agent no-saved-state/reselect pass and separate disposable-fixture Yes pass require the exact signed G1/G3 candidate. README source contracts are automated but are not the pass. |
| S1 | **Publication integrity** | Mixed: source tests block signature/team/notary, missing/checksum/modified local artifact and unsafe-source failures. Public link and downloaded remote hash checks remain G4. |

The synthetic receipt is issued only when the requested source SHA equals the
actual clean `sourceRoot` HEAD. Packaging embeds that clean source identity in
`dist/desktop/build-provenance.json`; the package verifier confirms it against
the current clean checkout. The acceptance harness then requires an exact
one-to-one set of canonical DMG and ZIP paths, artifact types, and SHA-256
values. A stale build, renamed/copy substitute, swapped type, duplicate hash,
extra artifact, or incomplete set cannot be recorded beside a newer commit.

Route team approval questions to Mo. The serialized approval marker in a
reviewed G3 scope file remains `approvedBy: "Moritz"`: this is a quoted public
machine contract, not the name used in team conversation. Scope-review mode
does not perform live operations.

## Independent people and agent passes (G3 packet)

These are two separate observations on one exact G1-built candidate. Record its
source commit, DMG hash, Team ID, notarization result and download URL
before either pass. Never carry undocumented workarounds from the first pass to
the second.

1. **Human pass:** follow README [Install](../../README.md#install); download/verify, drag, eject,
   configure only through the app, use a disposable practice fixture, launch the
   graphical uninstaller, keep the workspace with the default No, and retain its
   exact evidence report.
2. **Fresh-agent pass:** begin without the human pass's private notes or saved
   credentials. Follow README **For agents**; hand credentials, Gatekeeper,
   Teams admission, Keychain prompts, and deletion confirmation to the human.
   Confirm first launch has no saved credentials/workspace, then reselect the
   retained workspace.
3. **Disposable Yes pass:** use a separately approved disposable fixture, review
   the exact path and whole-folder scope in the primary prompt, choose Yes, and
   prove only that fixture is removed. Never
   reuse real interview data to prove deletion.

Every item is reported as `verified`, `user-confirmed`, `retained`, or
`blocked/unverified`. P3 quarantine/Gatekeeper, real Keychain K1/K2 and all D1
steps remain pending until G1/G3; a similarly named unit test cannot satisfy
them.

