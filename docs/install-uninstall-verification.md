# Install and uninstall recovery

Start with [README — Install](../README.md#install) or [README — Uninstall](../README.md#uninstall). If removal is blocked or incomplete, keep the message and follow the recovery steps below. Do not run a source acceptance harness to remove your installed app.

## Ordinary installer and removal

Open the verified `Convo Caddy-0.2.0-arm64.dmg`. Drag **Convo Caddy** to
**Applications** in the top row, eject the disk, then launch from Applications.
When removing later, quit normally, reopen the disk, and open **Uninstall Convo
Caddy.app** under **Remove Convo Caddy**. With an existing workspace, the dialog
title is “Also delete your workspace?” with **No / Yes / Cancel**. **No** is the default.
Both No and Yes remove the app, private content, and Caddy credentials. Yes also
permanently deletes the entire verified dedicated workspace shown inline, never
its parent. No keeps an external workspace at its existing path. With no workspace,
the dialog is titled **Uninstall Convo Caddy** with **Uninstall / Cancel**.
**Uninstall** performs the private cleanup without a workspace question,
follow-ups or a picker; **Cancel** starts no removal. There is
no introductory Continue screen or trailing confirmation.

Setup creates a dedicated `Convo Caddy Workspace/` child under
a selected parent such as Documents. It rejects Application Support/private-state
placement and never adopts an existing unrelated child. Selecting a verified
Caddy-created workspace again reuses it without nesting.

There is no Shared/Dedicated questionnaire. The hidden workspace marker must
match the folder’s device and inode before deletion is offered. Older selected
roots are not ownership evidence: keep them during uninstall and review their
external files manually. There is no automatic migration or adoption. Missing or
null workspace preferences still allow complete removal of private support,
including arbitrary unknown private contents. Known nested workspaces require
verified preservation outside the removal root under keep, including case aliases.
An interrupted journal from the removed Shared cleanup flow fails closed and
requires manual recovery review; it is never resumed as whole-folder permission.

Private interview checkpoints never require a backup or an acknowledgment before
uninstall. The producer writes `active-session.json` even at fresh live-ready
startup, before capture. Recognized non-ended Recall state with a bot ID adds a
short nonblocking reminder to check Teams. It is not proof a recording is still
running, and uninstall neither contacts a provider nor stops its recording.
Idle, ended, malformed, and old pointer files alone add no capture warning.
An interrupted **uninstall** journal remains protected and needs fresh consent in
the primary dialog. Previously started workspace preservation still has to finish
safely. This is distinct from mere interview checkpoint presence.

Keeping a workspace does not delete its finished
records on a timer, remove backups, or settle provider retention.

## Manual recovery fallback

Use this procedure only if the graphical uninstaller is unavailable or reports a
blocked/incomplete result. It is also the auditable scope description. Do not
improvise broader Library, process, Keychain, or provider cleanup.

The uninstaller leaves one tiny owner-private `lifecycle.lock` marker under
`~/Library/Application Support/Convo Caddy Control/`. It contains no transcript,
configuration, credential, or bot ID. An incomplete operation may also leave a
metadata-only `operation.json` journal there so a later run can re-inventory and
request fresh approval.

### 1. Finish capture, identify owned processes, and quit

1. End the meeting from Teams (or remove the visible bot there), confirm the bot
   has left, and let Convo Caddy finish saving. Quitting Convo Caddy does not
   remove the meeting bot.
2. Open **Activity Monitor → View → All Processes, Hierarchically**. Identify the
   Convo Caddy process, its helpers, and any child `ssh` process. Record their
   PIDs locally before opening Connection Settings or quitting. Do not assume
   every Electron, Node, SSH, or ngrok process belongs to this app.
3. Note the workspace location from **Workspace → Show Workspace in Finder**, and
   the ngrok hostname plus Hermes mode/local port from **Configuration →
   Connection Settings…**. Opening Connection Settings closes the normal runtime,
   so record PIDs first. Do not copy or expose secrets. If the app cannot open,
   inspect only `workspaceRoot` in
   `~/Library/Application Support/Convo Caddy/config/preferences.json`; do not
   print legacy `.env` contents.
4. Choose **Convo Caddy → Quit Convo Caddy**. Refresh Activity Monitor. The app,
   its helpers, and any SSH child it created must be gone. A reused pre-existing
   SSH tunnel or local Hermes server is not owned by Caddy and must remain
   untouched.

Read-only verification, replacing `12345` with each recorded PID:

```bash
ps -p 12345 -o pid=,ppid=,comm=
lsof -nP -a -p 12345 -iTCP
```

Packaged UI and webhook ports are assigned dynamically; checking only
development ports 4317/4318 is not a shutdown check. A listener on Hermes’s
configured port may remain because Hermes or a pre-existing tunnel owns it. If
Caddy is stuck after capture has ended, select only the verified Caddy process
and try **Quit**, then **Force Quit** as a last resort. Stop if ownership is
uncertain. This source alpha installs no LaunchAgent, LaunchDaemon, or login
item; disable only an independently verified Caddy-specific entry.

### 2. Remove every saved Caddy credential

Current Caddy writes to the default user keychain, normally **login**. Identify
its actual path without reading passwords by running this read-only command:

```bash
security default-keychain -d user
```

In **Keychain Access**, select that exact keychain and **All Items**. If you
deliberately changed the default, it may not be login. Identify any previous
default keychains used while saving Caddy settings as well; inspect those
identified user keychains separately. Do not change the default or perform a
broad search of unrelated iCloud, System, or System Roots keychains.

In each identified keychain, search for `com.frameyard.convocaddy` (not “Convo
Caddy”). Inspect matching item attributes without showing the password and
delete only generic-password entries whose **service** is exactly
`com.frameyard.convocaddy`. A search of login alone cannot prove absence when
Caddy used a different default keychain.

Account names are a role followed by `@` and a generation UUID:

- `recall-api-key@…`
- `recall-webhook-verification-secret@…`
- `ngrok-authtoken@…`
- `hermes-api-key@…`

Remove every credential generation, not just the current settings references.
`v1.0-internal` predates Keychain storage and kept credentials in
`~/Library/Application Support/Convo Caddy/config/.env`; do not open or copy that
file into chat. Removing Caddy’s copy of a token does not revoke it at its
provider.

Repeat the exact-service inspection in every identified Caddy-used keychain
after deleting all generations. Record each inspected keychain and its result,
without passwords. Denied, locked, missing, or incomplete inspection is blocked/unverified,
not proof that credentials are absent. If a previously used default cannot be
identified or inspected, report removal as unverified and stop short of claiming
a complete credential reset.

### 3. Remove the app and its files

Keep saved interviews by default. Review the exact proposed removal paths and
obtain permission for those paths before moving anything to Trash. Workspace
deletion requires separate explicit permission, even for a disposable workspace.

#### Preserve nested workspaces before deletion

1. With capture finished and Caddy-owned processes stopped, identify every
   workspace to retain. Include the configured workspace from step 1 and the
   legacy `~/Library/Application Support/Convo Caddy/workspace/`, if present.
   Check whether any retained workspace is inside a proposed private directory,
   source clone, or other removal ancestor. Do not infer absence from a failed
   access check or rely only on the currently configured workspace.
2. For each nested workspace, choose a new, user-approved destination outside every removal ancestor.
   Resolve the actual source and destination paths, including aliases/symlinks;
   a shortcut pointing back into a removal directory does not preserve data.
   Copy the complete workspace to a new destination without overwriting existing
   files. Include prep, finished conversations, and hidden staging files.
   Leave the original untouched while verifying the copy.
3. Verify source and destination relative paths, file counts, sizes, and file-content hashes
   match, including hidden files. Use a trusted local comparison tool without
   printing interview contents into agent output. Record the verified destination
   and confirm it remains accessible independently of all removal ancestors.
   Stop if preservation or verification fails, access is denied, a path is
   ambiguous, or the copy is incomplete. Do not delete or trash the ancestor.
4. Obtain confirmation that the verified destination is the retained workspace.
   Workspace deletion anywhere else still requires separate explicit permission.
   If the user cannot verify preservation, retain the original and its ancestors
   and report the cleanup as blocked/incomplete.

Only after preservation is verified, use
Finder to move only these exact Caddy items to Trash:

- `/Applications/Convo Caddy.app`, or the actual install location, plus any
  extra copies. Eject the Convo Caddy disk image if it is still mounted.
- `~/Library/Application Support/Convo Caddy/`
- `~/Library/Logs/Convo Caddy/`
- If present: `~/Library/Caches/com.frameyard.convocaddy/`,
  `~/Library/Preferences/com.frameyard.convocaddy.plist`, and
  `~/Library/Saved Application State/com.frameyard.convocaddy.savedState/`
- Only with separate explicit workspace-deletion permission: the entire verified dedicated
  workspace folder. Its parent is never included. Ambiguous older external
  roots remain outside automatic cleanup.
- Optionally, a Caddy source clone after checking for unpushed work. Leave
  shared Node, pnpm, Git, Xcode tools, and their caches alone.

Review the selected items in Trash, then delete those items permanently. This is
ordinary local deletion, not proof of deletion from backups, cloud-sync history,
APFS snapshots, or forensic recovery.

### 4. Remove Caddy-specific external configuration

These are user-controlled dashboard actions, not automatic uninstall effects:

- In [Recall Webhooks](https://us-west-2.recall.ai/dashboard/webhooks/), remove
  only the Caddy endpoint matching
  `https://YOUR-ASSIGNED-HOSTNAME/api/capture/recall/webhook`.
- If retiring Caddy permanently, revoke credentials dedicated solely to it
  through [Recall API keys](https://us-west-2.recall.ai/dashboard/developers/api-keys)
  and [ngrok](https://dashboard.ngrok.com/). Do not rotate a workspace-wide
  verification secret or shared token without checking other consumers.
- Uninstalling Caddy does not uninstall Hermes, stop its gateway, delete its
  profile/memory/session history, revoke its shared API token, or remove Teams.

### 5. Verify removal before reinstalling

- No Caddy app/helper process, Caddy-owned SSH child, local listener, or active
  Caddy ngrok tunnel remains.
- Chosen private settings, logs, disposable workspaces, and copies you meant to
  remove are absent. Unrelated files and services are intact.
- A completed exact-service inspection of every identified Caddy-used keychain
  shows no generic-password entries for `com.frameyard.convocaddy`, including
  older generations. Denied or incomplete checks remain blocked/unverified;
  checking login alone is insufficient when the default was customized.
- Retained workspaces are accessible at their verified destinations outside all
  removed ancestors; failed preservation blocks ancestor deletion.
- The Caddy Recall webhook is removed; provider-retained data is accounted for
  separately.

If old settings reappear on first launch, stop and locate remaining app data
rather than silently continuing. Leave Hermes, reused SSH tunnels, shared
developer tools, and unrelated files/services alone.

An interrupted workspace relocation is a separate recovery boundary. If the uninstaller says **Finish workspace recovery first**, keep both folders, open Caddy to finish recovery, then quit and reopen the uninstaller. It never erases `config/workspace-move.json` while the move is unresolved. See [workspace move and recovery](workspace-move.md).
