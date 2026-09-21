# Recall webhook source experiment

This disposable command-line experiment has an offline synthetic proof mode and
a separately selected read-only schema discovery mode. Implemented behavior is
**synthetically tested only** until independently reviewed and run locally by the
operator. It is not shipped setup behavior, provider feasibility proof, or live
transcription verification. No app UI, credential storage, production webhook receiver or
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
transcription was not tested. Arguments are never echoed. Synthetic mode has no
credential prompt or provider transport. Neither mode has ambient credential
lookup or a provider send adapter.

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
no argument evaluator or tool execution is implemented. Synthetic mode uses fake
schemas. Discovery mode emits only sanitized structural schemas through the
secure local entry point described below; it never emits raw error/body content.
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
- `recall-schema-discovery.ts`: non-echo interactive key input, structural schema
  sanitization and exclusive optional export. No provider tool invocation.
- `scripts/recall-webhook-test-experiment.ts`: help, explicit synthetic/discovery
  selection, safe status output and cancellation. Discovery alone accepts a key
  directly from the operator’s terminal after independent source review.

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

## Read-only schema discovery — operator procedure after source review

Do not enter a real key until independent whole-candidate review accepts the
exact checkout. Run this yourself in an ordinary terminal, not an agent tool,
recorded process-input channel or chat. Prerequisites: the reviewed source
checkout, Node 24, and its existing pinned dependencies (including tsx). This
command does not install anything, launch the app or use Hermes configuration.
From the repository root, for a confirmed US West workspace:

```sh
node --import tsx scripts/recall-webhook-test-experiment.ts --discover --region us-west-2 --output recall-webhook-schemas.json
```

Use the confirmed workspace region explicitly: `us-east-1`, `us-west-2`,
`eu-central-1` or `ap-northeast-1`. No region auto-detection or alternative host is
available. Omit `--output` to display sanitized JSON only. With `--output`, choose
a new local filename: existing files and symlinks are never overwritten; new
files use mode 0600 subject to the local filesystem. Do not select a shared or
source-controlled destination. The tool does not save the key. Do not redirect
stdin/stdout/stderr: all three must be terminals. Copy the sanitized JSON or use
the optional file instead.

In the existing Recall workspace dashboard, use **Developers → MCP API Keys**,
**New MCP API Key**, a descriptive temporary-key name and specific permissions.
The [official MCP documentation](https://docs.recall.ai/docs/docs-mcp) documents
`mcp.webhooks.read` for endpoint/delivery visibility. It also says write tools
are hidden without their scope, and associates `send_test_webhook_endpoint`
with `mcp.webhooks.write`. Therefore a read-only scoped key may discover only two
of the three requested definitions and report `tools_missing`. The documented
write scope also authorizes endpoint creation/update: do not add it silently to
make that status green. If all three definitions are needed, explicitly agree
that broader credential capability with the coordinating human first; the CLI
still cannot invoke any of them. Do not grant full read/write, bot, recording,
billing, account or developer/credential scopes for this procedure. Minimum
scope for protocol-only initialize/tools-list itself is not stated by the
inspected docs. Missing tools or 401/403 is a reportable result, not authority to
expand permissions or retry with unrelated keys. MCP keys are distinct from
REST keys and are scoped to their creation workspace; workspace selection here
is operator-confirmed, not verified by a `get_info` call. Key scopes are immutable
per the same docs, so any replacement is a separate deliberate dashboard action.

At `MCP key (hidden):`, type or paste only the temporary MCP key and press Enter.
No characters or asterisks echo. Backspace and Ctrl-U edit the hidden input.
Input is bounded to 4096 printable ASCII bytes and 120 seconds. Ctrl-C, Ctrl-D,
Ctrl-Z or input EOF cancels. Network discovery takes at most five seconds plus
one second for session cleanup. Terminal raw mode remains active without echo
through cleanup; success/error/cancel restore its prior mode and input-flow
state. SIGINT, SIGTERM, SIGHUP and SIGTSTP are handled as cancellation. Forced
SIGKILL, terminal destruction and host shutdown cannot run restoration handlers.
The owner-operated terminal/machine is trusted; this is not memory-zeroization
or protection from another process controlled by the same owner.

Only `initialize`, `notifications/initialized`, paginated `tools/list` and bounded
HTTP session DELETE are possible. Cancellation aborts the active request, retains
a separate cleanup bound and never reconnects. DELETE ends a protocol session;
it does not delete a Recall resource or cancel webhook deliveries. Discovery
never lists endpoint instances/delivery records, sends a webhook, starts a
listener/tunnel, creates a bot or changes account settings.

Output includes state, actually negotiated protocol version (null if not
negotiated), region, cleanup and at most the three named tools. Structural
schema filtering retains property/definition names, nested schemas, types,
required fields, references, scalar enum/const values and common validation
constraints. It omits prose/title/descriptions, defaults, examples, annotations
and unsupported keywords. Object-valued literals or excessive structure fail
closed rather than being guessed. Limits: depth 16, 4000 visited nodes, strings
2048 characters, arrays 256 entries, final JSON 128 KiB. Exact key and session-ID
reflections are removed from decoded retained names/strings; JSON escaping and
ASCII serialization prevent terminal control execution, including Unicode
format controls. No server prose is treated as instructions. References and
patterns are inspection text only, never fetched or evaluated.

Sanitization can remove important semantics or alter names that contain an exact
secret. The output explicitly says `structure_only_not_an_invocation_contract`;
it is not an executable or complete schema. If omitted semantics are needed,
report the limitation for a separately reviewed clarification step. Never infer
fields, send arguments, correlation or retry guarantees from incomplete output.
A sanitization bound/rejection yields `sanitization_rejected` with no schemas.
Exit 0 requires all three definitions and complete cleanup. Other results exit
2; `tools_missing` can still contain useful sanitized definitions. No result
proves webhook delivery, endpoint mapping or remote-delivery lifetime.

Return only the sanitized JSON artifact (or displayed JSON), status/cleanup,
region and reviewed source SHA to the coordinating reviewer. Never return the
key, raw provider responses, headers, terminal recording or a screenshot of key
entry. Review the sanitized structure as data. Keep the temporary key in your
own secure store until you deliberately revoke it when discovery is finished.
No support contact, send, endpoint takeover, product integration, merge or
release is authorized by this command or its output.
