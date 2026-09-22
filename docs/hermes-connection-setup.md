# Hermes connection setup

This Markdown guide covers every field in Caddy's Hermes section. Jump to [This Mac](#this-mac) or [Another Mac](#another-mac), matching **Where Hermes runs**. Follow only your topology, then **Finish the Hermes section** below. You already use Hermes daily; leave it running. The helper discovers its existing compatible HTTP API without needing startup history, a profile name, port or key-file path.

Complete Recall and ngrok first, including their dashboard webhook/events and **Test Recall & ngrok**, as described in README. Use the Caddy copy in **Applications** from README — Install. The matching installer includes the readable Python helpers used here. Run helper commands in the interview Mac's **LOCAL Terminal**, not inside an interactive SSH session on the Hermes Mac. If the prompt shows the remote Mac (for example, your Mini), type `exit` to return to the laptop before continuing.

### If the public callback check warns or fails

Read the four component results in order and use **Copy the secret-free diagnostic summary for your agent**. A red failure opens details and must be resolved first. If Recall authentication, the local callback and exact ngrok endpoint passed but a known attempted public probe failed, the amber warning means this Mac's route is unverified—not that Recall delivery is known to fail. Keep the entered keys, authtoken and domain while investigating. Wi-Fi/ISP filtering, DNS/TLS, VPN/proxy or firewall policy are possibilities; a real ngrok routing, redirect or access-policy problem is also possible. Check network-security history and compare once on another trusted network; on a managed network, give the secret-free summary to its administrator. Certificate failures require checking the Mac’s clock and certificate policy, never bypassing certificate verification. Before relying on a warning setup, complete one human-operated private Teams practice call and verify actual transcript text in Caddy. Do not proceed while a prerequisite is red. Do not disable protection globally, dump credentials, reset credentials, or retry until green.

This Mac-to-public-tunnel-to-local-listener check does not prove Recall delivery, dashboard event selections, that the entered signing secret matches the workspace, or provider retention. Caddy closes the temporary tunnel after the check, so a later offline HTTP result is different from a failure during the app test. Node, curl and Caddy’s Electron runtime may report different symptoms; ordinary onboarding does not require those developer tools. The check is advisory to Save and does not relax live-capture startup checks.

If Connection Settings shows older wording and no **Copy the secret-free diagnostic summary for your agent** action after an error, identify that as an older running Caddy copy. Preserve its draft, do not reset credentials or delete app data, and use its installed guidance until a separately approved matching update is available.

**Review-candidate note:** the older DMG built from `0b746cc` predates `enroll-hermes-key.py`; no PR #45 package exists yet. Reading this branch's guide does not update your installed app. If its helpers are missing, stop and wait for the matching candidate/new installer through a separately authorized installation. Do not inject scripts into the app's resources or modify a signed app. Step 2 checks installed helper readiness before remote setup.

Only the human runs credential transfer; never put credentials in chat, screenshots or agent output. Opening or closing this guide preserves your unsaved form.

Caddy never accepts SSH host keys, passwords, or shell commands and does not edit or restart Hermes.

## This Mac

### L1. Check Python before using it

**Interview Mac, Terminal:** run:

```bash
python3 --version
```

Expected: Python 3.8 or later. If missing or older, install the signed macOS Python 3 installer from https://www.python.org/downloads/macos/, open a new Terminal tab and check again. Next: L2 only after Python works.

### L2. Acquire from your already running Hermes

**Interview Mac, human-run Terminal:** copy and run this complete command. There are no values to replace. In Caddy, click the command box, press Command-A then Command-C.

```command
python3 -I -S "/Applications/Convo Caddy.app/Contents/Resources/acquire-hermes.py" --copy
```

Expected: **Profile**, **API port**, **API base path**, then **Copied to this interview Mac's clipboard**. Write down the nonsecret port and base path. The helper privately verifies the existing **API_SERVER_KEY** before copying it. If a code appears, stop and use **If acquisition stops** below; do not paste an older clipboard value.

**Interview Mac, Caddy:** paste into the masked Hermes **API key** field. Clear the clipboard by copying an ordinary word. Continue at **Finish the Hermes section** below.

## Another Mac

### 1. Prepare before leaving the Hermes Mac

