# Convo Caddy product contract

Current behavior, not authorization for operational work.

## One sentence

Convo Caddy is a calm, nearly hands-off Microsoft Teams companion that keeps one interviewer oriented while a hidden transcript preserves the conversation underneath.

## Intended portable-MVP user

The intended MVP user is a technical interviewer on Apple Silicon macOS who uses Microsoft Teams, already has Hermes Agent, and is willing to configure personal Recall.ai and ngrok accounts. Supporting that deliberately narrow audience is enough for the MVP. 

The MVP remains purposeful rather than generic. It does not support Zoom, Google Meet, multiple transcription languages or Recall regions, direct model-provider integrations, arbitrary remote agent endpoints, additional commands, provider plug-ins, or a generic notes mode. Roadmap presence never authorizes those additions.

## Editable prep and workspace relocation — current authorization

Direct human editing and workspace relocation are supported. Person summary is optional human-authored reference context in Markdown prep, the page, durable checkpoints, on-demand context and finished conversation output. It is not generated biography or testimony.

Inline direct create/edit/remove is authorized for summary, both Prepared tiers, Notes, Questions, Revisit, title and planned duration. These actions make zero model calls. Existing marks retain their IDs, transcript references, timestamps and checks on text edits; human edits carry attribution. Newline entry supplies automatic bullets or checkboxes. Actual text and empty card space are editable in place, including metadata on the original selected-prep text. One optional Save button plus Command-S saves current edits. No Add/Edit/Remove/Cancel editing controls or separate forms remain. Enter splits, Backspace joins, paste creates automatic items, clearing text removes it at flush, and immediate structural undo protects accidental merges. Checked items remain visible and reversible. Machine transcript, timestamps and Assistant history remain immutable. Failed saves retain drafts; explicit revision checks and SSE response ordering protect newer state. Older checkpoints hydrate missing human metadata from their saved prep binding before display/edit. Persisted metadata accepts legacy JSON title/duration values without truncation; direct edits may retain unchanged legacy values or omit unchanged fields while keeping existing limits for replacements. Prep byte limits remain unchanged. Capture-time working-prep refresh advances the revision only when editable content changes; failed pre-capture persistence rolls back content, revision and binding together. Every Assistant submission and capture start flushes current drafts to the existing private active-session.json before proceeding. Automatic provider completion is held by a persisted content-flush barrier until the page finishes composition and pending acknowledgements and explicitly acknowledges the current saved revision for export. Flush failure retains drafts and blocks stale downstream operations. Later typing cannot be erased by an older response. Before conversation start, explicit Save and automatic flush atomically write the bound selected prep original and owned working copy as well as the interview checkpoint; after start, they save only the interview. External byte changes conflict rather than being overwritten. The lifecycle boundary, bounded retry receipt and exact target semantics are in docs/prep-format.md. Unflushed keystrokes remain in the page, not a second Markdown mirror. The selected prep identity stays visible. The last successfully saved pre-conversation prep bytes remain provenance in exports beside the live conversation snapshot.

The top native Workspace menu provides **Move workspace…**, with parent selection and exact-destination confirmation. It copies all dedicated-workspace entries, verifies content, switches checkpoint/preferences and ownership, then retires only matching source entries. Same/cross-volume execution uses copying; symlinks never grant traversal of external targets. Active capture, pending writes and open file selection block relocation. A bounded private recovery journal resolves interruption; unavailable or changed contents stop safely. While a move journal remains, the running application keeps conflicting writes blocked even after authority switches. Startup recovery must complete before writes resume; cancelling or rejecting a move before journaling releases writes normally. Uninstall must not erase an unresolved move journal. No credentials or private app-state migration is authorized. The canonical implementation/recovery description is [docs/workspace-move.md](../docs/workspace-move.md).

The prep picker tooltip is exactly **Choose a markdown prep file.** There is no visible helper line beginning that text. The redundant Application status card is removed; header status and compact actionable connection diagnostics/retry remain. Every focus accent touches its control border with zero gap. Normal and narrow synthetic-route screenshots are evidence, not native or operator acceptance.

The top **Workspace and prep** panel also owns the compact **Saved interviews** status/history subsection and the gated **New interview** action. It does not reload an older session or duplicate a second lifecycle panel. Mo’s acceptance correction makes History a single name: the latest finished interview by completion time, independent of filename or scan order. No per-record disclosures or second growing list are rendered. All archived records remain on disk, accessible through the existing Workspace → Show Workspace in Finder menu. Current saving/errors and New interview gating remain visible.

