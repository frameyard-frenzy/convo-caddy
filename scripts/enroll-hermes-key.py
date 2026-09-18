"""Human-run, bounded public-key enrollment over already trusted OpenSSH.

No private-key reads, host trust changes, service operations or chmod of existing
paths. Remote code is streamed as a command; no helper is installed on the host.
Filesystem authority is the login user's home, protected against other users;
this is not a boundary against malicious processes running as that same user.
"""
import argparse
import base64
import fcntl
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys


class Stop(Exception):
    pass


def public_key(text):
    if len(text) > 16384 or '\n' in text.strip() or '\r' in text:
        raise Stop('INVALID_PUBLIC_KEY')
    parts = text.strip().split()
    if len(parts) < 2 or parts[0] != 'ssh-ed25519':
        raise Stop('INVALID_PUBLIC_KEY')
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except ValueError:
        raise Stop('INVALID_PUBLIC_KEY') from None
    if len(blob) != 51 or blob[:19] != b'\0\0\0\x0bssh-ed25519\0\0\0\x20':
        raise Stop('INVALID_PUBLIC_KEY')
    return text.strip(), parts[:2]


def owned(fd, directory=False):
    info = os.fstat(fd)
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if (not valid_type or info.st_uid != os.getuid() or info.st_mode & 0o022
            or not directory and info.st_nlink != 1):
        raise Stop('UNSAFE_PATH')
    return info


def enroll(home, text):
    line, identity = public_key(text)
    descriptors = []
    try:
        # Open each home ancestor without following symbolic links. Ancestors
        # may be system-owned; the final home must belong to the login account.
        current = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        descriptors.append(current)
        for part in Path(home).absolute().parts[1:]:
            current = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            descriptors.append(current)
        owned(current, True)
        try:
            os.mkdir('.ssh', 0o700, dir_fd=current)
        except FileExistsError:
            pass
        folder = os.open('.ssh', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
        descriptors.append(folder)
        owned(folder, True)
        fd = os.open('authorized_keys', os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                     0o600, dir_fd=folder)
        descriptors.append(fd)
        info = owned(fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if info.st_size > 1024 * 1024:
            raise Stop('KEY_FILE_TOO_LARGE')
        data = os.read(fd, 1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise Stop('KEY_FILE_TOO_LARGE')
        # Exact key identity, ignoring only its comment. An entry with SSH
        # restrictions is preserved and never silently upgraded to unrestricted.
        identity_bytes = [part.encode('ascii') for part in identity]
        for existing in data.split(b'\n'):
            fields = existing.split()
            if not fields or fields[0].startswith(b'#'):
                continue
            if fields[:2] == identity_bytes:
                return 'ALREADY_ENROLLED'
            if identity_bytes[1] in fields:
                raise Stop('EXISTING_RESTRICTED_KEY')
        addition = (b'\n' if data and not data.endswith(b'\n') else b'') + (line + '\n').encode()
        if os.write(fd, addition) != len(addition):
            raise Stop('ENROLLMENT_INCOMPLETE')
        os.fsync(fd)
        return 'ENROLLED'
    except (OSError, UnicodeError):
        raise Stop('UNSAFE_PATH') from None
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def remote(target, public_path):
    if not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*', target):
        raise Stop('INVALID_SSH_ADDRESS')
    try:
        fd = os.open(public_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as file:
            owned(file.fileno())
            line, _ = public_key(file.read(16385).decode('utf-8'))
        source = Path(__file__).read_text()
        command = 'python3 -I -S -c ' + shlex.quote(source) + ' --receive-public ' + shlex.quote(line)
        # Inherit Terminal so account-password prompts never pass through Caddy.
        subprocess.run(['/usr/bin/ssh', '-F', 'none', '-o', 'StrictHostKeyChecking=yes',
                        '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
                        '-o', 'NumberOfPasswordPrompts=1', target, command], check=True, timeout=60)
    except (OSError, UnicodeError, subprocess.SubprocessError):
        raise Stop('ENROLLMENT_FAILED') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh')
    parser.add_argument('--public-key', type=Path)
    parser.add_argument('--receive-public', help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.receive_public is not None and not args.ssh and not args.public_key:
            print(enroll(Path.home(), args.receive_public))
        elif args.ssh and args.public_key and args.receive_public is None:
            remote(args.ssh, args.public_key)
        else:
            parser.error('use --ssh shortname@address --public-key /path/to/key.pub')
    except Stop as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