All physical Hermes-Mac preparation is here. After this section you need only the interview Mac, even away from home. **Already prepared** with Tailscale connected and Remote Login allowed? Keep that setup and your existing verified SSH trust; no typing on the physical Hermes Mac is required. Use your saved short account name, or the username in your previously verified SSH address. If you lack a first-ever trusted fingerprint while away, obtain it through an independently trusted channel; stop if unavailable. Never accept an unverified key to continue.

**Connect both Macs to Tailscale.** Already connected to the same authorized private network? Keep that connection. Otherwise, on each Mac:

1. In a browser, open https://tailscale.com/download/mac and choose the standalone macOS download.
2. Open the downloaded installer in Finder → Downloads and follow its installation prompts.
3. Open Tailscale from Applications. Follow its **Open System Settings** prompt to authorize the Tailscale network extension, then allow its VPN configuration when prompted.
4. Click the Tailscale menu bar icon and **Log in**. Complete browser sign-in using the same Tailscale account on both Macs. For a managed network, obtain administrator approval first.
5. Return to Tailscale and connect if disconnected. Expect both Macs connected and listed in that network's Machines page at https://login.tailscale.com/admin/machines.

Tailscale supplies the private network. macOS Remote Login supplies ordinary SSH access over it; these are separate prerequisites. The official installation sequence is https://tailscale.com/kb/1016/install-mac.

**Allow Remote Login and record the account.** On the Hermes Mac, open **System Settings → General → Sharing → Remote Login** (its information button). If already enabled for the intended account, keep it. Otherwise enable it with **Only these users**, selecting the account that runs Hermes. Read the displayed command beginning `ssh `: the text before `@` is the account's short name. For example, `ssh alex@192.168.1.20` gives short name `alex`; the display name “Alex Smith” is not the short name. Record that short name for step 2. Full-disk access is unnecessary. Do not enable Tailscale SSH, Serve, Funnel or public/router ports. A managed network may need permission for interview Mac → Hermes Mac TCP 22. Official Remote Login instructions: https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac.

**First-ever host trust only.** Before leaving, read the fingerprint directly on the Hermes Mac, or obtain it through an independently trusted channel:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Keep the nonsecret SHA256 fingerprint with your short account name. If the file is absent, stop; do not generate host keys. An already verified SSH connection needs no new fingerprint collection. Never delete known_hosts or trust blind ssh-keyscan output.

**Python and availability.** The remote steps require Python 3.8 or later in the SSH shell. Hermes users commonly already have it. If it is not installed, acquire the signed macOS Python 3 installer from https://www.python.org/downloads/macos/ during this preparation. Its availability will be checked remotely in step 3; there is no later physical Terminal check. Keep this Mac powered, awake, connected and logged in with the existing Hermes running. Ensure you can authenticate by an existing SSH key or this Mac account's password. If neither works, arrange independently authorized remote assistance before leaving; do not enable password authentication as a workaround.

Preparation ends here. Every remaining command runs on the interview Mac.

### 2. Set your remote address and verify trusted login

**Interview Mac, Tailscale app:** open the app, select the Hermes Mac and copy its Tailscale IPv4 address. In the assignment below only, replace `shortname` with the exact short name recorded above (or from your already verified SSH login), and replace `100.101.102.103` with that IPv4 address. For example, account `alex` and address `100.90.80.70` become `alex@100.90.80.70`; do not type the example values literally.

**Interview Mac, LOCAL Terminal:** set the nonsecret address once. Keep the **same local Terminal tab** for the rest of this guide and the linked agent sequence. This variable lasts only in that shell session; it changes no persistent shell configuration. If you close/reopen the tab or start another shell, repeat this block with your address before continuing. If inside an interactive host shell, type `exit` first.

```bash
unset HERMES_SSH_TARGET
if [ -n "${SSH_CONNECTION-}${SSH_TTY-}" ]; then
  printf '%s\n' 'STOP: exit the remote shell and use the interview Mac local Terminal.'
  false
elif [ ! -r "/Applications/Convo Caddy.app/Contents/Resources/acquire-hermes.py" ] || [ ! -r "/Applications/Convo Caddy.app/Contents/Resources/enroll-hermes-key.py" ]; then
  printf '%s\n' 'STOP: this app is missing setup helpers. Wait for the matching installer; do not copy scripts into the app.'
  false
else
  HERMES_SSH_TARGET='shortname@100.101.102.103'
  printf 'Ready for remote setup: %s\n' "$HERMES_SSH_TARGET"
fi
```