## User-owned prep and completed conversations

Setup selects a parent and exclusively creates `Convo Caddy Workspace/`, or reuses a previously app-created workspace whose marker matches its device and inode. Neither the folder name nor old preferences establish recursive ownership. Collisions are rejected without adoption or overwrite. Workspace placement within Application Support and Caddy private runtime/control state is unsupported and rejected before preference/content writes, including filesystem case and symlink aliases.

The optional inline **Saved interview name** is the filename authority, independent of the prep’s editable title. Mo authorized real human-named records: an accepted name preserves safe spaces, case and Unicode in `finished-conversations/<name>/` and `prep/archive/<name>.md` (or `.json`). The server rejects unsafe names and case/Unicode-equivalent names already present in the current workspace; it never silently suffixes or overwrites. Empty names use the bounded default `Interview <UTC start timestamp>`, without template or working-copy IDs. Saves and capture validate availability; final publication rechecks it. Active renames reach the checkpoint and final paths together; failed edits retain drafts and block downstream Ask/capture/Finish. A changed saved name is validated before other new page edits, so reused prep with an unavailable name can be corrected alongside question/title drafts. An uncertain pending edit retains its original identity and retry order. Same-record recovery verifies existing output; an existing truncated archive from an abrupt process stop remains a preexisting recovery limitation and is not overwritten. Legacy finalization retains its old path calculation; historical completed files are not renamed.

The dedicated user workspace is authoritative for prep and completed interviews. Human-authored Markdown is the normal prep format: `prep/TEMPLATE.md`, working copies under `prep/current/`, exact non-overwriting archives under `prep/archive/`, and atomic four-file records under `finished-conversations/`. New records contain `manifest.json`, `conversation.json`, `conversation.md`, and exact starting Markdown bytes as `prep.md`. Existing JSON preps and four-file records with `prep.json` remain readable within the same bounded prep reader. Initialization never overwrites existing templates or migrates user files. The canonical authoring rules and lifecycle are [docs/prep-format.md](../docs/prep-format.md).

**Choose prep…** opens the actual native macOS Open panel at `<workspace>/prep`, with Markdown first and legacy JSON available. The human can navigate to any explicitly selected regular prep file. Only the native dialog callback grants that file read/write authority; browser requests cannot submit arbitrary paths. Validate the selected file’s identity, UTF-8 contents and size, then exclusively create a uniquely named owned working copy. The latest explicit Save authority permits pre-conversation writeback to that exact selected writable original. Do not move/delete it or write inside a signed application bundle. Browser callers cannot provide an arbitrary write path. Until a page content edit, capture rereads the selected working copy; thereafter the edited snapshot is authoritative. Completion archives its exact starting source bytes. A source edit since opening prevents a stale save.

Selection populates title, duration, optional Person summary and Must/More Avenues. Cancel, invalid files and a session change during selection preserve the existing prep and session. Selection remains prohibited once capture starts. Delayed selection responses do not replace newer session/capture state already received by the UI. The browser regression fixture retains a fresh list of direct current files and preserves scrolling/focus through readiness polling; it is not native visual evidence or an arbitrary-path reader. Native appearance requires separate authorized human acceptance.

Application Support stores only preferences, credential references, Electron/log state, and one `active-session.json` checkpoint. `SessionService` writes it on fresh live-ready startup, before capture, with a nullable workspace binding. File presence does not prove an active interview. A bound checkpoint stores the resolved originating workspace, parsed prep, source basename, and exact source bytes. Completion clears it only after the final folder and prep archive are durable. Existing final or archive paths are accepted on retry only when their contents match; JSON object-key order may differ after checkpoint parsing, while Markdown and source prep bytes remain exact. Existing files are verified, never rewritten by retry.

No workspace or legacy private bytes are removed because time passes. The prior private managed archive, seven-day pruning, migration publisher, automatic ZIP preference/delivery ledger, retry routes, and manual ZIP download are no longer product behavior. A separately launched native uninstaller may remove confirmed local data only after explicit review; its default is to retain workspaces, and a legacy nested workspace must be preserved and verified outside the removal ancestor first.

