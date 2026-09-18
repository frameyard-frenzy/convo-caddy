# Running Hermes discovery for agents

Use the same canonical `scripts/acquire-hermes.py` shipped as Caddy's `Contents/Resources/acquire-hermes.py`. With no `--copy` flag it returns **metadata only**: verified profile, port and API base path. It never reads a credential file or sends a credential-bearing request in this mode. Do not invoke Hermes CLI discovery: even `config env-path` can load/sanitize env files and newer versions can invoke external secret sources before dispatch.

The human alone runs the bundled guide's `--copy` command on the interview laptop. Agents never capture its result, read the clipboard, inspect fields or run internal `--wire-*` transport flags. The [Hermes connection setup Markdown guide](hermes-connection-setup.md) supplies the complete local and strict-SSH paths, including physical preparation first, laptop-only Python checks and bounded public-key enrollment. Its `enroll-hermes-key.py` resource is human-run only; agent metadata commands below never enroll keys. No service/lifecycle, account, enrollment, install or secret operation is authorized by this reference.

## On the interview laptop

Start from the trusted Applications copy installed through [README — Install](../README.md#install). No checkout, build tools or release manifest are required. The installed package contains a public `acquire-hermes.py` resource and `dist/desktop/build-provenance.json` inside `app.asar`. The latter records `schemaVersion`, `sourceSha` and `sourceClean`; it does not contain a helper hash. The command below reads that exact entry, checks its ASAR integrity hash, and calculates hashes from the actual public bytes. It never launches Caddy or Hermes or reads runtime configuration.

This records the source claimed by the trusted installer, **not independent proof** of installer authenticity. Do not use an untrusted app as the trust anchor. A missing/dirty/malformed manifest or missing helper is a stop, not permission to infer a commit or fetch “latest.”

**Interview laptop, LOCAL Terminal:** exit any interactive Hermes-host shell first. Use the human guide’s installed-helper readiness prerequisite; a branch guide and an older installed app are not the same candidate. Check Python first:

```bash
python3 --version
```

Python 3.8 or later is required. If missing, use the Python prerequisite in the human connection guide before continuing. Export to a new `Caddy-public-helper` folder in Downloads; if that folder already exists, keep it and choose a new empty destination in the second argument below. This writes only public source, public build metadata and checksums.

```bash
# Export public installer resources
python3 -I -S - "/Applications/Convo Caddy.app/Contents/Resources" "$HOME/Downloads/Caddy-public-helper" <<'PY'
import hashlib, json, re, struct, sys
from pathlib import Path
try:
    resources, destination = map(Path, sys.argv[1:])
    def read_public(path, limit):
        if path.is_symlink() or not path.is_file():
            raise ValueError()
        with path.open('rb') as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError()
        return data
    archive = resources / 'app.asar'
    if archive.is_symlink() or not archive.is_file():
        raise ValueError()
    with archive.open('rb') as stream:
        prefix, header_size = struct.unpack('<II', stream.read(8))
        if prefix != 4 or not 8 <= header_size <= 16 * 1024 * 1024:
            raise ValueError()
        raw = stream.read(header_size)
        payload_size, json_size = struct.unpack('<II', raw[:8])
        if len(raw) != header_size or payload_size + 4 != header_size or not 0 < json_size <= header_size - 8:
            raise ValueError()
        entry = json.loads(raw[8:8 + json_size])
        for component in ('dist', 'desktop', 'build-provenance.json'):
            entry = entry['files'][component]
        if entry.get('unpacked') or entry.get('link') or not re.fullmatch(r'[0-9]+', entry['offset']) or not 0 < entry['size'] <= 4096:
            raise ValueError()
        stream.seek(8 + header_size + int(entry['offset']))
        manifest = stream.read(entry['size'])
        if len(manifest) != entry['size'] or entry['integrity']['algorithm'] != 'SHA256' or hashlib.sha256(manifest).hexdigest() != entry['integrity']['hash']:
            raise ValueError()
    provenance = json.loads(manifest)
    if provenance['schemaVersion'] != 1 or provenance['sourceClean'] is not True or not re.fullmatch(r'[0-9a-f]{40}', provenance['sourceSha']):
        raise ValueError()
    helper = read_public(resources / 'acquire-hermes.py', 65536)
    if not helper:
        raise ValueError()
    files = {'acquire-hermes.py': helper, 'build-provenance.json': manifest}
    sums = ''.join(hashlib.sha256(data).hexdigest() + '  ' + name + '\n' for name, data in files.items()).encode()
    destination.mkdir(mode=0o700)
    for name, data in dict(files, SHA256SUMS=sums).items():
        with (destination / name).open('xb') as stream:
            stream.write(data)
    print('Source commit: ' + provenance['sourceSha'])
    print('Transfer checksum SHA256: ' + hashlib.sha256(sums).hexdigest())
    print('Public files: ' + str(destination))
except Exception:
    sys.exit('Public installer resources could not be verified/exported. No helper was executed. Keep any partial folder and report this failure.')
PY
```

Keep the printed **Transfer checksum SHA256** (64 hexadecimal characters). It binds both exported files. Replace `EXPECTED-CHECKSUM-SHA256` below with that printed value, never a checksum recomputed from a received folder. If you chose a different export destination, use that exact path consistently below and when transferring.

**Agent review:** read the exported `acquire-hermes.py` as public text before execution; confirm it is the reviewed metadata/captured-transfer helper described here. The public manifest identifies its installer source commit. No API key, `.env`, process output or other private file belongs in this folder or review.

For **This Mac**, after review, the complete guarded metadata command is:

```bash
# Verify public files and run local laptop metadata
cd "$HOME/Downloads/Caddy-public-helper" &&
printf '%s  %s\n' 'EXPECTED-CHECKSUM-SHA256' 'SHA256SUMS' | shasum -a 256 -c - &&
shasum -a 256 -c SHA256SUMS &&
python3 -I -S ./acquire-hermes.py
```

For **Another Mac**, first complete the human connection guide's host trust, enrollment and noninteractive SSH check. Reuse `HERMES_SSH_TARGET` from step 2 in the same local Terminal tab. If this is a reopened tab or a separate agent shell, repeat that single assignment/readiness block with the verified nonsecret address in this shell first; shell variables do not carry between sessions. Do not create a second host assignment or edit persistent shell configuration. Check remote Python before use:

```bash
/usr/bin/ssh -F none -o BatchMode=yes -o StrictHostKeyChecking=yes "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" 'python3 --version'
```

After Python 3.8 or later is confirmed, use this complete guarded remote metadata command on the **interview laptop**:

```bash
# Verify public files and run remote metadata from laptop
: "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}" &&
cd "$HOME/Downloads/Caddy-public-helper" &&
printf '%s  %s\n' 'EXPECTED-CHECKSUM-SHA256' 'SHA256SUMS' | shasum -a 256 -c - &&
shasum -a 256 -c SHA256SUMS &&
python3 -I -S ./acquire-hermes.py --ssh "${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}"
```

Both commands return verified profile, API port and `/`, or an allowlisted stop code. Any missing file or checksum mismatch prevents execution. The helper itself sends verified source through strict SSH stdin and captures metadata; it installs nothing remotely. Never add `--copy` through an agent tool.

## Supported discovery and exceptional stops

The helper reads standard OS-login `~/.hermes` and named-profile PID/runtime records, validates the owner and process generation using macOS `proc_pidinfo`, and matches loopback listening sockets with `lsof`. It checks unauthenticated health and requires a 401 negative control before any candidate credential is read. In human transfer mode, only the verified profile's literal `.env` API_SERVER_KEY is parsed; authenticated model metadata must accept it, and identity/socket ownership are checked again before copying. No redirects, retries, model requests, process environments, launchd definitions, Hermes imports, external secret-manager execution or file changes are involved. Same-user malicious code is outside this local trust boundary; checks do not claim an atomic kernel-to-HTTP transaction.

Timestamp matching follows the three pinned macOS producers: installed-lineage JSON float epoch seconds are compared to native seconds plus microseconds / 1,000,000; stable/forward JSON integers are compared to `int(round(seconds * 100))` (centiseconds, Python ties-to-even). There is no time-distance tolerance or magnitude-based unit guess. Once matched, the exact native `(seconds, microseconds)` pair is retained for every subsequent identity check, including after each socket scan. A change within the same centisecond still stops acquisition. A persisted rounded record cannot distinguish a pre-existing reuse inside its own rounding bucket; no stronger historical precision is claimed. Unknown encodings or clock-adjusted records that do not match stop as unresolved, without widening the comparison.

Automatic and foreground gateways follow exactly the same path. Unknown/custom homes, absent/old runtime records, stale process generations, multiple API gateways, non-loopback sockets and external/YAML-only secret sources fail closed. `API_ABSENT` means a verified gateway's recorded platforms lack the API, not that a messaging gateway failed. `ENDPOINT_UNRESOLVED` means endpoint verification failed and must not be reworded as proof that the API is disabled. `KEY_SOURCE_UNSUPPORTED` / `KEY_REJECTED` require exceptional private source review; do not turn them into a normal owner-self-loop or a key-rotation instruction.

## Provenance and compatibility

Caddy's protocol/prompt fixtures cover installed lineage `c9edd184069d9cc68c25d7d03db574bca8fe515a`, official `v2026.8.31` (`29112bef099274229cadff79cdff7bf7b99c4b77`), and forward snapshot `693641aa8b4359c602283bdbbc14041e03bc47bc`. The first has no named-profile endpoint proof. See tests/fixtures/hermes-compatibility/manifest.json. “Latest” is not a compatibility promise.

Documentation was checked read-only on macOS 26.5.2, Apple OpenSSH 10.2p1, and installed Hermes source `2494c75006be6d4e669b86c62c993832ae26226c`: ssh/ssh-add/ssh-keygen manual pages; hermes_cli/main.py profile selection and config command parser; hermes_cli/config.py env-path/set handling; gateway/config.py YAML loading and environment precedence. This command-source inspection does not extend the protocol compatibility matrix or claim live service/Finder proof.

Official references (checked 2026-09-10):

- [Tailscale macOS installation](https://tailscale.com/kb/1016/install-mac)
- [MagicDNS](https://tailscale.com/kb/1081/magicdns)
- [Tailscale SSH distinctions](https://tailscale.com/kb/1193/tailscale-ssh)
- [Apple Remote Login](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac)
- [Hermes API listener configuration](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/open-webui/) — underlying listener facts only; its Open WebUI installation and URL convention are not Caddy instructions.

## Separately authorized listener configuration reference

If enabling a previously disabled API is separately authorized, the tested CLI supports these **nonsecret** settings (substitute the actual listener-owner PROFILE, including `default`):

```bash
hermes --profile PROFILE config set platforms.api_server.enabled true
hermes --profile PROFILE config set platforms.api_server.extra.host 127.0.0.1
```

These are the working CLI equivalents of `API_SERVER_ENABLED=true` and `API_SERVER_HOST=127.0.0.1`. Do not use `hermes config set API_SERVER_ENABLED true`: the inspected CLI writes an inert uppercase YAML key instead of the environment setting. In the listener's secret file, the owner must reconcile existing API_SERVER_ENABLED/HOST/PORT values with the intended loopback configuration; API_SERVER_HOST/PORT environment values override YAML. API_SERVER_ENABLED is enable-only: a truthy value or a nonempty API_SERVER_KEY enables the API; false does not disable an already YAML-enabled API. Inherited service environment may also override the file. Verify the actual listener with the owner rather than assuming an editor change is active.
