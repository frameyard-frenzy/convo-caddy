# Behavior and privacy

Recall receives admitted-meeting audio and creates transcript events. ngrok carries signed callbacks to Convo Caddy’s dedicated loopback listener. Finished records remain in the chosen workspace until removed. Explicit assistant actions send bounded context to Hermes, which may retain sessions and call its configured provider. Convo Caddy has no analytics, telemetry, cloud persistence, direct model-provider credential, or recording download.

Prepared Questions contains **Must** and **More Avenues**. Checked Prepared, Revisit, and Questions items remain visible and restorable. `/note <text>` is literal and makes no model call. `/question <hint>`, `/revisit [hint]`, and ordinary text each make one on-demand Hermes request; invalid commands fail locally. Participant testimony, interviewer notes, and assistant responses stay distinguishable.
