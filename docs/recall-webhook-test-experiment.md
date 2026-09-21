# Recall webhook source experiment

This disposable command-line experiment is **offline fixture evidence only**. It
is not shipped setup behavior, provider feasibility proof, or live transcription
verification. No app UI, credential storage, production webhook receiver or
provider settings change is included.

## Run the source proof

Use the repository's pinned Node 24 and frozen-lockfile dependencies:

```sh
node --import tsx scripts/recall-webhook-test-experiment.ts --help
node --import tsx scripts/recall-webhook-test-experiment.ts --synthetic early-callback
node --import tsx scripts/recall-webhook-test-experiment.ts --synthetic response-lost
pnpm exec vitest run tests/desktop/recall-mcp-webhook-client.test.ts tests/desktop/recall-test-receipt.test.ts tests/desktop/recall-webhook-experiment.test.ts
```

Help lists the negative scenarios. Exit 0 means only that the selected synthetic
scenario obtained an attributed fixture receipt and completed local cleanup.
Negative outcomes exit 2. Every report labels its evidence and says live
transcription was not tested. Arguments are never echoed. There is no live mode,
credential prompt, ambient credential lookup or provider send adapter.

The harness runs a fresh loopback listener on an OS-assigned port. It never
attaches to another server. Discovery, send acceptance, signed callbacks and
ngrok ownership are simulated; HTTP receipt verification and local socket
cleanup are real. A callback may precede send acceptance. Sender success alone,
a matching event/time, or possession of a signing secret cannot establish
invocation attribution. The internal `FixtureSendResult.messageId` is a
**fixture port**, not an asserted Recall response field. There is no fabricated
Recall tools/call implementation. Even a successful fixture result says
`synthetic_attributed`, never that Recall actually delivered.

## Current public contract and missing evidence

Inspected official sources on 2026-09-20:

