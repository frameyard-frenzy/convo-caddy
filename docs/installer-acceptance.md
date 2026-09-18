# Post-merge onboarding and installer acceptance

This checklist requires separately authorized packaging and human acceptance.
It does not declare live-account, installation, signing or publication gates passed.
Keep private receipts and screenshots in an assigned directory outside the checkout.
Never put secrets or real interview content in evidence.

## Bind the reviewed merge and rebuild

1. Wait for independent whole-PR review, exact-head hosted CI/native success,
   and the separately authorized merge. In the pinned checkout, the coordinator
   fetches `origin/main`, verifies that it contains the accepted PR head, and
   records the full merge SHA. Use that exact merge
   for both audience passes; a correction requires new candidate evidence.
2. From the clean accepted checkout, record these outputs:

   ```bash
   git status --porcelain=v1 --untracked-files=all
   git rev-parse HEAD
   node --version
   pnpm --version
   ```

   Status must be empty. Node must be 24 and pnpm 11.19.0.
   Use the source builder's normal macOS/Swift/space preflight without bypasses.
3. Run `bash scripts/build-from-source.sh`, `CI=1 pnpm check`,
   `pnpm audit:electron`, and `pnpm verify:install-uninstall:mac` in an allowlisted
   environment with only the tool PATH, HOME/TMPDIR/LANG, CI, unused fixture ports,
   any required local pnpm layout setting, and local-ad-hoc signing mode. Exclude
   all provider/service secrets, SSH_AUTH_SOCK, Developer ID and notary inputs.
   Inspect fixture ports before testing; set `CONVO_CADDY_E2E_PORT` and
   `CONVO_CADDY_SETUP_FIXTURE_PORT` to unused ports and never reuse a running server.
   The harness uses temporary roots and fake Keychain/process adapters, not
   real-machine mode. Its package verifier runs the candidate's setup-only smoke.
4. Record the package receipt's clean source SHA, artifact paths and SHA-256,
   signatures and complete cleanup. Bind each receipt to the checkout and bytes
   actually verified. Local ad-hoc evidence is not signed release acceptance;
   signed candidates follow [releasing.md](releasing.md).

## Actual Finder evidence — no installation in this step

1. Hash the exact DMG, mount it read-only, and open only its volume in Finder.
   Do not launch either app, drag to Applications, open unrelated windows,
   change global Finder preferences, or record the whole desktop.
2. Capture the candidate Finder window at its default size. Verify real
   **Convo Caddy → Applications** objects and unobscured labels, pale compact
   background, a separate lower removal icon and **Remove Convo Caddy** text.
   No duplicate decorative file icons, arrow through labels, or heavy frame.
3. Record display logical dimensions and backing scale. Capture a normal 1×
   display and an actual Retina 2× display when available. Two PNG source
   resolutions do not count as two observed display modes. Mark unavailable
   hardware evidence pending; do not change global display settings to simulate it.
4. Resize only this Finder window narrower, capture the result, and restore its
   size. The artwork is fixed, so narrowing may crop and scroll; verify that
   widening restores the intended composition without moving objects. Record
   actual dimensions and any truncated instructions/labels.
5. Preserve the existing hidden-file preference. If enabled, hidden metadata
   lives beyond the artwork and can add scrollable area. Record the setting's
   observed effect without toggling it globally. Eject only this mounted disk,
   verify it detached, and retain the unchanged DMG hash with every screenshot.
   If desktop capture/control is unavailable, mark Finder evidence pending;
   DS_Store, SVG and package assertions cannot pass this gate.

## Fresh human pass, then fresh agent pass

These actions require the user's bounded live acceptance authority. A source PR
or this checklist is not install/uninstall or service-change consent.

1. **Human-led pass:** use only the final README as the guide. Download/open the
   exact candidate, drag/install, eject, launch; observe the final installer
   labels. Enter each Recall/ngrok secret once; test success and a safe failure,
   confirming the masked draft stays. Confirm all ten webhook subscriptions.
2. Choose local or remote Hermes. The human completes private network enrollment,
   Remote Login, public-key enrollment, trusted fingerprint comparison and key
   unlock as needed. Any Hermes configuration/restart needs separate explicit
   approval. In the Finder-launched app, **Load models** must work on the second
   network (for example a hotspot). Select the route explicitly; **Test assistant**
   is one optional, separately authorized synthetic inference with cost/retention.
   Induce safe network loss, restore it and use the relevant retry without replay.
3. Save, choose a disposable synthetic workspace/prep, admit the visible Teams
   bot, confirm its notice, and practice Notes, Questions, Revisit and Assistant.
   Confirm hidden-by-default transcript, four-file finished record, archived prep,
   quit and reopen. No real customer data. Provider retention remains unconfirmed
   unless separately evidenced; Hermes may retain API sessions and use its tools.
4. With explicit removal authority, finish capture, quit and open the lower
   uninstaller. Review inventory, keep the workspace by default, and retain the
   exact result. Verify unrelated files, Hermes, SSH and Tailscale remain intact.
5. **Fresh agent-led pass:** give a new agent only the final README and bounded
   user consent, not implementation workarounds. The human handles secrets,
   account prompts, trust, recording admission and deletion decisions. Verify
   clean local Caddy setup and reselect the retained workspace. Across the two
   passes, exercise deletion only on a separately approved disposable workspace
   after exact-path review and the explicit primary confirmation. Never infer destructive consent.
6. Record each result as verified, user-confirmed, retained, or blocked/unverified.
   Include revision, DMG hash, Mac/OS, source of consent, expected/actual result,
   screenshot/receipt link and next owner. Report real Keychain, VoiceOver,
   quarantine/Gatekeeper, off-LAN, provider, retention and audience gaps separately.

Apple credentials, Developer ID, notarization, public destination/version,
publication and downloaded-release verification remain the distinct gates in
[releasing.md](releasing.md). No source-alpha pass substitutes for them.
