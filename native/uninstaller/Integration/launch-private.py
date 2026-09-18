"""Child-only creation mask, then replace this launcher with the already-built binary."""
import os
import sys

if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: launch-private.py BUILT_BINARY [ARGS...]")
    os.umask(0o077)
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