Expected: **Ready for remote setup** and your account/address. STOP leaves the target unset; do not continue until its stated prerequisite is met. The file check establishes helper availability, not installer authenticity; use only your trusted matching installer. All subsequent remote commands can be copied unchanged. The quoted guards below stop before dispatch if the variable is missing or empty.

**Interview Mac, Terminal, already trusted host:** reuse your existing verified trust:

```bash
/usr/bin/ssh -F none -o StrictHostKeyChecking=yes "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" true
```

**First-ever connection only:** use this command instead, comparing its fingerprint with the independently obtained preparation fingerprint **before typing yes**:

```bash
/usr/bin/ssh -F none -o StrictHostKeyChecking=ask -o HostKeyAlgorithms=ssh-ed25519 "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" true
```

Stop on a mismatch or changed-key warning. If trusted evidence is unavailable while away, pause setup and obtain it through an independently trusted channel. No insecure bypass is part of this recipe.

If asked, type the **Hermes Mac account password** in Terminal. This is not your Tailscale password, SSH key passphrase or Hermes API key. Expected: the command finishes successfully. A password login does not enroll an SSH key or prove Caddy can connect without prompts. If login fails, stop for remote access assistance; do not change server authentication policy.

### 3. Check Python from the interview Mac

**Interview Mac, Terminal:** copy this block unchanged in the same local Terminal tab:

```bash
: "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" &&
python3 --version &&
/usr/bin/ssh -F none -o StrictHostKeyChecking=yes "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" 'python3 --version'
```

Expected: Python 3.8 or later locally and over SSH. If local Python is missing, install the signed macOS Python 3 installer from https://www.python.org/downloads/macos/, reopen Terminal, repeat the step 2 assignment, and check again. If remote Python is missing from the SSH shell, stop for independently authorized remote assistance to make the existing installation available. Do not run a direct-host Python check or restart Hermes. Next: step 4 only after both commands succeed.

### 4. Reuse or create the interview Mac's key

**Interview Mac, Terminal:** check the standard key pair and its directory without reading private contents:

```bash
ls -ld ~/.ssh ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub
```

If both regular files exist, belong to you and their directory is not a symbolic link or writable by other users, reuse them. If only one exists, a path is a link, or ownership/permissions are uncertain, stop for remote technical assistance. Never overwrite a private key. Only if neither key file exists and the directory is safe (or also absent), run:

```bash
(umask 077; mkdir -p ~/.ssh && ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C 'Convo Caddy interview Mac')
```

Choose a strong passphrase. If asked to overwrite anything, answer no and stop. No existing permissions are changed. Next: step 5.

### 5. Enroll only the public half over authenticated SSH

**Interview Mac, human-run LOCAL Terminal:** after step 2 reports ready, copy and run this command unchanged in the same tab:

```bash
python3 -I -S "/Applications/Convo Caddy.app/Contents/Resources/enroll-hermes-key.py" --ssh "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" --public-key "$HOME/.ssh/id_ed25519.pub"
```

Use the Hermes Mac account password if requested. The helper sends only the public `.pub` line over your already trusted SSH connection. It appends to that login account's authorization file, preserves existing entries and permissions, adds a missing newline, and leaves the same key unchanged on repetition. Missing paths are created privately. It never transfers the private key, installs a remote helper or changes Hermes.

Expected: **ENROLLED** or **ALREADY_ENROLLED** within 60 seconds. **UNSAFE_PATH**, **KEY_FILE_TOO_LARGE**, **INVALID_PUBLIC_KEY** or **EXISTING_RESTRICTED_KEY** means stop for remote technical review; do not overwrite files or loosen permissions. Existing symlinks, foreign ownership, group/world-writable paths, hardlinks and nonregular files are refused. A restricted key is not upgraded silently. **ENROLLMENT_FAILED** or **ENROLLMENT_INCOMPLETE** means the result is unconfirmed; check the failed prerequisite and retry the same idempotent command after resolving it. No secrets appear in output.

### 6. Unlock and prove noninteractive login

**Interview Mac, Terminal:** with your permission to store this key's passphrase in your own macOS Keychain, run:

```bash
: "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" &&
/usr/bin/ssh-add --apple-use-keychain ~/.ssh/id_ed25519 &&
/usr/bin/ssh-add -l &&
/usr/bin/ssh -F none -o BatchMode=yes -o StrictHostKeyChecking=yes "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" true
```

