"""Read-only macOS onboarding helper. No Hermes imports or service operations.

Standard OS-login ~/.hermes homes only. Trust boundary: the current OS user and
their existing Hermes installation, not protection against malicious same-user
code. PID generation and socket ownership are rechecked around authentication.
"""
import argparse
import ctypes
import http.client
import json
import math
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import sys


class Stop(Exception):
    pass


def run(argv, **kwargs):
    # Fixed executables / isolated Python; never inherit Python startup hooks.
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'SSH_AUTH_SOCK') if k in os.environ}
    return subprocess.run(argv, env=env, capture_output=True, check=True, timeout=30, **kwargs)


def read_owned(path, code):
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ValueError()
            data = file.read(65537)
            if len(data) > 65536:
                raise ValueError()
            return data.decode('utf-8')
    except (OSError, ValueError):
        raise Stop(code) from None


def directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise Stop('IDENTITY_UNRESOLVED')


class BsdInfo(ctypes.Structure):
    # macOS SDK sys/proc_info.h: struct proc_bsdinfo, PROC_PIDTBSDINFO = 3.
    _fields_ = [(name, ctypes.c_uint32) for name in
                ('flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid',
                 'rgid', 'svuid', 'svgid', 'reserved')]
    _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in
                ('nfiles', 'pgid', 'pjobc', 'tdev', 'tpgid', 'nice')]
    _fields_ += [('seconds', ctypes.c_uint64), ('microseconds', ctypes.c_uint64)]


def process_identity(pid):
    lib = ctypes.CDLL('/usr/lib/libproc.dylib')
    fn = lib.proc_pidinfo
    fn.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    fn.restype = ctypes.c_int
    info = BsdInfo()
    if fn(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info) or info.pid != pid:
        raise Stop('IDENTITY_UNRESOLVED')
    return info.uid, (info.seconds, info.microseconds)


def identity(record, generation=None):
    pid, started = record.get('pid'), record.get('start_time')
    if (record.get('kind') != 'hermes-gateway' or type(pid) is not int or pid <= 0
            or type(started) not in (float, int) or not math.isfinite(started) or started <= 0):
        raise Stop('IDENTITY_UNRESOLVED')
    uid, actual = process_identity(pid)
    # Pinned macOS producers: old float epoch seconds; new integer epoch
    # centiseconds via Python round (ties to even). Never infer units by size.
    seconds = actual[0] + actual[1] / 1000000
    expected = seconds if type(started) is float else int(round(seconds * 100))
    if (uid != os.getuid() or started != expected
            or generation is not None and actual != generation):
        raise Stop('IDENTITY_UNRESOLVED')
    return actual  # Retain native sec/usec exactly, independent of record precision.


def sockets(record, generation, port=None):
    identity(record, generation)
    args = ['/usr/sbin/lsof', '-nP']
    args += ['-a', '-p', str(record['pid']), '-iTCP'] if port is None else ['-iTCP:' + str(port)]
    try:
        output = run(args + ['-sTCP:LISTEN', '-Fpn']).stdout.decode('ascii')
    except subprocess.CalledProcessError as error:
        if error.returncode == 1 and not error.stdout:
            output = ''
        else:
            raise Stop('ENDPOINT_UNRESOLVED') from None
    pids, ports = set(), set()
    for line in output.splitlines():
        if line.startswith('p') and line[1:].isdigit():
            pids.add(int(line[1:]))
        elif line.startswith('n'):
            match = re.fullmatch(r'n127\.0\.0\.1:([0-9]+)', line)
            if not match:
                raise Stop('ENDPOINT_UNRESOLVED')
            ports.add(int(match[1]))
    if pids and pids != {record['pid']}:
        raise Stop('IDENTITY_UNRESOLVED')
    if len(ports) > 8 or any(not 1 <= p <= 65535 for p in ports):
        raise Stop('ENDPOINT_UNRESOLVED')
    if port is not None and (pids != {record['pid']} or ports != {port}):
        raise Stop('IDENTITY_UNRESOLVED')
    identity(record, generation)
    return sorted(ports)


def request(port, route, key=None):
    # Direct loopback connection: no proxy, redirect handling, cookies or retry.
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    def expired(_signal, _frame):
        raise Stop('ENDPOINT_UNRESOLVED')
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, 3)
    try:
        headers = {} if key is None else {'Authorization': 'Bearer ' + key}
        connection.request('GET', route, headers=headers)
        response = connection.getresponse()
        body = response.read(65537)
        if len(body) > 65536 or 300 <= response.status < 400:
            raise Stop('ENDPOINT_UNRESOLVED')
        return response.status, json.loads(body)
    except (OSError, ValueError, http.client.HTTPException):
        raise Stop('ENDPOINT_UNRESOLVED') from None
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
        connection.close()


