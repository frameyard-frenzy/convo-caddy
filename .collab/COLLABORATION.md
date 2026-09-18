# Collaboration and Durable Knowledge

## The team

This repository is built by one person and three independent agents:

- **Mo** — founder, product owner, and final decision-maker.
- **Marty** — cofounder agent and coordination/continuity layer.
- **Codex** — independent implementation agent.
- **Claude Code** — independent implementation agent.

The agents do not share context windows, private conversations, local memory, scratch directories, or automatic notifications. Anything that must govern another session or collaborator must be explicit and durable.

## Audience and names

Publicly readable does not mean public-facing. `AGENTS.md`, `CLAUDE.md`, and
`.collab/` guide the internal team: use **Mo**, including **For Mo** handoffs and
**Needs Mo** acknowledgements. Public user/contributor README and docs use
**Moritz**; legal attribution and quoted machine-contract values retain their
specified names. Classify the audience before editing, rather than replacing
names across the repository.

Sanitation removes private facts, not the conversation between Mo, Marty, Codex
and Claude Code. Keep questions, disagreement, feedback, decision routing and
acknowledgement explicit. Never publish private channels, accounts, operational
receipts or confidential context to preserve that conversation.

## Conversation and review loop

1. The owning implementation agent brings findings, questions and disagreements
   to Marty with evidence, the affected scope, and any decision needed from Mo.
   Use **For Mo** directly for the human decisions listed below. Keep unresolved
   issues visible; silence is neither agreement nor approval.
2. Marty reconciles the finding with durable project truth, routes decisions to
   Mo where required, and returns the decision or feedback with its authority
   and canonical location. A recommendation stays a recommendation until approved.
3. The implementation agent acknowledges the feedback, explains agreement or
   remaining disagreement, makes authorized corrections, and hands back the
   exact source identity, verification evidence and unresolved questions. Marty
   acknowledges what was recorded and what still needs Mo or another response.
4. A separate reviewer examines the writer's result. Findings return to the
   owning writer for response and correction; Marty reconciles the review and
   evidence before Mo's decision. Writing a change is not independent review,
   and passing checks is not permission to merge or perform a gated operation.

Use the available, explicitly authorized communication route. A tracked handoff
is a durable record, not proof of delivery or acknowledgement. When no direct
route is available, tell Mo or the coordinating session what remains undelivered.
Do not invent automatic messaging, shared context, or another agent's response.
Preserve one writer's ownership until it is explicitly handed over.

## Canonical repository surfaces

This repository is canonical for Convo Caddy-specific implementation truth:

- `README.md` — purpose, current state, and orientation.
- `AGENTS.md` — repository safety, authority, scope, and collaboration rules.
- `.collab/PRODUCT_CONTEXT.md` — current approved Convo Caddy behavior and boundaries.
- The explicitly authorized assignment — current scope and acceptance; private operational details stay outside this repository.
- `.collab/decisions/` — accepted decisions whose rationale and rejected alternatives matter.
- `.collab/runbooks/` — verified repeatable operational procedures.
- code, tests, schemas, and synthetic fixtures — executable behavior contracts.
- issues and PRs — temporary ownership, review, and handoff coordination.

Private operational assignments and evidence stay outside the checkout. Only sanitized current knowledge belongs here.

Company-wide or cross-project Frameyard knowledge must not be duplicated here as a competing truth source. Flag it **For Marty** so he can reconcile it into the broader Frameyard record. Keep only the Convo Caddy-specific consequence or pointer here.

Tool-local `.codex/`, `.claude/`, `.hermes/`, chat, scratch, and unpushed branches are not durable shared memory.

## Read protocol

Before work, every agent must:

1. Read `AGENTS.md`, `README.md`, `.collab/PRODUCT_CONTEXT.md`, and the explicitly authorized assignment.
2. Inspect open PRs, recent commits, and expected files.
3. Identify task owner, branch, phase, and file/module scope.
4. Check for conflicts with current product truth or an unresolved question.
5. Work on an isolated, correctly prefixed branch or worktree.

## Write and promotion protocol

When work establishes or changes lasting knowledge, update its canonical tracked surface in the same branch and PR. Do not leave a lasting product rule only in a PR body or session summary.

Make provenance visible. Distinguish:

- Mo’s approved decision;
- an observed implementation fact;
- an accepted repository constraint;
- an agent recommendation awaiting approval;
- an unresolved question.

If implementation makes a canonical document false, update it in the same change.

## Closeout and cleanup protocol

A merged, abandoned, or superseded phase is not closed until its temporary Git
state is cleaned up. The finishing agent must:

1. Verify the PR is merged or the work is otherwise safely preserved, and
   confirm there is no open PR or ongoing owner for the branch.
2. Confirm the worktree is clean and inspect ignored local state such as
   `var/`, `.env*`, recordings, exports, build output, and dependencies before
   removing anything.
3. Delete the stale remote feature branch if it still exists, remove the
   obsolete worktree, delete the stale local branch, and prune stale worktree
   and remote-tracking metadata.
4. Leave one canonical visible `convo-caddy` checkout on the current active
   branch. A retained extra worktree must have a current owner and an explicit
   reason in the handoff.

Never remove another agent's active or unverified worktree merely because its
name looks old. When cleanup deletes ignored runtime data, state exactly what
was removed and whether it is recoverable.

## For Marty

Flag Marty explicitly when product truth, architecture, an interface, timeline, cross-agent dependency, plan deviation, contradiction, or broader Frameyard fact needs reconciliation.

Use:

> **For Marty:** `<fact or decision>`. Source: `<Mo direction, PR, file, test, or observed behavior>`. Recorded in `<canonical repo path>` / still needs a canonical home because `<reason>`.

Writing the block does not prove Marty was notified. If no direct route exists, place it prominently in the PR/handoff and tell Mo reconciliation remains pending.

Marty acknowledges one of:

- **Recorded** — canonical path;
- **Already canonical** — existing path;
- **Needs Mo** — precise founder decision;
- **Not durable** — reason it stays task-local.

## For Mo

Go directly to Mo for product meaning, scope, priority, visual/taste calls, external service choice, material cost, credentials, privacy/legal exposure, destructive operations, merges, releases, deployment, repository settings, or changes to approved invariants.

Bring routine implementation mechanics, integration order, documentation drift, scope coordination, and existing-truth reconciliation to Marty first.

## Handoff contract

Every substantial PR or work handoff must include:

- **Owner and scope** — agent, branch, phase/task, and owned files/modules.
- **Goal** — bounded outcome attempted.
- **Changed** — exact files and behavior.
- **Decisions** — decisions made, authority, and rationale.
- **Durable knowledge** — canonical files updated, or `None`.
- **For Marty** — reconciliation items, or `None`.
- **For Mo** — approvals/decisions needed, or `None`.
- **Open questions** — unresolved items, separate from decisions.
- **Verification** — exact checks and results, including observed RED/GREEN evidence for behavior.
- **Deviations and gaps** — what differs, remains broken, or was not built.
- **Next safe move** — one concrete next action.
- **Source integrity** — confirmation that only authorized source and synthetic fixtures changed.

No agent assumes another agent saw a chat. No durable decision lives only in a PR. No recommendation is written as approved policy. No phase expands because the roadmap happens to mention it.