The uninstaller presents one primary “Also delete your workspace?” dialog when a workspace exists: No / Yes / Cancel, with No default. That dialog grants app/private-content/credential removal consent and shows the exact existing workspace path and whole-folder scope. Yes additionally confirms deletion of a verified dedicated child, never its parent. No keeps an external workspace in place. With no workspace after interrupted-inventory reconciliation, show an ordinary “Uninstall Convo Caddy” confirmation with Uninstall / Cancel and no workspace question. Only Uninstall proceeds with private cleanup; Cancel and unrecognized responses do not execute or grant workspace deletion consent. There is no introductory or trailing confirmation. The whole private Convo Caddy support root is normally removed, including unknown private contents; missing/null workspace preferences do not change that rule. Known nested legacy or saved workspaces must be preserved outside deletion roots before keep can complete. Backend and UI containment compare filesystem identity, including case aliases. Ambiguous older external workspaces remain untouched, with actionable keep-only removal and no automatic migration/adoption. Deletion ownership is revalidated with inventory under the existing lock; retained paths are checked before reporting success.

Interview checkpoints, including idle, stale, malformed, and unfinished states, are private content authorized for deletion with either choice. They never mandate copying the entire Support root or a preservation acknowledgment. Recognized non-ended Recall state with a bot ID adds a concise nonblocking Teams reminder; it does not prove the bot remains active and no provider is contacted. Known nested requested-kept workspaces still require preservation. An interrupted **uninstall** journal remains distinct: fresh primary consent, current inventory, and existing saved-workspace recovery checks are required; Cancel retains the journal. Retry reconciles outstanding journal targets before fresh consent and again under the maintenance lock, so deleting Support/preferences cannot erase a remaining dedicated workspace from discovery. Its exact path is shown for fresh No/Yes consent; old intent never authorizes automatic deletion. Matching identity and dedicated ownership are required; changed or unverified targets block without replacing the journal. Already-missing targets are not claimed retained. Optional workspace metadata in schema-v2 journals preserves discovery across further interruptions after No, while existing pending-copy plans and verified receipts remain protected.

The Electron main process holds a shared native advisory lock before normal startup writes. The standalone uninstaller holds the same stable owner-private inode exclusively through preservation, deletion, and verification. Its control directory is outside removable app state and contains only the non-content lock marker plus a schema-versioned metadata-only journal while recovery is incomplete. It never contacts or changes Recall, ngrok, Teams, Hermes, SSH, or model providers.

## Visual identity

Convo Caddy is unmistakably its own application and uses its own conversation
mark, while belonging visibly to Frameyard. Its interface follows the canonical
Frameyard brand system rather than defining a competing identity: Instrument
Sans leads the product, IBM Plex Mono is limited to timestamps and machine
state, Datum Canvas is the environment, Olive Anchor carries structure, and
Signal Green communicates active state. The app remains a light material
workspace, not a dark theme or generic SaaS dashboard.

The source-built DMG uses a compact pale Finder surface: Convo Caddy and
Applications form the primary drag row, with a distinct standalone uninstaller
below under “Remove Convo Caddy.” The main icon stays unchanged. Background
source and 1×/2× renders are tracked; both bundle icons exist before signing.
Mounted metadata/resource checks and actual Finder visual acceptance are separate.
No installer presentation change expands uninstall consent or live setup authority.

The visual contract requires attached focus and selection accents on every control and every authored route, including buttons, fields, selects, checkboxes, disclosures and custom controls. There must be zero visible gap at the actual border, following its shape; neither a positive outline offset nor a wrapper/shadow gap is acceptable. Keyboard focus must remain visible. API base path and model selection are independent.
Save and callback diagnostic source corrections remain synthetic proof, with live
causes unconfirmed. See
[`runbooks/setup-acceptance.md`](runbooks/setup-acceptance.md) for the canonical
flow, evidence limits and minimal non-secret diagnostic procedure.

The same authorized clarity unit places Show/Hide transcript at the transcript destination, with explicit accessible disclosure state and keyboard focus. Incoming turns never open it; citations and item context controls reveal only their referenced turns with a compact **Filtered** status and text-style native **Clear filter** button in one quiet header. Clearing the filter keeps the transcript open and includes current and later finalized turns without mutating interview data or making a model call. Transcript turns use spacing instead of horizontal rules; metadata stays readable and filter/disclosure focus survives background refresh. Equivalent application containers use a uniform 16px gap.