Expected: the last command finishes **without any password, passphrase or trust prompt**. If it fails, resolve the specific prerequisite remotely; do not strip the passphrase. Use the macOS login-session agent, not a new terminal-only `ssh-agent`. Finder agent availability remains a real-machine acceptance check in Caddy.

### 7. Acquire from the already running Hermes

**Interview Mac, human-run LOCAL Terminal:** run this complete command unchanged in the same tab. In Caddy, click the command box, press Command-A then Command-C.

```command
python3 -I -S "/Applications/Convo Caddy.app/Contents/Resources/acquire-hermes.py" --ssh "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" --copy
```

Expected: **Profile**, **API port**, **API base path**, then **Copied to this interview Mac's clipboard**. Record the nonsecret port and base path. The existing **API_SERVER_KEY** travels through captured strict SSH to the **interview Mac's local clipboard**. Nothing is installed on the Hermes Mac and its clipboard is not used. No key is printed. If a code appears, stop and use **If acquisition stops** below; do not paste an older clipboard value.

**Interview Mac, Caddy:** paste into the masked Hermes **API key** field, then clear the clipboard by copying an ordinary word. Continue at **Finish the Hermes section** below.

## Finish the Hermes section

**Interview Mac, Caddy:** fill the remaining fields for your selected topology:

- **This Mac:** select **This Mac** and enter the acquired API port in **Local port**. No SSH address is needed.
- **Another Mac:** select **Another Mac**, enter the account/address printed by step 2 in **Mac address (SSH)** (the value, not the variable name), and the acquired API port in **Remote port**. Leave **Local port** at `8642` unless occupied; choose another free port without stopping its occupant.
- **API base path:** enter the acquired base path, normally `/`. Root `/` with model `assistant` does not imply `/p/assistant`; use a multiplex path only with verified listener support, never append `/v1`.
- **API key:** the masked field contains the key you just pasted; never send it to an agent.

Click **Load models**, expect **Connected — models loaded**, then select your everyday Hermes from **Model**. A profile is a named Hermes configuration; it can differ from the advertised model name. If choices are unclear, stop for selection guidance instead of guessing. For Another Mac, model loading also checks SSH access from the graphical app.

Only if you authorize possible provider cost and Hermes/provider retention, click **Test assistant**. It sends synthetic text through the selected Hermes with its normal memory, context and tools. Metadata loading alone is not inference. If consent is declined, assistant acceptance remains deferred. Each deliberate retry can make another request.

For failures use **Diagnostic details** and follow the displayed action/code. Keep the draft; do not reset the form or restart Hermes. In the saved runtime, **Retry connection** affects only Caddy's connection and never replays an assistant request. Finder access and off-LAN reachability remain real-machine acceptance checks.

When the Hermes fields and checks are complete, return to **README — Save and choose a workspace**. This is the single return point for either topology, whether you opened this Markdown guide from README or Caddy. That section saves **ALL connection fields** once and then chooses the workspace. There is no separate Save in this guide.

## If acquisition stops

**API_ABSENT:** Hermes is running but its recorded platforms have no HTTP API. Stop assistant setup and request a separately approved compatible API configuration. Do not enable it, restart Hermes or create a key as part of this recipe.

**IDENTITY_UNRESOLVED / ENDPOINT_UNRESOLVED / AMBIGUOUS:** the helper cannot establish one current, compatible loopback API owned by the login account. Check that you selected the Mac and account you use for Hermes. If still unresolved, pause acquisition. You or an agent can use this code for a source-only compatibility review; do not guess ports, profiles or inspect process environments.

**AUTH_REQUIRED / KEY_REJECTED / KEY_SOURCE_UNSUPPORTED:** request private credential-source review from a trusted technical maintainer. Standard `~/.hermes` profiles with one literal `API_SERVER_KEY` entry in the owning profile's `.env` are supported. Multiline, interpolation, escapes, duplicate/empty keys, custom homes, YAML-only or external secret sources are exceptional stops. The helper never loads external secret managers or changes files. A maintainer can resolve the existing value privately and share it through a password manager; never send a key to an agent or rotate it for this step.

**TRANSFER_FAILED:** recheck Python and the strict SSH checkpoint; use the code to identify the failed prerequisite; pause acquisition if it remains unresolved. A missing `acquire-hermes.py` means this installed copy predates the helper: return to README — Install to obtain the intended installer when available; do not reinstall Hermes. If no release is available, wait for the release before continuing.