- [Recall MCP](https://docs.recall.ai/docs/docs-mcp): regional HTTPS endpoints,
  scoped bearer keys, webhook tool names and scope-dependent tool visibility.
  The inspected page does not publish the tools' input/output JSON schemas,
  a test invocation-to-signed-message join, or sample retry/drain guarantees.
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
  and [HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports):
  initialize, negotiate version/capabilities, acknowledge initialization, then
  perform discovery. HTTP supports JSON and SSE responses and optional sessions.
- [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools):
  tools/list advertises input schemas and optional output schemas, with pagination.
- [Recall verification](https://docs.recall.ai/docs/authenticating-requests-from-recallai)
  and [Svix manual verification](https://docs.svix.com/receiving/verifying-payloads/how-manual):
  the message ID, timestamp and unmodified body participate in signature verification.
  A valid signature alone does not identify the initiating diagnostic request.

The discovery-only client supports MCP version `2025-06-18`; another negotiated
version fails closed. It sends no tool calls. It requires an explicitly injected
transport and in-memory key; nothing imports it into the application. HTTPS
addresses are fixed to the four documented regional Recall hosts at `/mcp`.
All requests refuse redirects and keep authorization on that exact address.
There is one discovery deadline, at most four pages of 128 tools, a 256 KiB
per-response limit, bounded session/cursor values and a separate one-second
session DELETE bound. It does not retry or reconnect. Unsupported protocol
messages and missing capabilities fail closed. Session termination refusal is
reported as cleanup blocked, not remote-delivery cancellation.

Only the three webhook schemas (`list_webhook_endpoints`,
`send_test_webhook_endpoint`, `list_webhook_deliveries`) are retained from
inspection. Tool descriptions and server instructions are never executed.
Schema objects are untrusted inspection data, not validated invocation contracts;
no argument evaluator or tool execution is implemented. The CLI uses explicitly
fake schemas and prints no remote schema/error/body content. A future live
inspection path needs reviewed secure local input and sanitized schema export.
Create/update/delete, credential retrieval, bots, media and inference are outside
the tool allowlist even if a credential advertises them.

Before any real send, obtain documented answers to all of these:

1. What are the exact regional tools' input/output schemas, including error and
   successful test results? How is the scoped workspace independently confirmed
   with only approved scopes? Can endpoint ID, full URL/path and event be checked
   without changing its configuration?
2. Does the test result return a value that equals the callback's signed message
   ID? If not, does bounded delivery history include test sends and provide an
   unambiguous join to this exact invocation, even when the send response is lost?
   Supply sanitized examples and field semantics, not guessed field names.
3. Which signature header family and secret apply to dashboard test deliveries?
4. How can outstanding real deliveries be proven quiescent **before** starting
   or redirecting an existing-domain tunnel to this non-ingesting receiver?
5. What provider-supported guarantee prevents delayed samples from reaching the
   production receiver after timeout, cancellation, response loss, crash, restart
   or normal service resumption? What are retry, cancellation and drain semantics?

Unknown linkage means inconclusive. Unknown endpoint lifetime means no takeover
and no send. Local handle closure does not cancel provider retries. If the shared
endpoint cannot satisfy those guarantees, propose a separately authorized isolated
endpoint/domain with explicit creation/removal scope and acknowledge that it does
not prove equivalence to the normal route. Do not build automatic recovery or
silently switch endpoints. Invalid-secret controls remain synthetic.

## Architecture and boundaries

Existing setup path: `setup-client.ts` calls the authenticated setup test route;
`setup-runtime.ts` supplies `RecallNgrokConnectionTester`; that tester makes a
read-only REST credential check and local/public synthetic POSTs through
`startNgrokEndpoint`. The renderer currently requires all four results. Field
changes invalidate result generations, and Save/reload has separate authority.
This experiment leaves that whole path unchanged.

New seams:

- `recall-mcp-webhook-client.ts`: generic bounded initialize/tools-list inspection.
- `recall-test-receipt.ts`: non-ingesting HTTP receiver and one fixed-deadline,
  bounded receipt attempt. It reuses the production raw-body HMAC verifier but
  normalizes dashboard `svix-*` and `webhook-*` headers only inside the experiment.
  Duplicate, conflicting or partial alternate families are rejected. Timestamp
  tolerance, a 1 MiB body cap, strict UTF-8 and exact route/method checks remain.
  No SessionService, interview storage, download or model port exists.
- `recall-webhook-experiment.ts`: synthetic orchestration with a mandatory fake
  ngrok adapter through the existing exact-domain ownership manager. Only the
  owned listener/handle are closed; a failed close blocks new attempts in-process.
  Fixture endpoint mismatch prevents sending; no public self-POST is required.
- `scripts/recall-webhook-test-experiment.ts`: help, synthetic scenario selection,
  safe status output and signal cancellation. It accepts no live credentials.

A maximum of 32 receipts is held in memory, with generation, non-secret settings
fingerprint, start/deadline, event, signed ID and receipt time. Raw bodies are not
retained. Timeout/cancellation/settings invalidation freeze an attempt; duplicate
or unrelated receipts cannot complete it twice. There is at most one fixture send
and one active attempt per process. No durable receipt database is created.
A new process has no memory of remote traffic; this is precisely why live
resumption remains gated on provider lifetime evidence.

## Acceptance and limits

Synthetic tests cover S1–S9's source-level receipt, attribution, auth/transport,
invalid-body/header, time, no-resend, overlap and ownership behaviors. Existing
ngrok and real capture regression suites remain the authority for their unchanged
production behavior. Fake authentication and endpoint data cannot prove actual
workspace/region mapping, scopes, provider schemas, test-send correlation, network
reachability, retries or remote quiescence. No browser/UI behavior changes here.

Next step is independent whole-candidate source review. Afterwards, separately
authorized schema discovery/support clarification must resolve the above blockers
before a reviewed live adapter or domain takeover can exist. No merge or release
is implied by passing this source experiment.