Connection settings uses a compact pale branded header with top **Back to app** navigation. **Save** and a brighter functional destructive red **Reset credentials** are the only page-level mutation actions; inline tests and model discovery remain. Back confirms actual unsaved draft loss and never saves silently. Incomplete setup or an active operation blocks return; a refused runtime return preserves the draft and allows retry. After accepted Back, lost or unreadable status responses are retried read-only for up to ten seconds; only confirmed refusal unlocks the draft. Unresolved return keeps editing locked and explains how to quit/reopen. Save acknowledgement, lost-response recovery, mutation serialization and stale-result protection remain authoritative. Settings uses separated white cards with the main page’s 10px corners, divider border, responsive padding and 16px gaps. Compare both routes at the same viewport scale and inspect focused control pixels, not only computed outline offsets. The explicit brighter destructive red remains functional; native Open-panel styling belongs to macOS.

## The actual usability problem

Mo is alone. His scarce resource is attention. During a useful interview he must listen, preserve rapport, notice an opening, follow surprise, remember what remains important, avoid leading the participant, and land concrete next steps.

The product succeeds only if it lowers that burden. A feature that is analytically impressive but causes Mo to read captions, classify claims, navigate panels, or manage an agent is a product failure.

## Live surface

### Prepared Questions

One visible bank with two tiers:

- **Must** — a few questions/topics whose omission materially weakens the interview.
- **More Avenues** — a much longer bank of useful directions so Mo never runs out of places to go.

Mo manually checks an item when he judges it addressed, whether asked directly or reached through conversational drift. Checked items fade, stay visible, and can be restored.

Questions are user-authored in the bounded [prep format](../docs/prep-format.md).

### Revisit

Participant-originated threads Mo wants to return to. Every item has a short cue, timestamp, stable transcript reference, checkbox, and reversible completed state.

### Questions

New interviewer-originated questions Mo thinks of but does not want to ask immediately. Preserve exact text, timestamp, transcript reference, checkbox, and reversible completed state.

### Notes

Mo’s observations. Notes do not become pending questions or Revisit items unless Mo explicitly creates those separately.

### Assistant

On-demand contextual help only. Ordinary text asks the user-selected Hermes agent a question and never mutates lists by default. The interface labels this surface **Assistant**. Responses should be short, admit absence or uncertainty, and cite transcript turns where useful.

## Exact input contract for the MVP

- `/note <text>` — trim outer argument whitespace only, preserve text, create one Note, zero model calls.
- `/question <hint>` — exactly one model call using the hint and command-time context; on valid success atomically append exactly one specific interviewer-originated Question. The hint is not saved literally.
- `/revisit [hint]` — exactly one model call using command-time context and the optional hint; on valid success atomically append exactly one participant-originated Revisit item. The hint is not saved literally.
- ordinary non-slash text — exactly one model call; append only to Assistant chat; never mutate Prepared Questions, Revisit, Questions, or Notes.
- unknown slash command — local error, no mutation, no model call.
- empty required argument — local error, no mutation, no model call.

No automatic rewriting, correction, classification, merging, deduplication, or reordering of Mo’s captured text is part of the MVP.

## Transcript contract

The transcript is hidden in ordinary use. It opens only through a deliberate reveal or citation action and never opens because a new event arrives.

Both simulation and live capture normalize finalized speaker turns into one internal contract with stable turn ID, speaker ID/label, text, start/end time relative to session start, receipt time, and optional provider event ID. Interim captions are not canonical attachment targets.

Commands snapshot the latest finalized turn known at submission time plus a bounded preceding window. Before the first finalized turn, the anchor is explicitly `null`; the mark is still timestamped. Contextual Revisit and Question results and Marty answers cite validated existing turn IDs, never model-invented display timestamps. References survive reload and export.

## Continuous work versus intelligence

Continuous in the finished MVP:

1. operator-authorized recording at the selected provider;
2. speaker-attributed transcription;
3. local persistence of finalized transcript events.

Never continuous:

- LLM reasoning;
- topic completion;
- claim or confidence classification;
- proactive suggestions;
- Revisit creation or resolution.

## Standalone application lifecycle

Closing the macOS window and choosing **Quit Convo Caddy** use the same guarded
shutdown path. If an interview is active, finalizing, or needs recovery, the
app explains the risk and keeps running by default. Once Mo authorizes Quit—or
when no interview risk exists—the app attempts to close its owned local
resources within five seconds and then exits. Cleanup failures are recorded but
must not trap the application open. This path never stops, restarts, reloads,
or otherwise cycles Hermes.

## Full MVP build

