# Source installation and upgrade recovery

This optional contributor/review path preserves the guarded source-build and upgrade procedure. It is not the first-install README recipe. Start with a reviewed source branch; these steps require separate permission for any actual tool installation or app replacement. Step labels are retained for continuity with prior acceptance evidence.

### 3. Check the build Mac

**Interview Mac:** open **Apple menu → About This Mac** and confirm an Apple chip and macOS 14 or later. Open **System Settings → General → Storage** and free at least 8 GiB for the build. Open **Terminal** from Applications → Utilities; use this same window through step 8.

Expected: supported hardware and enough free space. Next: step 4.

### 4. Install Apple's build tools

**Interview Mac, Terminal:** run:

```bash
xcode-select --install
```

Complete Apple's installer. If it says the tools are already installed, continue. Then run:

```bash
swift --version
```

Expected: Swift 6 or later. If older, install the offered **Command Line Tools** update in **System Settings → General → Software Update**, then check again. If none is offered, stop: you need an Apple toolchain with Swift 6 compatible with your macOS; the [build guide](build-from-source.md#toolchain-blockers) gives the official download route. Next: step 5 only after Swift passes.

### 5. Install Node

**Interview Mac, browser:** open [Node downloads](https://nodejs.org/en/download), select **v24**, **macOS**, and the **Installer (.pkg)**. Download and open the package, then finish the installer. If Node 24 is already installed, keep it. In Terminal, check:

```bash
node --version
```

Expected: `v24.` followed by the remaining version numbers. Next: step 6; stop if another version is still selected.

### 6. Install the pinned package manager

**Interview Mac, Terminal:** run this to install pnpm into your own home folder and use it in this Terminal window:

```bash
npm install --global --prefix "$HOME/.local" pnpm@11.19.0
export PATH="$HOME/.local/bin:$PATH"
pnpm --version
```

Expected: `11.19.0`. If installation fails, stop and retain the error; do not use `sudo` to repair an unknown installation. Next: step 7.

### 7. Get the source

**Interview Mac, browser:** on the GitHub page where you are reading this guide, copy the selected branch name from the branch menu above the files. In the command below, replace `YOUR-BRANCH` with that name (normally `main`; for an approved review candidate use its branch). Then run in Terminal:

Before running the block, make sure you want a **new** `Downloads/convo-caddy` folder. If it already exists, choose a different empty parent folder in Finder and replace `$HOME/Downloads` with its full path below. Never reuse an older checkout after a clone error. The checks below reject both existing destinations and symlinks; each action runs only if the preceding action succeeded.

```bash
cd "$HOME/Downloads" &&
test ! -e "convo-caddy" &&
test ! -L "convo-caddy" &&
git clone --branch "YOUR-BRANCH" https://github.com/frameyard-frenzy/convo-caddy.git &&
cd "convo-caddy" &&
printf 'Source ready in this Terminal.
'
```

Expected: **Source ready in this Terminal.** If that message is absent, stop; do not run the build command. If GitHub denies access, obtain repository access from its owner; never put an access token in a command. Next: step 8 only after success.

### 8. Build the installer

**Interview Mac, same Terminal:** run:

```bash
bash scripts/build-from-source.sh
```

Expected: the command finishes successfully and creates the DMG under `out/make/`. This can take several minutes. If it fails, stop at the reported prerequisite/build error; [build details](build-from-source.md) explain the boundary. Do not run the contributor test suite to install. Next: 8b.

### 8b. Finish any active capture

**Interview Mac:** if an older Caddy is capturing a meeting, end that meeting in Meet or Teams and wait for Caddy to finish saving. If no capture is active, continue.

Expected: no active meeting bot or unfinished save. Stop if capture or saving is unresolved. Next: 9a.

### 9a. Quit the older app

**Interview Mac, Convo Caddy:** choose **Convo Caddy → Quit Convo Caddy**. Current source resolves unsaved entries with Save, Discard, or Cancel before quitting. Older installed builds may differ; keep needed edits privately before replacing an older build. If Quit does not close it, stop the upgrade rather than assuming the runtime is still healthy.

Expected: the older app's window closes. If quitting is unresolved, stop. Next: 9b.

### 9b. Open the new installer

**Interview Mac, the Terminal used for this build:** run:

```bash
open "out/make/Convo Caddy-0.2.0-arm64.dmg"
```

Expected: a Finder installer window with Convo Caddy and Applications in its top row. If it does not open, stop at the error. Next: 9c.

### 9c. Replace the installed copy

**Interview Mac, Finder:** drag the top **Convo Caddy** icon into **Applications**. Approve **Replace** if replacing your older app, wait for copying to finish, then eject the installer disk.

Expected: the copy completes without an error. Do not launch from a checkout or mounted disk. Next: 9d.

### 9d. Compare the installed app with this build

**Interview Mac, the same build Terminal:** run this read-only comparison of all bundle file contents:

```bash
diff -qr "out/Convo Caddy-darwin-arm64/Convo Caddy.app" "/Applications/Convo Caddy.app" &&
printf 'Installed app matches this fresh build.
'
```

Expected: **Installed app matches this fresh build.** A difference, missing file or permission error means stop and resolve the copy from 9c; do not launch an older candidate. Keep the build output unchanged until this check completes. This compares the actual build, without relying on a version label or a hardcoded review commit. Next: 9e only after a match.

### 9e. Launch from Applications

**Interview Mac, Terminal:** run:

```bash
open "/Applications/Convo Caddy.app"
```

Expected: Convo Caddy opens. If macOS blocks this locally built app, review that exact app in **System Settings → Privacy & Security**, then try this launch again. Next: 9f.

### 9f. Check the running location and open setup

**Interview Mac, Dock:** Control-click the running Caddy icon → **Options → Show in Finder**. Finder must select the byte-compared copy in **Applications**. In Caddy choose **Configuration → Connection Settings…**.

Expected: Connection settings with Recall, ngrok and Hermes sections. If Finder selected a different location, quit that copy and repeat 9e. Continue with Recall in the README.


Continue with [Recall configuration](../README.md#recall). For ordinary installation use [Install](../README.md#install).
