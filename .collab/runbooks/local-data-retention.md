# Local data locations and manual legacy cleanup

**Status:** current location record; the former seven-day pruning runbook is retired

Convo Caddy does not automatically delete workspace or legacy private data because of age.

The user-selected workspace is authoritative for current prep and completed conversations:

- `prep/current/` — ordinary user-authored prep;
- `prep/archive/` — exact prep bytes archived at successful completion;
- `finished-conversations/` — atomically published four-file records.

Private operational state remains beneath `~/Library/Application Support/Convo Caddy/`. In addition to settings and Electron state, only `active-session.json` may contain an unfinished current interview. It is removed after deterministic workspace publication succeeds.

Versions before the user-owned workspace change may have left a managed archive beneath `~/Library/Application Support/Convo Caddy/workspace` and delivery metadata beneath `config/export-deliveries.json`. The current application neither reads nor deletes those legacy paths. Do not remove them until the owner has inspected them and deliberately decided whether any records must be retained. No migration tool is part of this MVP.

Recordings remain at Recall under the separately documented provider policy; Convo Caddy does not download them. Runtime logs must not contain transcript or prompt bodies.
