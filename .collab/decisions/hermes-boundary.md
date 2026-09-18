# Hermes boundary

Use the interviewer's existing Hermes HTTP API through local loopback or strict
key-based SSH forwarding. No direct model SDK, provider credential or fallback
provider belongs in Caddy. Profile scope and model route are independent; normal
profile identity and enabled memory remain Hermes-owned. Caddy's one-request
invariant applies at its authenticated Hermes boundary. Hermes may retry or fall
back internally. No continuity headers attach interview context to another chat.
Do not start, stop, configure or restart Hermes without explicit separate approval.
See the [setup guide](../../docs/hermes-connection-setup.md).