def key_from(text):
    # Deliberately a single-line literal subset, not a dotenv interpreter.
    if any(ord(c) < 32 and c not in '\n\t' or ord(c) == 127 for c in text):
        raise Stop('KEY_SOURCE_UNSUPPORTED')
    rows = []
    for line in text.split('\n'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        entry = re.fullmatch(r'(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)', line)
        if not entry:
            raise Stop('KEY_SOURCE_UNSUPPORTED')
        name, value = entry.groups()
        if value.startswith(("'", '"')):
            end = value.find(value[0], 1)
            if end < 0 or (value[end + 1:].strip() and not value[end + 1:].strip().startswith('#')):
                raise Stop('KEY_SOURCE_UNSUPPORTED')
            value = value[1:end]
        else:
            value = re.split(r'\s+#', value, maxsplit=1)[0].strip()
            if any(c.isspace() for c in value) or any(c in value for c in "'\""):
                raise Stop('KEY_SOURCE_UNSUPPORTED')
        if any(c in value for c in '\\$') or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise Stop('KEY_SOURCE_UNSUPPORTED')
        if name == 'API_SERVER_KEY':
            rows.append(value)
    if len(rows) != 1 or not rows[0] or len(rows[0]) > 4096 or not rows[0].isascii() or rows[0] != rows[0].strip():
        raise Stop('KEY_SOURCE_UNSUPPORTED')
    return rows[0]


def acquire(root, copy=False):
    directory(root)
    homes = [('default', root)]
    profiles = root / 'profiles'
    if profiles.exists():
        directory(profiles)
        entries = sorted(profiles.iterdir())
        if len(entries) > 32:
            raise Stop('AMBIGUOUS')
        homes += [(p.name, p) for p in entries if re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', p.name)]
    gateways, candidates = 0, []
    for name, home in homes:
        directory(home)
        if not (home / 'gateway.pid').exists():
            continue
        record = json.loads(read_owned(home / 'gateway.pid', 'IDENTITY_UNRESOLVED'))
        state = json.loads(read_owned(home / 'gateway_state.json', 'IDENTITY_UNRESOLVED'))
        generation = identity(record)
        if state.get('pid') != record['pid'] or state.get('start_time') != record['start_time']:
            raise Stop('IDENTITY_UNRESOLVED')
        gateways += 1
        if state.get('gateway_state') != 'running':
            raise Stop('ENDPOINT_UNRESOLVED')
        platforms = state.get('platforms')
        if not isinstance(platforms, dict):
            raise Stop('ENDPOINT_UNRESOLVED')
        api = platforms.get('api_server')
        if api is None:
            continue
        if not isinstance(api, dict) or api.get('state') != 'connected':
            raise Stop('ENDPOINT_UNRESOLVED')
        candidates.append((name, home, record, generation))
    if not candidates:
        raise Stop('API_ABSENT' if gateways else 'IDENTITY_UNRESOLVED')
    if len(candidates) != 1:
        raise Stop('AMBIGUOUS')
    name, home, record, generation = candidates[0]
    ports = []
    for port in sockets(record, generation):
        sockets(record, generation, port)
        try:
            status, health = request(port, '/health')
        except Stop as error:
            if str(error) != 'ENDPOINT_UNRESOLVED':
                raise
            continue  # Another same-gateway listener may not serve HTTP health.
        if status == 200 and isinstance(health, dict) and health.get('platform') == 'hermes-agent' and health.get('status') == 'ok':
            ports.append(port)
    if len(ports) != 1:
        raise Stop('AMBIGUOUS' if len(ports) > 1 else 'ENDPOINT_UNRESOLVED')
    port = ports[0]
    sockets(record, generation, port)
    status, _ = request(port, '/v1/models')
    if status != 401:
        raise Stop('AUTH_REQUIRED')
    result = dict(profile=name, port=port, basePath='/')
    if copy:
        key = key_from(read_owned(home / '.env', 'KEY_SOURCE_UNSUPPORTED'))
        sockets(record, generation, port)
        status, models = request(port, '/v1/models', key)
        if status != 200 or not isinstance(models, dict) or models.get('object') != 'list' or not models.get('data'):
            raise Stop('KEY_REJECTED')
        sockets(record, generation, port)
        result['key'] = key
    return result


def client(host, copy):
    try:
        mode = '--wire-copy' if copy else '--wire-metadata'
        command = [sys.executable, '-I', '-S', '-', mode]
        if host is not None:
            if not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*', host):
                raise Stop('TRANSFER_FAILED')
            command = ['/usr/bin/ssh', '-T', '-F', 'none', '-o', 'BatchMode=yes',
                       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
                       '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
                       host, 'python3 -I -S - ' + mode]
        reply = run(command, input=Path(__file__).read_bytes()).stdout
        if len(reply) > 8192:
            raise ValueError()
        result = json.loads(reply)
        if set(result) == {'error'} and result['error'] in MESSAGES:
            raise Stop(result['error'])
        if set(result) != ({'profile', 'port', 'basePath', 'key'} if copy else {'profile', 'port', 'basePath'}):
            raise ValueError()
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', result['profile']) or type(result['port']) is not int or not 1 <= result['port'] <= 65535 or result['basePath'] != '/':
            raise ValueError()
        if copy:
            key = result.pop('key')
            if not isinstance(key, str) or not key or len(key) > 4096 or not key.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in key):
                raise ValueError()
            run(['/usr/bin/pbcopy'], input=key.encode())
        return result
    except Stop:
        raise
    except Exception:
        raise Stop('TRANSFER_FAILED') from None


MESSAGES = {
    'API_ABSENT': 'Hermes is running, but its recorded platforms have no HTTP API. Stop Caddy assistant setup; request a separately approved compatible HTTP API configuration. Do not restart or enable it here.',
    'IDENTITY_UNRESOLVED': 'Could not verify a current gateway owned by this Mac login in its standard .hermes folder. Check that this is the account that uses Hermes; otherwise report this code for setup review. No key was copied.',
    'ENDPOINT_UNRESOLVED': 'Gateway found, but its compatible loopback HTTP endpoint could not be verified. Report this code for setup review; do not guess a port or restart Hermes.',
    'AMBIGUOUS': 'More than one gateway/API candidate or too many candidates. Report this code for selection guidance; no key was copied.',
    'AUTH_REQUIRED': 'The API did not require bearer authentication as expected. Request a separately approved API configuration review; no key was read or copied.',
    'KEY_SOURCE_UNSUPPORTED': 'The verified gateway has no supported literal API_SERVER_KEY file entry. Multiline/interpolation/escapes and custom or external sources are unsupported. Have a trusted technical maintainer resolve the existing value privately and share it through a password manager; never put it in chat or create/rotate a key for this step.',
    'KEY_REJECTED': 'The existing file value did not authenticate to the verified API. Request private credential-source review; do not rotate a key or retry different profiles.',
    'TRANSFER_FAILED': 'Transfer or clipboard failed. Check Python availability and the strict SSH checkpoint. Do not paste an older clipboard value. Report only this code if unresolved.',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh', metavar='USER@HOST')
    parser.add_argument('--copy', action='store_true', help='Human only: copy verified key to this Mac clipboard')
    parser.add_argument('--wire-copy', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--wire-metadata', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    wire = args.wire_copy or args.wire_metadata
    try:
        if sys.platform != 'darwin':
            raise Stop('IDENTITY_UNRESOLVED')
        if wire:
            # Internal captured transport only, never a Terminal key export.
            if not all(stat.S_ISFIFO(os.fstat(fd).st_mode) or stat.S_ISSOCK(os.fstat(fd).st_mode) for fd in (0, 1)):
                raise Stop('TRANSFER_FAILED')
            root = Path(pwd.getpwuid(os.getuid()).pw_dir) / '.hermes'
            result = acquire(root, args.wire_copy)
        else:
            result = client(args.ssh, args.copy)
    except Exception as error:
        code = str(error) if isinstance(error, Stop) and str(error) in MESSAGES else 'IDENTITY_UNRESOLVED'
        if wire:
            print(json.dumps({'error': code}))
        else:
            print(code + ': ' + MESSAGES[code], file=sys.stderr)
        return 1 if not wire else 0
    if wire:
        print(json.dumps(result))
    else:
        print('Profile: {profile}; API port: {port}; API base path: {basePath}'.format(**result))
        print('Copied to this interview Mac\'s clipboard. Paste into Caddy\'s masked API key field.' if args.copy else 'Metadata verified. No credential file was read; no assistant request was sent.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
