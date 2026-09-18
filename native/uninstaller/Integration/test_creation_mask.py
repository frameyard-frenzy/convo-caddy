"""Ordinary files only: demonstrate inherited 0022 must not reach the test binary."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest



class CreationMaskTests(unittest.TestCase):
    def test_parent_0022_creates_private_child_files_without_changing_parent(self):
        root = Path(tempfile.mkdtemp(prefix="caddy-mask-plain-", dir="/private/tmp"))
        previous = os.umask(0o022)
        try:
            code = "import os,sys; os.close(os.open(sys.argv[1],os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o666)); os.close(os.open(sys.argv[2],os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o444))"
            launcher = Path(__file__).with_name("launch-private.py")
            result = subprocess.run([sys.executable, "-B", str(launcher), sys.executable, "-c", code, str(root/'database'), str(root/'lock')], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual((root/'database').stat().st_mode & 0o777, 0o600)
            self.assertEqual((root/'lock').stat().st_mode & 0o777, 0o400)
            observed = os.umask(0o022)
            self.assertEqual(observed, 0o022)
        finally:
            os.umask(previous)


if __name__ == '__main__':
    unittest.main()
