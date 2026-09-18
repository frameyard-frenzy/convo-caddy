# Recall and Teams capture

One visible anonymous Recall bot joins personal Microsoft Teams using US West
and English transcription. The user supplies their own Recall credentials and
stable ngrok domain. A dedicated loopback listener exposes only webhook handling.
Starting capture sends the bot to the lobby; admitting it authorizes recording
and transcription. No phrase or app checkbox grants that permission. The admitted
bot displays the exact notice in the [product contract](../PRODUCT_CONTEXT.md)
for ten seconds and posts the same chat message as best-effort fallback.

Only finalized, deduplicated speaker turns enter the transcript. Events never
trigger model calls or reveal the transcript. Caddy requests no recording-media
retention and does not download recordings. A request is not provider confirmation;
account/dashboard retention remains unverified. Real practice requires separate
human consent; source tests use synthetic fixtures.
