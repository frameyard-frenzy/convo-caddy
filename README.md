# Convo Caddy

Keep your interview questions and follow-ups beside a Teams call, so you can listen to the person instead of operating software. Convo Caddy transcribes an admitted meeting, keeps your marks and notes, and asks your existing Hermes assistant for help only when you request it.

## For people

### Requirements

- An Apple Silicon Mac with macOS 14 or later.
- Hermes already running and used daily, on this Mac or another Mac you can access.
- Only for two Macs: [Tailscale](docs/hermes-connection-setup.md#1-prepare-before-leaving-the-hermes-mac) installed and connected on both Macs, using the same Tailscale account. The Macs can be in different locations and on different Wi-Fi networks.
- Personal Microsoft Teams; Recall US West and ngrok accounts (create them below if needed).
- An internet connection. Transcription is in English; provider usage may cost money.

### Install

**Download:** [Convo Caddy 0.1.0 — unnotarized alpha](https://github.com/frameyard-frenzy/convo-caddy/releases/tag/v0.1.0) is available for Apple Silicon Macs running macOS 14 or later. Download `Convo-Caddy-0.1.0-arm64.dmg`; checksums and a source manifest are attached to the release. This alpha is ad-hoc signed, **not Developer ID signed or notarized by Apple**, and macOS may block first launch.

On the Mac where you will conduct interviews:

1. Download the Convo Caddy `.dmg` from that Releases page.
2. In Finder → Downloads, double-click the disk image.
3. In its window, drag **Convo Caddy** into **Applications**. Wait for copying to finish, then eject the disk image in Finder's sidebar.
4. Open Finder → **Applications** and double-click **Convo Caddy**. If macOS cannot verify the developer or check the app for malicious software, follow the release page’s per-app **Privacy & Security → Open Anyway** instructions only if you trust this release. Stop on a “will damage your computer” or damaged/altered-download warning. Do not disable Gatekeeper globally. The DMG’s standalone uninstaller is also unnotarized.

Connection settings opens on first launch. You can return to it through **Configuration → Connection Settings…**. Fill its three sections below in order. Keep keys in your password manager and masked app fields, never in chat or screenshots.

### Recall

In your browser, create or select a workspace at [Recall US West](https://us-west-2.recall.ai/auth/signup).

1. Open [Developers → API keys](https://us-west-2.recall.ai/dashboard/developers/api-keys). Copy the workspace API key into Caddy's **Recall → API key**.
2. On the same page, create/copy the **workspace verification secret** into Caddy's **Workspace verification secret**. Use this workspace's secret, not a per-endpoint Svix secret; both can start with `whsec_`.

### ngrok

Create or sign into [ngrok](https://dashboard.ngrok.com/signup).

1. In [Domains](https://dashboard.ngrok.com/domains), copy your assigned stable hostname into Caddy's **ngrok → Stable domain**, without `https://`, a path or port.
2. From [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken), copy the token into **Authtoken**. This is not an ngrok API key.
3. Copy Caddy's displayed **Webhook URL** into a new endpoint in [Recall Webhooks](https://us-west-2.recall.ai/dashboard/webhooks/). It ends in `/api/capture/recall/webhook`. Select these ten events and save the endpoint:

```text
bot.joining_call
bot.in_waiting_room
bot.in_call_not_recording
bot.recording_permission_denied
bot.in_call_recording
bot.call_ended
transcript.done
recording.done
bot.done
bot.fatal
```

Do **not** add `transcript.data`; Caddy attaches it when creating a bot. Caddy runs the tunnel itself, so do not start another ngrok process on that domain.

Click **Test Recall & ngrok** in Caddy. It should report **Connection checks passed**; this checks a synthetic public callback and creates no meeting bot. If it fails, open **Diagnostic details** and follow its action. For callback failures, recheck the hostname, authtoken and whether another tunnel uses the domain; do not stop an unfamiliar process. Use the displayed code to troubleshoot yourself or with an agent. If seeking help, share only the code and button name, never field values. The check does not verify your dashboard event selections or real meeting capture.

### Hermes

You already use Hermes daily; here you connect that assistant to Caddy. Leave Hermes running. Caddy needs its compatible **HTTP API**; daily messaging use alone does not establish that the API is enabled.

In Caddy, set **Where Hermes runs** to **This Mac** or **Another Mac**. Open **Hermes connection setup (Markdown guide)**, then follow [This Mac](docs/hermes-connection-setup.md#this-mac) or [Another Mac](docs/hermes-connection-setup.md#another-mac). The Markdown guide covers the entire Hermes section: preparation, SSH account/address and public-key enrollment when needed, ports/base path, existing API key, **Load models**, model selection and **Test assistant**. Only the human runs secret transfer to the interview Mac's local clipboard.

If you own both Macs, prepare the Hermes Mac first; everything afterward is done from the interview Mac. Already prepared users reuse their existing verified SSH trust and access. The guide checks the existing API without starting or changing Hermes. If it reports `API_ABSENT`, pause assistant setup and request separately approved API configuration. Other unsupported sources or ambiguous listeners have specific stop codes; do not guess a key or restart the service.

After finishing the guide, continue below once. Your unsaved setup entries remain in the form.

### Save and choose a workspace

After configuring **ALL connection fields**—both Recall secrets, ngrok domain and authtoken, Hermes mode, key, path, ports, model and remote SSH address when needed—click **Save**. A Hermes-only form cannot be saved. Settings save to macOS Keychain and the app reloads. **Test assistant succeeded** does not mean Save succeeded: on a failed or unconfirmed Save, keep the draft and follow the displayed action/code rather than resetting the form.

When prompted, choose **Documents** as the workspace parent. Caddy creates **Convo Caddy Workspace** there for your prep and finished conversations. Setup is complete when the workspace opens. You can now [prepare and directly edit an interview](docs/prep-format.md). To relocate all workspace files later, use **Workspace → Move workspace…** ([move and recovery](docs/workspace-move.md)); the [optional practice interview](docs/practice-interview.md) walks through a synthetic prep and a separately authorized Teams capture. Admitting the visible bot authorizes recording/transcription; do so only with everyone's agreement.

### Uninstall

Use the graphical uninstaller to remove Caddy's app, private app data and saved Caddy credentials. Dragging only the app to Trash does not perform that cleanup.

1. If capture is active, end the meeting in Teams or remove the visible bot there, and let Caddy finish saving. Uninstall does not stop a remote recording.
2. Choose **Convo Caddy → Quit Convo Caddy**.
3. In Finder → Downloads, double-click the retained installer DMG (or download it again from the release page). In its **Remove Convo Caddy** area, double-click **Uninstall Convo Caddy**.
4. If a workspace exists, read **“Also delete your workspace?”** and the displayed folder path. **No** is the default: it uninstalls Caddy and keeps your workspace. **Yes** also permanently deletes the entire displayed, verified dedicated workspace folder, never its parent. Both remove the app, private app data and saved Caddy credentials. With no workspace, the confirmation is titled **Uninstall Convo Caddy** with **Uninstall / Cancel**; choose **Uninstall** to remove the app, private app data and saved Caddy credentials. No workspace question is shown. **Cancel** closes this dialog without starting removal.
5. Wait for **Convo Caddy uninstalled**. If kept, the result lists your workspace path. Click **OK**, then eject the disk image in Finder.

Cancel during progress can leave partial removal; items already removed cannot be restored. If removal is blocked or incomplete, keep the message and use [uninstall recovery](docs/install-uninstall-verification.md). Older unverified workspace folders can only be kept; if prompted to preserve an older nested workspace, choose a folder outside app data. Caddy's credential removal does not revoke provider tokens, delete backups or change provider retention. A small, nonsecret lifecycle lock remains for safe coordination.

## For agents

Use the same installer-first [Install](#install) and configuration sequence. Use the published unnotarized alpha and its explicit trust warning; leave macOS security confirmation to the human. A public download is not permission to install or override protections automatically. Source work is a separate [build-from-source path](docs/build-from-source.md), with [optional source installation and upgrade recovery](docs/source-install-and-upgrade.md).

The human handles account access, SSH trust/enrollment, masked secret entry, macOS prompts and real provider/capture consent. Never request credentials in chat, inspect the clipboard or read secrets back from the app. Use the [Hermes owner contract](docs/hermes-owner-handoff.md) for complete metadata-only sequences **from the interview laptop**, for either local or remote Hermes. Only the human runs the bundled guide's secret transfer. Do not install, start, stop, restart, or replace Hermes or shared services to complete setup.

For [Uninstall](#uninstall), obtain explicit removal permission for the app/private data/credentials and the displayed workspace choice. Guide the same graphical steps; **No** keeps the workspace, **Yes** additionally deletes the verified whole folder, and **Cancel** before removal changes nothing. Installation authority is not uninstall authority. Never interpret No as cancelling uninstall or automate Yes. Report partial removal truthfully and hand blocked cases to [recovery](docs/install-uninstall-verification.md), without broad filesystem or Keychain cleanup.

Report only action names, allowlisted diagnostic codes and what was verified or human-confirmed. Installation, saved configuration and separately authorized practice are distinct outcomes; do not claim live acceptance from tests. [Behavior and privacy](docs/behavior-and-privacy.md), [installer acceptance](docs/installer-acceptance.md), and [release preparation](docs/releasing.md) retain the technical and acceptance details.

Source contributors should read [AGENTS.md](AGENTS.md) and the tracked
[collaboration guide](.collab/README.md). [Source validation](docs/build-from-source.md#contributor-command-matrix)
is separate from packaging, installed acceptance and publication.

Convo Caddy is a Frameyard project, copyright © 2026 Linn Autoracing Excellence LLC, licensed under the [MIT License](LICENSE). See [SECURITY.md](SECURITY.md), [NOTICE.md](NOTICE.md), and [font notices](public/FONT-LICENSES.txt).
