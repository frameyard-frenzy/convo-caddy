"""Synthetic cross-process proofs; never opens the user's control directory."""
import fcntl
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ADDON = Path(__file__).resolve().parent / "build/Release/convo_caddy_lifecycle_lock.node"
SCRIPT = """
const lock = require(process.argv[1]);
lock.acquire(process.argv[2]);
require('node:child_process').execFileSync(process.execPath, ['-e', 'process.exit(0)']);
console.log('held');
process.stdin.resume();
process.stdin.once('data', () => { lock.release(); process.exit(0); });
"""


class NativeLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cc-native-lock-")
        self.root = Path(self.temp.name).resolve()
        self.control = self.root / "control"
        self.control.mkdir(mode=0o700)
        self.file = self.control / "lifecycle.lock"
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)
        self.temp.cleanup()

    def start(self, file=None):
        child = subprocess.Popen(
            ["node", "-e", SCRIPT, str(ADDON), str(file or self.file)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        self.children.append(child)
        return child

    def assert_rejected(self, file=None):
        child = self.start(file)
        line = child.stdout.readline()
        self.assertNotEqual(line, "held\n", "unsafe marker acquired")
        self.assertNotEqual(child.wait(timeout=5), 0)

    def test_public_marker_rejected(self):
        self.file.touch(mode=0o644)
        self.assert_rejected()

    def test_alias_ancestor_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.control, target_is_directory=True)
        self.assert_rejected(alias / "lifecycle.lock")
        self.assertFalse(self.file.exists())

    def test_contention_helper_exit_and_main_crash(self):
        child = self.start()
        self.assertEqual(child.stdout.readline(), "held\n")
        identity = self.file.stat().st_ino
        with self.file.open("r+") as marker:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(marker, fcntl.LOCK_EX | fcntl.LOCK_NB)
            child.kill()
            child.wait(timeout=5)
            fcntl.flock(marker, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_rejected()
            self.assertEqual(self.file.stat().st_ino, identity)
            fcntl.flock(marker, fcntl.LOCK_UN)
        next_child = self.start()
        self.assertEqual(next_child.stdout.readline(), "held\n")
        next_child.communicate("release", timeout=5)
        self.assertEqual(next_child.returncode, 0)


if __name__ == "__main__":
    unittest.main()
