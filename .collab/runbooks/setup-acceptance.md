# Setup acceptance diagnostics

## Save evidence and limits

The renderer builds one strict Save payload. The authenticated setup route maps
it into `ConnectionStorage.save`; storage records a candidate generation, writes
its Keychain items, reads each back, activates the generation, and cleans up old
generations. Only a successful response clears the draft. Renderer acknowledgement
then permits runtime replacement. None of these steps needs a selected workspace.

Apple’s [SecurityTool password prompt implementation](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_add.c)
asks for a password and confirmation when `-w` has no argument. The old adapter
provided one line. The correction supplies both lines through stdin and detaches
the child from any controlling terminal so `getpass` uses the pipe. Secrets stay
out of process arguments. Read-back verification, bounded output/time, exit-status
classification and generation recovery remain authoritative. This synthetic protocol proof does not diagnose a particular installation.

A compiled synthetic macOS `getpass` fixture (no Security framework or Keychain)
returned mismatch/exit 1 with the baseline one-line input and matched/exit 0 with
two lines. Browser fixtures exercise the real renderer, authenticated route,
transactional disk storage, production Keychain adapter with an injected native
runner, acknowledgement, and runtime replacement. Denial, timeout and mismatched
read-back reproduce green Assistant followed by failed Save. Their allowlisted
safe codes are visible alongside advice in the actual renderer; drafts and prior
authority survive, and a retry reconciles the candidate before committing. This evidence does not attest
to real Keychain prompts, a specific macOS binary version, or live services.
Live failures require separate diagnosis.

`tests/desktop/security-runner.test.ts` now exercises the production process runner
with an isolated compiled libc helper and a deliberately missing executable. It
covers OS spawn failure, synchronous spawn exceptions, timeout/SIGTERM and later
close settlement, two `getpass` reads, and child session/controlling-terminal
checks. Empty/NUL/CR/LF secret framing is rejected before any spawn. No test invokes
`security` or the Security framework. This proves behavior for the fixture child,
not an installed Keychain command, an interactive parent terminal, or a child that
ignores termination. Existing native production source did not need another change.

## Minimal human diagnostic procedure

Keep the current unsaved form open. Do not reset, discard, reload, or collect
request bodies, native stderr, credential files, Keychain values or screenshots
showing secrets. The older installed build’s generic message cannot identify its
cause. Adoption of the reviewed candidate is a separate human choice.

In the candidate, after an explicitly requested attempt, report only:

- app/source version, the button clicked, and whether its preceding checks passed;
- the visible error code or callback diagnostic category and HTTP status;
- whether the masked draft remains and whether reload happened.

`keychain_access_denied` means macOS rejected access. Check the Keychain prompt
and access before retrying. `keychain_unavailable` includes timeout or failed
native execution; check login Keychain availability. `keychain_write_failed`
means write or read-back verification failed; report it if a retry repeats.
`settings_storage_unavailable` means the settings filesystem rejected an
operation; check free space and app-data permission. `setup_unknown` deliberately
makes no cause claim. A lost response remains unconfirmed: Save may have committed,
and retrying the same replacements is safe. No diagnosis authorizes deleting
credentials or restarting Hermes.

## Recall/ngrok diagnostics

The component check uses one read-only Recall GET and separately tests local
and public signed synthetic POSTs. It creates no bot. An exact-domain endpoint
is required and redirects are not followed. Public responses must be HTTP 204;
other status codes, timeouts and connection failures have separate sanitized
categories, with allowlisted codes visible in Diagnostic details. Bodies, URLs,
query strings, secret headers and native error messages are not returned. Failed endpoint startup marks the public POST not attempted,
not a failed round trip. Startup timeout ownership/late cleanup still gates retry.

Severity is evidence-bounded. Exact Recall authentication, local callback, and
exact-domain endpoint prerequisites plus a known attempted public HTTP/transport
failure produce an amber warning with collapsed technical details. The probe is
local-origin, so Wi-Fi/ISP filtering, DNS/TLS, VPN/proxy or firewall policy may
affect it without proving anything about Recall-originated delivery; a real
tunnel/domain/redirect/access-policy problem remains possible. The warning's
next action is one human-operated private Teams test that admits the visible bot
and verifies actual live transcript text. Unknown, missing, inconsistent,
not-attempted or prerequisite-failure results remain red failures and open
details automatically. Success states carrying diagnostics, failure states
without a component-appropriate diagnostic, HTTP 204 represented as failure,
malformed HTTP statuses and transport codes carrying HTTP statuses are
inconsistent. Their report does not claim that a public request was attempted.
Mixed results follow the first blocking prerequisite;
never recommend proceeding to a call while one is proven broken.

For endpoint startup failure, check the authtoken, assigned domain and competing
domain owner. For a public HTTP status, check routing, redirects or access
policies. For timeout/connect failure, check DNS, network and ngrok availability.
Authentication rejection calls for API-key/US-West-workspace review; unavailable
Recall calls for retry/network/service checks and is not evidence that the key is
wrong. Retest deliberately. These are next checks, not claims about the live
cause. Neither synthetic success nor locally signing and checking with the same
entered secret verifies real delivery, dashboard subscriptions, matching
workspace signature ownership or retention. Save remains advisory-independent;
capture startup safety does not. The copied summary records overall severity and
local-origin limitations without values, URLs or raw exceptions.

## Listener acquisition and scope

`README.md` is canonical for both audience paths; `docs/hermes-connection-setup.md` is the
bundled guide. The canonical `scripts/acquire-hermes.py` reports only verified
profile, port and API base path. Agent metadata mode never reads `.env` or sends
a credential-bearing request. Standard PID/runtime records, native owner and
process generation, and loopback socket ownership establish the destination;
unauthenticated model metadata must return 401 before human credential acquisition.
Foreground and automatic startup use the same checks, without argv or inherited
environment discovery. See `docs/hermes-owner-handoff.md` for both topologies from the interview laptop
and the supported producer precision boundary.

Human copy mode captures the validated existing key in local/strict-SSH process
memory and sends it only to the interview laptop's `pbcopy` stdin after successful
authenticated model metadata and repeated identity/socket checks. It never creates
a replacement key. The whole-file parser supports only single-line assignments,
comments and blank lines. Unsupported multiline, escape or interpolation syntax
in any entry fails closed. Exceptional sources require private review, never
secret output to an agent.

`tests/fixtures/onboarding/running-hermes.py` executes the two human commands
extracted from the guide with synthetic process, HTTP, SSH and clipboard seams.
`start-time-producers.json` retains the three pinned source producers; tests cover
seconds and rounded centiseconds, stale records and exact native generation
changes during acquisition. The separate `scripts/enroll-hermes-key.py` human helper is tested by
`tests/fixtures/onboarding/enroll-public-key.py` against synthetic homes. It
preserves entries/modes, bounds input and transport, and rejects unsafe paths.
Actual-route browser tests verify literal command bytes and retained drafts;
package verification binds the helper resource to source bytes.

Current acquisition fixtures supersede older startup-discovery approaches.

API base path `/` and model `example-route` are independent. A model name does not establish
`/p/example-profile` or authentication ownership. Multiplex paths require verified support.

## Visual evidence

Use `CI=1 pnpm exec playwright test --config playwright.clarity.config.ts` for
synthetic main/setup routes. Keep compact olive headers, inline cards, attached
focus outlines and responsive layout. Screenshots do not attest to native Finder
appearance or live setup. Real provider and Keychain acceptance is separate.
