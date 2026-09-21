"""Owned PTY test driver. All input is a hardcoded synthetic sentinel."""
import json, os, pathlib, pty, select, signal, subprocess, sys, termios, time
node, scenario, root = sys.argv[1:]
root = pathlib.Path(root)
args = ['--discover', '--region', 'us-west-2']
if scenario == 'bad-args': args += ['--key', 'SYNTHETIC-DISCOVERY-SENTINEL']
if scenario in ('export', 'existing-export'):
    args += ['--output', str(root / 'schemas.json')]
if scenario == 'existing-export': (root / 'schemas.json').write_text('keep')
command = [node, '--import', 'tsx', 'tests/helpers/recall-discovery-cli-fixture.ts', scenario, str(root / 'calls.json'), *args]
output = b''
restored = True
if scenario == 'non-tty':
    child = subprocess.run(command, input=b'SYNTHETIC-DISCOVERY-SENTINEL\n', stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=6)
    code, output = child.returncode, child.stdout
else:
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave)
    sent = False
    cancelled = False
    deadline = time.monotonic() + 7
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], .05)[0]: output += os.read(master, 65536)
            if b'MCP key (hidden): ' in output and not sent:
                sent = True
                if scenario == 'ctrl-c': os.write(master, b'\x03')
                elif scenario == 'eof': os.write(master, b'\x04')
                elif scenario == 'signal': child.send_signal(signal.SIGTERM)
                else: os.write(master, b'SYNTHETIC-DISCOVERY-SENTINEL\r')
            if b'FIXTURE_WAITING' in output and not cancelled:
                cancelled = True
                os.write(master, b'\x03')
            if child.poll() is not None:
                while select.select([master], [], [], 0)[0]: output += os.read(master, 65536)
                break
        else:
            child.kill()
            raise RuntimeError('fixture deadline exceeded')
        code = child.wait(timeout=1)
        restored = termios.tcgetattr(slave) == before
    finally:
        if child.poll() is None: child.kill(); child.wait()
        os.close(master); os.close(slave)
record = json.loads((root / 'calls.json').read_text()) if (root / 'calls.json').exists() else {'calls': [], 'permitted': False}
print(json.dumps(dict(record, output=output.decode('utf-8', 'replace'), restored=restored, code=code)))
