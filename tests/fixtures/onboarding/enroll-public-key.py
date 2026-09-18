"""Synthetic filesystem and transport tests; never uses host .ssh or SSH."""
import base64
import importlib.util
import os
from pathlib import Path
import tempfile
import re
import shlex
import sys
import types
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('enroll', 'scripts/enroll-hermes-key.py')
enroll = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enroll)
KEY = 'ssh-ed25519 ' + base64.b64encode(b'\0\0\0\x0bssh-ed25519\0\0\0\x20' + b'x' * 32).decode() + ' synthetic'

class Enrollment(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
    def run_enroll(self):
        return enroll.enroll(self.home, KEY)
    def test_missing_and_duplicate(self):
        self.run_enroll()
        target = self.home / '.ssh/authorized_keys'
        before = target.read_bytes()
        self.run_enroll()
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(before, (KEY + '\n').encode())
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
    def test_existing_entries_newline_and_modes_preserved(self):
        folder = self.home / '.ssh'
        folder.mkdir(mode=0o755)
        target = folder / 'authorized_keys'
        for old in [b'# existing\n', b'# no newline', b'']:
            target.write_bytes(old)
            target.chmod(0o644)
            self.run_enroll()
            expected = old + (b'\n' if old and not old.endswith(b'\n') else b'') + (KEY+'\n').encode()
            self.assertEqual(target.read_bytes(), expected)
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertEqual(folder.stat().st_mode & 0o777, 0o755)
    def test_same_key_different_comment_is_not_duplicated(self):
        self.run_enroll()
        target = self.home / '.ssh/authorized_keys'
        target.write_text(KEY.replace('synthetic', 'another comment') + '\n')
        before = target.read_bytes()
        self.run_enroll()
        self.assertEqual(target.read_bytes(), before)
    def test_non_utf8_comment_bytes_allow_new_key_without_rewriting(self):
        folder = self.home / '.ssh'
        folder.mkdir(mode=0o700)
        target = folder / 'authorized_keys'
        other = 'ssh-ed25519 ' + base64.b64encode(b'\0\0\0\x0bssh-ed25519\0\0\0\x20' + b'y' * 32).decode()
        for ending in [b'\n', b'']:
            before = b'# caf\xe9\n  # ' + KEY.encode('ascii') + b' noted-\xff\n' + other.encode('ascii') + b' legacy-\xff' + ending
            target.write_bytes(before)
            self.assertEqual(self.run_enroll(), 'ENROLLED')
            self.assertEqual(target.read_bytes(), before + (b'' if ending else b'\n') + (KEY+'\n').encode())
    def test_non_utf8_comments_preserve_duplicate_key_bytes(self):
        folder = self.home / '.ssh'
        folder.mkdir(mode=0o700)
        target = folder / 'authorized_keys'
        before = b'# caf\xe9\n' + KEY.encode('ascii') + b' legacy-\xff\n'
        target.write_bytes(before)
        self.assertEqual(self.run_enroll(), 'ALREADY_ENROLLED')
        self.assertEqual(target.read_bytes(), before)
    def test_non_utf8_comments_do_not_upgrade_restricted_keys(self):
        folder = self.home / '.ssh'
        folder.mkdir(mode=0o700)
        target = folder / 'authorized_keys'
        before = b'# caf\xe9\nrestrict ' + KEY.encode('ascii') + b' legacy-\xff\n'
        target.write_bytes(before)
        with self.assertRaisesRegex(enroll.Stop, 'EXISTING_RESTRICTED_KEY'):
            self.run_enroll()
        self.assertEqual(target.read_bytes(), before)

    def test_unsafe_paths_unchanged(self):
        for level in ['.ssh', '.ssh/authorized_keys']:
            with self.subTest(level=level):
                root = self.home / level.replace('/', '-')
                root.mkdir()
                outside = self.home / ('outside-' + level.replace('/', '-'))
                outside.write_text('preserve')
                target = root / level
                target.parent.mkdir(exist_ok=True)
                target.symlink_to(outside)
                with self.assertRaises(enroll.Stop):
                    enroll.enroll(root, KEY)
                self.assertEqual(outside.read_text(), 'preserve')
    def test_rejects_wrong_owner_and_writable_paths(self):
        with patch.object(enroll.os, 'getuid', return_value=os.getuid()+1):
            with self.assertRaises(enroll.Stop): self.run_enroll()
        self.run_enroll()
        target = self.home / '.ssh/authorized_keys'
        before = target.read_bytes()
        for p in [self.home, target.parent, target]:
            original = p.stat().st_mode & 0o777
            p.chmod(0o777)
            with self.assertRaises(enroll.Stop): self.run_enroll()
            p.chmod(original)
        self.assertEqual(target.read_bytes(), before)
    def test_rejects_hardlink_large_file_and_nonregular(self):
        folder = self.home / '.ssh'
        folder.mkdir()
        target = folder / 'authorized_keys'
        target.mkdir()
        with self.assertRaises(enroll.Stop): self.run_enroll()
        target.rmdir()
        target.write_bytes(b'x' * (1024*1024+1))
        with self.assertRaises(enroll.Stop): self.run_enroll()
        target.write_text('keep')
        os.link(target, self.home/'hardlink')
        with self.assertRaises(enroll.Stop): self.run_enroll()
        self.assertEqual(target.read_text(), 'keep')
    def test_invalid_key_never_creates_paths(self):
        for key in ['', KEY+'\n'+KEY, 'ssh-ed25519 bm90LWEtcHVibGljLWtleQ==', '-----BEGIN ' + 'PRIVATE KEY-----']:
            with self.assertRaises(enroll.Stop): enroll.enroll(self.home, key)
        self.assertFalse((self.home/'.ssh').exists())
    def test_wrong_nested_owner_stops_before_append(self):
        self.run_enroll()
        target = self.home / '.ssh/authorized_keys'
        before = target.read_bytes()
        real_stat = os.fstat
        for victim in [target.parent, target]:
            inode = victim.stat().st_ino
            def fake_stat(fd):
                info = real_stat(fd)
                if info.st_ino == inode:
                    return types.SimpleNamespace(st_mode=info.st_mode, st_uid=os.getuid()+1,
                                                 st_nlink=info.st_nlink, st_size=info.st_size)
                return info
            with patch.object(enroll.os, 'fstat', side_effect=fake_stat):
                with self.assertRaises(enroll.Stop): self.run_enroll()
            self.assertEqual(target.read_bytes(), before)
    def test_restricted_key_and_locked_file_stop(self):
        self.run_enroll()
        target = self.home / '.ssh/authorized_keys'
        target.write_text('restrict ' + KEY + '\n')
        before = target.read_bytes()
        with self.assertRaisesRegex(enroll.Stop, 'EXISTING_RESTRICTED_KEY'): self.run_enroll()
        self.assertEqual(target.read_bytes(), before)
        with patch.object(enroll.fcntl, 'flock', side_effect=BlockingIOError):
            with self.assertRaises(enroll.Stop): self.run_enroll()
        self.assertEqual(target.read_bytes(), before)
    def test_actual_guide_command_and_timeout(self):
        guide = Path('docs/hermes-connection-setup.md').read_text()
        command = next(block for block in re.findall(r'```bash\n(.*?)\n```', guide, re.S) if '--public-key' in block)
        # Shell expansion and unset failure are executed by ssh-target-recipe.test.ts.
        command = command.replace('"${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}"', '"shortname@100.101.102.103"')
        argv = shlex.split(command)
        self.assertEqual(argv[:3], ['python3', '-I', '-S'])
        public = self.home / 'synthetic.pub'
        public.write_text(KEY+'\n')
        argv[-1] = str(public)
        with patch.object(sys, 'argv', argv[3:]), patch.object(enroll.subprocess, 'run') as run:
            self.assertEqual(enroll.main(), 0)
            self.assertEqual(run.call_count, 1)
            self.assertIn('shortname@100.101.102.103', run.call_args.args[0])
        with patch.object(enroll.subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic', 60)):
            with self.assertRaisesRegex(enroll.Stop, 'ENROLLMENT_FAILED'):
                enroll.remote('reader@100.101.102.103', public)

    def test_transport_strict_bounded_public_only(self):
        public = self.home/'public.pub'
        public.write_text(KEY+'\n')
        with patch.object(enroll.subprocess, 'run') as run:
            enroll.remote('reader@100.101.102.103', public)
            argv = run.call_args.args[0]
            self.assertEqual(argv[0], '/usr/bin/ssh')
            self.assertIn('StrictHostKeyChecking=yes', argv)
            self.assertIn('ConnectTimeout=15', argv)
            self.assertEqual(run.call_args.kwargs['timeout'], 60)
            self.assertNotIn('capture_output', run.call_args.kwargs)
            self.assertIn('python3 -I -S', argv[-1])
            self.assertNotIn(str(public), argv[-1])
        with patch.object(enroll.subprocess, 'run') as run:
            with self.assertRaises(enroll.Stop): enroll.remote('-oProxyCommand=bad', public)
            run.assert_not_called()

unittest.main()
