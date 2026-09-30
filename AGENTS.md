# AGENTS.md

This file governs Codex, Claude Code, Marty, and any other coding agent working in `convo-caddy`.

This is internal team guidance, even when publicly readable. Use **Mo** in team
conversation and **For Mo** handoffs; use **Moritz** in public-facing user and
contributor material. Follow the [audience and conversation rules](.collab/COLLABORATION.md#audience-and-names).

## Mission

Build the smallest live customer-interview companion that lets Mo remain present with the participant rather than operate software.

Convo Caddy keeps prepared questions visible, stores Mo’s explicit marks against transcript moments, and answers on-demand questions from interview context. It is not an autonomous interview analyst.

Before substantive work, read:

1. `README.md`
2. `.collab/COLLABORATION.md`
3. `.collab/PRODUCT_CONTEXT.md`
4. the current explicitly authorized assignment

## Authority and conflict handling

Authority is scope-specific:

1. Mo’s latest explicit direction governs product, scope, external services, and final decisions.
2. This file governs repository safety and collaboration process.
3. `.collab/PRODUCT_CONTEXT.md` is the current repository product contract.
4. The current explicitly authorized assignment governs implementation scope and acceptance.

Do not silently resolve a material conflict. Stop at a reversible boundary and flag it **For Marty** or **For Mo** according to `.collab/COLLABORATION.md`.

## Product invariants

Preserve these unless Mo explicitly changes them:

- One interviewer operates the application; it never conducts interviews autonomously.
- The ordinary live surface is digitally native and nearly hands-off.
- The transcript is hidden by default; incoming turns never open it automatically.
- Prepared Questions is one section with a short **Must** tier and a much longer **More Avenues** tier.
- Mo alone checks prepared items when he judges them addressed.
- Checked Prepared, Revisit, and Questions items fade, remain visible, and can be restored.
- **Revisit** is participant-originated: something already said that Mo wants to return to.
- **Questions** is interviewer-originated: a new question Mo wants to ask later.
- **Notes** contains Mo’s observations and does not create a pending conversation action.
- `/note <text>` preserves Mo’s text and makes no model call.
- `/question <hint>` makes one on-demand model call and, on valid success, appends one contextual Question. The hint directs the question; it is not saved literally.
- `/revisit [hint]` makes one on-demand model call and, on valid success, appends one contextual Revisit item. A supplied hint directs the participant-originated thread; it is not saved literally.
- Ordinary non-command text makes one on-demand Assistant request and does not mutate checklist state.
- Unknown or empty commands fail locally without mutation or model calls.
- No model call occurs because time passes, a transcript event arrives, a checkbox changes, the app starts, or an export runs.
- All real MVP reasoning calls route through the user-selected Hermes profile; Convo Caddy stores no underlying model-provider credential and has no direct model SDK or fallback provider. The call-count invariant is measured at the authenticated Convo Caddy-to-Hermes request boundary; Hermes may retain its normal internal retry and provider-fallback behavior.
- Participant testimony, Mo’s notes, and Marty’s responses remain distinguishable.
- Every transcript-related mark has an interview-relative timestamp and stable transcript reference.
- Starting Recall capture sends the visible bot to the selected Google Meet or personal Teams meeting to await admission. Mo authorizes recording and transcription by admitting it; no spoken phrase or application checkbox is required. On admission, the bot displays “Convo Caddy is recording and transcribing this conversation.” for ten seconds, with the same chat message as a best-effort fallback.
- Normal use must feel like listening to a person, not operating Convo Caddy.

## Phase and scope discipline

Assignments are scope-bounded and gated. **Presence of a later phase is not authorization to implement it.** Implement only the phase explicitly named in the active task and stop after its acceptance criteria pass.

Do not add infrastructure “for later” unless a current acceptance criterion requires it. Words such as “later,” “fallback,” “may,” or “design for” are context, not authorization.

If a criterion appears impossible without a prohibited integration or material scope expansion, stop and report the blocker. Do not reinterpret the MVP.

## Clean-room, privacy, and local-security boundary

This repository must remain startup-owned and synthetic.

Never commit:

- real customer or interview transcripts;
- recordings;
- participant names or confidential notes;
- model/provider credentials;
- `.env` values;
- runtime session bundles or logs containing transcript text.

The MVP server must bind to loopback by default. Secrets stay server-side. Do not log transcript bodies or prompt bodies by default. Add no analytics, telemetry, cloud persistence, or recording download. Only practice calls that Mo explicitly authorizes by admitting the visible bot may be used in the live-capture phase.

## Live Hermes lifecycle boundary

Hermes is a shared live service and Marty may be in the middle of active work. Read-only health, status, configuration, process, and log inspection is allowed when it is relevant and does not expose secrets or unrelated conversation content.

Never stop, restart, reload, kill, replace, or otherwise cycle Hermes or its gateway without Mo's explicit approval for that exact lifecycle action in the current conversation. A broad instruction such as “finish the phase,” “configure Hermes,” or “connect Convo Caddy” is not approval. Do not use `--replace`, signals, `launchctl`, or another indirect mechanism to evade this gate.

If a Hermes lifecycle action is required, stop work at the safe boundary, explain why it is blocking progress, ask Mo for approval, and wait. Use wording such as: “I need to shut Hermes down; this is a blocker right now. Can I do it?” A blocking approval question in the UI is also acceptable. Proceed only after Mo answers yes, then use the narrowest graceful action and verify recovery.

## Collaboration rules

Mo owns product direction and final decisions. Marty is the cofounder and coordination/continuity layer. Codex and Claude Code are independent implementation agents. These agents do not share conversations, context windows, local memory, scratch directories, or automatic notifications.

Follow `.collab/COLLABORATION.md` in full.

- Work on an isolated branch or worktree.
- Use `marty/`, `codex/`, or `claude/` branch prefixes.
- Never push directly to `main`.
- Never merge, deploy, change repository settings, create paid resources, or add an external service without Mo’s explicit approval.
- Inspect open PRs, recent commits, and current handoffs before starting.
- One agent owns a file or coherent module at a time.
- Use strict test-first development for product behavior: observe RED, implement minimally, observe GREEN, then refactor.
- Commit coherent checkpoints and keep the worktree clean.
- Phase/PR completion includes cleanup: after the work is merged or otherwise
  safely preserved, remove its obsolete worktree and local/remote feature
  branches. Do not leave numbered phase worktrees or stale agent branches
  behind. Inspect ignored runtime data before any destructive cleanup and keep
  the canonical `convo-caddy` checkout on the current active branch.
- Durable project knowledge belongs in tracked repository surfaces, not tool-local state or chat.

## Handoff standard

Every substantial work block or PR must include:

- **Owner and scope**
- **Goal**
- **Changed**
- **Decisions**
- **Durable knowledge**
- **For Marty**
- **For Mo**
- **Open questions**
- **Verification**
- **Deviations and gaps**
- **Next safe move**
- **Source integrity** — confirm the change contains only authorized source and synthetic fixtures

A handoff is incomplete if lasting project knowledge appears without an identified canonical repository home.