The source-builder path is `bash scripts/build-from-source.sh`: it validates the pinned arm64/macOS 14, Node 24, pnpm 11.19.0, Git, Xcode Command Line Tools/Swift, and disk-space contract before locked installation and local ad-hoc packaging. Release preparation is a distinct strict mode built from a clean reviewed public HEAD descended from an explicitly approved root. It refuses missing or mismatched Developer ID/team/notary inputs and produces a privacy-bounded public manifest. The machinery is source capability only: Apple access, notarization, real-machine acceptance, destination/version approval, and publication remain G1–G4.

The install/uninstall acceptance command is
`pnpm verify:install-uninstall:mac`. Its ordinary mode orchestrates the real
Swift safety suite, native lifecycle-lock process tests, and isolated packaged
runtime against synthetic temporary state and fake Keychain/process ports, then
binds the receipt to the source commit and artifact hashes. It never converts
those source/package checks into a human, Gatekeeper, Keychain, or release claim.
Real-machine mode is scope-review only until G3: it requires a file-bound exact
scope and fresh literal confirmation, rejects the home directory as a recursive
target, and does not infer consent from environment variables.

## Explicitly not in the MVP

Do not build:

- periodic, event-triggered, or background model analysis;
- automatic topic completion or Revisit/Question resolution;
- claim-state, truth, confidence, credibility, emotion, or root-cause scoring;
- proactive whispers;
- participant-facing AI;
- more than one capture integration;
- Chrome audio fallback unless separately selected after a failed provider decision;
- calendar auto-join;
- accounts, teams, roles, authentication, or multi-user synchronization;
- production deployment or cloud database;
- mobile support;
- prep libraries, generalized imports, generated prep, or CRUD beyond creating/editing one selected prep;
- RAG, embeddings, vector storage, transcript summarization, or semantic indexing;
- recording download/storage;
- analytics or telemetry;
- cross-project synthesis, task integration, or cloud-folder writes;
- direct writes outside Convo Caddy's approved local data authorities: an
  explicitly injected temporary/gitignored private-state root for development/tests,
  private Application Support state, and the user-selected workspace for prep and
  completed records.

These may be noted as later possibilities, but roadmap prose is not authorization.

## Success criterion

After a realistic practice interview, Mo should be able to say:

> “I mostly listened. I always knew what still mattered. When something interesting appeared—or a new question occurred to me—I could preserve it in seconds. And when I needed help, Marty already knew the conversation.”

Observable proof also requires no unrequested model calls, correct transcript references, restart-safe state, valid export, hidden transcript during ordinary use, and literal Notes that do not wait for inference.

### Compact olive banner

The olive live-preparation banner retains its historical two-row right side: automatic local preservation above elapsed time and capture status. Aggregate connection readiness does not add a third banner row. Nonhealthy readiness (configuration required, starting, assistant unavailable or needs attention), diagnostics and explicit retry remain in the existing below-banner recovery area, with shared typography and button styling. Healthy readiness alone creates no redundant card. Capture authorization, notice/errors and simulation controls stay in their established header positions. This presentation change does not alter connection setup, gating or retry behavior.

## Connection storage and assistant boundary

Current connection settings are strict schema v4 in owner-private
`config/connections.json`. Generation-scoped secrets use macOS Keychain service
`com.frameyard.convocaddy`. Existing `legacyMigration` metadata is inert and
preserved; settings versions 1–3 are rejected without rewriting. Startup neither
reads nor changes leftover `.env` or `.env.retired` files. Fresh initialization
creates no plaintext credentials and writes no Keychain items. Save journals a
candidate, writes and verifies its secrets, switches authority atomically, then
cleans pending generations. Interrupted pre-switch candidates are discarded;
post-switch recovery retains the new authority. Confirmed uninstall retains its
separate privacy cleanup, including leftover plaintext files.

Hermes is user-owned and already running. Local or strict key-based SSH transport
reaches its loopback API at root or one named profile scope. Model discovery is
authenticated; the user explicitly selects an advertised route. Profile identity,
memory, tools, provider credentials, retries and retention belong to Hermes.
Caddy sends no continuity headers, performs no automatic inference retry, and
never cycles the service. Marty is Mo's custom AI agent built on Hermes;
other users choose their own agent.

Starting Recall capture sends the visible bot to the Teams lobby. Admission
by the interviewer authorizes recording/transcription. On admission, the bot
displays “Convo Caddy is recording and transcribing this conversation.” for ten
seconds, with the same Teams chat notice as best-effort fallback. The application
requests no recording-media retention; provider confirmation and dashboard
metadata retention remain distinct and unverified. No recording is downloaded.
