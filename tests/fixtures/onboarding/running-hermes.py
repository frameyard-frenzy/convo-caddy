"""No live Hermes/native/process/socket/clipboard operation is permitted."""
import ast
import typing
import importlib.util
import json
import os
import ctypes
import contextlib
import io
import re
import shlex
import stat
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('acquire', 'scripts/acquire-hermes.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


PRODUCERS = json.loads(Path('tests/fixtures/onboarding/start-time-producers.json').read_text())


def produced_start(producer, seconds):
    # Execute only the pinned pure producer, with /proc absent and psutil fake.
    namespace = dict(Path=lambda path: types.SimpleNamespace(read_text=lambda **kw: (_ for _ in ()).throw(FileNotFoundError())),
                     Optional=typing.Optional, contextlib=contextlib)
    fake = types.SimpleNamespace(Process=lambda pid: types.SimpleNamespace(create_time=lambda: seconds), Error=Exception)
    with patch.dict(h.sys.modules, psutil=fake):
        exec(compile(ast.parse('from __future__ import annotations\n' + producer['function']), producer['commit'], 'exec'), namespace)
        return namespace['_get_process_start_time'](123)


class Acquisition(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='caddy-synthetic-acquisition-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / '.hermes'
        self.root.mkdir()
        self.profile = self.root / 'profiles' / 'synthetic'
        self.profile.mkdir(parents=True)
        self.record = dict(pid=123, kind='hermes-gateway', start_time=1700000000.125,
                           argv=['hermes', 'gateway', 'run'])
        self.state = dict(self.record, gateway_state='running', platforms={'api_server': {'state': 'connected'}})
        self.write_records()
        self.env = self.profile / '.env'
        self.env.write_text('API_SERVER_KEY=synthetic-private-value\n')
        self.calls = []
        self.identity = (os.getuid(), self.record['start_time'])
        self.socket_output = 'p123\nn127.0.0.1:8642\n'
        self.negative = 401
        self.positive = 200
        self.health = {'status': 'ok', 'platform': 'hermes-agent'}
        self.patches = [patch.object(h, 'process_identity', side_effect=lambda pid: (self.identity[0], divmod(round(self.identity[1] * 1000000), 1000000))),
                        patch.object(h, 'run', side_effect=self.fake_run),
                        patch.object(h, 'request', side_effect=self.fake_request)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def write_records(self):
        (self.profile / 'gateway.pid').write_text(json.dumps(self.record))
        (self.profile / 'gateway_state.json').write_text(json.dumps(self.state))

    def fake_run(self, argv, **kwargs):
        self.calls.append(('process', argv, kwargs))
        self.assertEqual(argv[0], '/usr/sbin/lsof')
        self.assertNotIn('synthetic-private-value', str(argv))
        self.assertIn('-sTCP:LISTEN', argv)
        return types.SimpleNamespace(stdout=self.socket_output.encode(), returncode=0)

    def fake_request(self, port, route, key=None):
        self.calls.append(('http', port, route, key))
        self.assertEqual(port, 8642)
        if route == '/health':
            self.assertIsNone(key)
            return 200, self.health
        self.assertEqual(route, '/v1/models')
        if key is None:
            return self.negative, {}
        # Identity + socket ownership must have been checked before the secret.
        self.assertTrue(any(c[0] == 'process' and '-iTCP:8642' in c[1] for c in self.calls))
        self.assertIn(('http', 8642, '/v1/models', None), self.calls)
        return self.positive, {'object': 'list', 'data': [{'id': 'marty'}]}

    def acquire(self, copy=False):
        return h.acquire(self.root, copy)

    def fails(self, code, copy=True):
        with self.assertRaises(h.Stop) as error:
            self.acquire(copy)
        self.assertEqual(str(error.exception), code)

    def test_foreground_and_automatic_have_identical_supported_behavior(self):
        for args in [['hermes', 'gateway'], ['/venv/python', '-m', 'hermes_cli.main', '--profile', 'synthetic', 'gateway', 'run', '--replace']]:
            self.record['argv'] = args
            self.state.update(self.record)
            self.write_records()
            result = self.acquire(True)
            self.assertEqual(result, dict(profile='synthetic', port=8642, basePath='/', key='synthetic-private-value'))

    def test_all_pinned_real_producers_rounding_and_seconds_precision(self):
        manifest = json.loads(Path('tests/fixtures/hermes-compatibility/manifest.json').read_text())
        self.assertEqual({p['commit'] for p in PRODUCERS}, {p['commit'] for p in manifest['targets']})
        # Below/at/above half-centiseconds, even/odd ties, second carry and
        # non-binary-exact microseconds. Expected integers are independent data.
        for micro, centis in [(0, 0), (124999, 12), (125000, 12), (125001, 13),
                              (134999, 13), (135000, 14), (135001, 14),
                              (123456, 12), (999999, 100)]:
            seconds = 1700000000 + micro / 1000000
            for producer in PRODUCERS:
                for argv in [['hermes', 'gateway'], ['python', '-m', 'hermes_cli.main', 'gateway', 'run']]:
                    with self.subTest(producer=producer['target'], micro=micro, argv=argv):
                        started = produced_start(producer, seconds)
                        expected = seconds if producer['target'] == 'installed' else 170000000000 + centis
                        self.assertEqual(started, expected)
                        self.assertIs(type(started), float if producer['target'] == 'installed' else int)
                        self.record.update(start_time=started, argv=argv)
                        self.state.update(self.record)
                        self.write_records()
                        self.identity = (os.getuid(), seconds)
                        self.assertEqual(self.acquire(True)['key'], 'synthetic-private-value')

    def test_producer_stale_and_sub_centisecond_reuse_fail_closed(self):
        for producer in PRODUCERS:
            started = produced_start(producer, 1700000000.123456)
            self.record['start_time'] = started
            self.state.update(self.record)
            self.write_records()
            self.identity = (os.getuid(), 1700000000.143456)
            self.fails('IDENTITY_UNRESOLVED')
            # Even a 1us change in the same rounded bucket during acquisition
            # must fail before the credential-bearing request.
            self.identity = (os.getuid(), 1700000000.123456)
            read = h.read_owned
            def changed(path, code):
                result = read(path, code)
                if path.name == '.env':
                    self.identity = (os.getuid(), 1700000000.123457)
                return result
            self.calls.clear()
            with patch.object(h, 'read_owned', side_effect=changed):
                self.fails('IDENTITY_UNRESOLVED')
            self.assertFalse(any(c[0] == 'http' and c[3] is not None for c in self.calls))

    def test_generation_change_during_socket_scan_prevents_even_health(self):
        self.record['start_time'] = produced_start(PRODUCERS[1], 1700000000.123456)
        self.state.update(self.record)
        self.write_records()
        self.identity = (os.getuid(), 1700000000.123456)
        def changed(argv, **kw):
            result = self.fake_run(argv, **kw)
            if '-iTCP:8642' in argv:
                self.identity = (os.getuid(), 1700000000.123457)
            return result
        with patch.object(h, 'run', side_effect=changed):
            self.fails('IDENTITY_UNRESOLVED')
        self.assertFalse(any(c[0] == 'http' for c in self.calls))

    def test_metadata_never_reads_credentials(self):
        self.env.unlink()
        self.assertEqual(self.acquire(), dict(profile='synthetic', port=8642, basePath='/'))
        self.assertFalse(any(c[0] == 'http' and c[3] is not None for c in self.calls))

    def test_internal_wire_main_requires_pipes_and_metadata_is_secret_free(self):
        original = os.fstat
        for mode in ['--wire-metadata', '--wire-copy']:
            for pipe in [False, True]:
                output = io.StringIO()
                def fstat(fd):
                    return types.SimpleNamespace(st_mode=stat.S_IFIFO if pipe else stat.S_IFCHR) if fd in (0, 1) else original(fd)
                with patch.object(h.sys, 'argv', ['synthetic', mode]), patch.object(h.sys, 'platform', 'darwin'), patch.object(h.os, 'fstat', side_effect=fstat), patch.object(h.pwd, 'getpwuid', return_value=types.SimpleNamespace(pw_dir=str(self.root.parent))), contextlib.redirect_stdout(output):
                    self.assertEqual(h.main(), 0)
                result = json.loads(output.getvalue())
                if not pipe:
                    self.assertEqual(result, {'error': 'TRANSFER_FAILED'})
                elif mode == '--wire-copy':
                    self.assertEqual(result['key'], 'synthetic-private-value')
                else:
                    self.assertNotIn('key', result)

    def test_absent_api_is_distinct_from_unresolved_endpoint(self):
        self.state['platforms'] = {'telegram': {'state': 'connected'}}
        self.write_records()
        self.fails('API_ABSENT')
        self.assertEqual(self.calls, [])
        self.state['platforms']['api_server'] = {'state': 'connected'}
        self.write_records()
        self.socket_output = ''
        self.fails('ENDPOINT_UNRESOLVED')

    def test_starting_gateway_cannot_be_reported_as_absent_api(self):
        self.state.update(gateway_state='starting', platforms={})
        self.write_records()
        self.fails('ENDPOINT_UNRESOLVED')

    def test_restart_during_candidate_read_prevents_secret_request(self):
        read = h.read_owned
        def changed(path, code):
            value = read(path, code)
            if path.name == '.env':
                self.identity = (os.getuid(), 1700000001.125)
            return value
        with patch.object(h, 'read_owned', side_effect=changed):
            self.fails('IDENTITY_UNRESOLVED')
        self.assertFalse(any(c[0] == 'http' and c[3] is not None for c in self.calls))

    def test_unknown_health_and_two_apis_fail_without_credentials(self):
        self.health = {'status': 'ok', 'platform': 'other'}
        self.fails('ENDPOINT_UNRESOLVED')
        self.assertFalse(any(c[0] == 'http' and c[3] is not None for c in self.calls))

    def test_other_same_gateway_listener_is_not_mistaken_for_api(self):
        def socket_list(argv, **kwargs):
            port = next((v.split(':')[1] for v in argv if v.startswith('-iTCP:')), None)
            body = 'p123\n' + (f'n127.0.0.1:{port}\n' if port else 'n127.0.0.1:8000\nn127.0.0.1:8642\n')
            return types.SimpleNamespace(stdout=body.encode(), returncode=0)
        def health(port, route, key=None):
            if port == 8000:
                self.assertIsNone(key)
                raise h.Stop('ENDPOINT_UNRESOLVED')
            return (200, self.health) if route == '/health' else (401, {})
        with patch.object(h, 'run', side_effect=socket_list), patch.object(h, 'request', side_effect=health):
            self.assertEqual(self.acquire()['port'], 8642)

    def test_multiple_gateways_fail_before_secret_read(self):
        other = self.root / 'profiles' / 'second'
        other.mkdir()
        for name in ['gateway.pid', 'gateway_state.json']:
            (other / name).write_bytes((self.profile / name).read_bytes())
        self.fails('AMBIGUOUS')
        self.assertFalse(any(c[0] == 'http' and c[3] is not None for c in self.calls))

    def test_stale_pid_and_wrong_owner_fail_before_network(self):
        for identity in [(os.getuid(), 1700000001.125), (os.getuid()+1, self.record['start_time'])]:
            self.identity = identity
            self.fails('IDENTITY_UNRESOLVED')
        self.assertEqual(self.calls, [])

    def test_wrong_socket_owner_prevents_credential_request(self):
        def wrong_owner(argv, **kwargs):
            return types.SimpleNamespace(stdout=(b'p999\nn127.0.0.1:8642\n' if '-iTCP:8642' in argv else self.socket_output.encode()), returncode=0)
        with patch.object(h, 'run', side_effect=wrong_owner):
            self.fails('IDENTITY_UNRESOLVED')
        self.assertFalse(any(c[0] == 'http' and c[3] is not None for c in self.calls))

    def test_auth_disabled_and_wrong_key_never_succeed(self):
        self.negative = 200
        self.fails('AUTH_REQUIRED')
        self.assertFalse(any(c[0] == 'http' and c[3] is not None for c in self.calls))
        self.negative = 401
        self.positive = 401
        self.fails('KEY_REJECTED')

    def test_unsupported_source_and_symlink_fail_closed(self):
        self.env.unlink()
        self.fails('KEY_SOURCE_UNSUPPORTED')
        other = self.root / 'not-a-key-source'
        other.write_text('API_SERVER_KEY=synthetic-private-value\n')
        self.env.symlink_to(other)
        self.fails('KEY_SOURCE_UNSUPPORTED')

    def test_all_previous_parser_cases(self):
        cases = [
            ("API_SERVER_KEY='synthetic # quoted' # comment\n", 'synthetic # quoted'),
            ('export API_SERVER_KEY="synthetic" # comment\n', 'synthetic'),
            ('API_SERVER_KEY=synthetic#value # comment\n', 'synthetic#value'),
            ('API_SERVER_KEY=\n', None),
            ("OTHER='first\nAPI_SERVER_KEY=synthetic-decoy\nlast'\n", None),
            ('OTHER="first\nAPI_SERVER_KEY=synthetic-decoy\nlast"\n', None),
            ("API_SERVER_KEY='${OTHER_KEY}'\n", None),
            ('API_SERVER_KEY="${OTHER_KEY}"\n', None),
            ('API_SERVER_KEY=${OTHER_KEY}\n', None),
            ("OTHER='first\nlast'\nAPI_SERVER_KEY=synthetic\n", None),
            ('OTHER=${VALUE}\nAPI_SERVER_KEY=synthetic\n', None),
            ('OTHER=hello\vAPI_SERVER_KEY=synthetic\n', None),
            ('not an assignment\nAPI_SERVER_KEY=synthetic\n', None),
            ("# comment\nOTHER='plain value' # comment\nAPI_SERVER_KEY=synthetic\n", 'synthetic'),
            ('API_SERVER_KEY=a\nAPI_SERVER_KEY=b\n', None),
            ('API_SERVER_KEY="unterminated\n', None),
            ('API_SERVER_KEY="a\\nb"\n', None),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                self.env.write_text(value)
                if expected is None:
                    self.fails('KEY_SOURCE_UNSUPPORTED')
                else:
                    self.assertEqual(self.acquire(True)['key'], expected)


class Transport(unittest.TestCase):
    def test_actual_people_commands_dispatch_to_captured_transport(self):
        guide = Path('docs/hermes-connection-setup.md').read_text()
        commands = re.findall(r'```command\n(.*?)\n```', guide, re.S)
        self.assertEqual(len(commands), 2)
        for index, command in enumerate(commands):
            # Separate bash/zsh fixtures execute expansion and unset guards.
            command = command.replace('"${HERMES_SSH_TARGET:?Complete step 2 in this local Terminal tab}"', '"shortname@100.101.102.103"')
            args = shlex.split(command)
            self.assertEqual(args[:4], ['python3', '-I', '-S', '/Applications/Convo Caddy.app/Contents/Resources/acquire-hermes.py'])
            calls = []
            def fake_run(argv, **kw):
                calls.append((argv, kw))
                if argv[0] == '/usr/bin/pbcopy':
                    self.assertEqual(kw['input'], b'synthetic-private-value')
                    return types.SimpleNamespace(returncode=0)
                self.assertEqual(argv[0], '/usr/bin/ssh' if index else h.sys.executable)
                self.assertNotIn('synthetic-private-value', str(argv))
                return types.SimpleNamespace(stdout=json.dumps(dict(profile='synthetic', port=8642, basePath='/', key='synthetic-private-value')).encode())
            output = io.StringIO()
            with patch.object(h.sys, 'argv', args[3:]), patch.object(h.sys, 'platform', 'darwin'), patch.object(h, 'run', side_effect=fake_run), contextlib.redirect_stdout(output):
                self.assertEqual(h.main(), 0)
            self.assertEqual(len(calls), 2)
            self.assertNotIn('synthetic-private-value', output.getvalue())
            self.assertIn('Copied', output.getvalue())

    def test_local_and_remote_copy_only_to_laptop_stdin(self):
        for host in [None, 'operator@100.101.102.103']:
            calls = []
            def fake_run(argv, **kwargs):
                calls.append((argv, kwargs))
                self.assertNotIn('synthetic-private-value', str(argv))
                if argv[0] == '/usr/bin/pbcopy':
                    self.assertEqual(kwargs['input'], b'synthetic-private-value')
                    return types.SimpleNamespace(returncode=0)
                if host:
                    self.assertEqual(argv[0], '/usr/bin/ssh')
                    for option in ['-T', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'ConnectTimeout=5']:
                        self.assertIn(option, argv)
                    self.assertEqual(argv[-2], host)
                else:
                    self.assertEqual(argv[1:], ['-I', '-S', '-', '--wire-copy'])
                self.assertIsInstance(kwargs['input'], bytes)
                self.assertIn(b'def acquire(', kwargs['input'])
                return types.SimpleNamespace(stdout=json.dumps(dict(profile='synthetic', port=8642, basePath='/', key='synthetic-private-value')).encode())
            with patch.object(h, 'run', side_effect=fake_run):
                result = h.client(host, True)
            self.assertNotIn('key', result)
            self.assertEqual(calls[-1][0], ['/usr/bin/pbcopy'])

    def test_ssh_failure_and_banner_do_not_touch_clipboard(self):
        for failure in [subprocess.TimeoutExpired('synthetic', 1), RuntimeError('private'), b'banner\n{}']:
            def fail(*args, **kwargs):
                if isinstance(failure, bytes):
                    return types.SimpleNamespace(stdout=failure)
                raise failure
            with patch.object(h, 'run', side_effect=fail) as run:
                with self.assertRaises(h.Stop):
                    h.client('operator@100.101.102.103', True)
                self.assertEqual(run.call_count, 1)


class NativeAndHttp(unittest.TestCase):
    def test_http_failure_is_unresolved_endpoint_and_has_total_deadline(self):
        connection = unittest.mock.Mock()
        connection.getresponse.side_effect = TimeoutError('synthetic-private-error')
        with patch.object(h.http.client, 'HTTPConnection', return_value=connection), patch.object(h.signal, 'setitimer') as timer:
            with self.assertRaises(h.Stop) as error:
                h.request(8642, '/health')
            self.assertEqual(str(error.exception), 'ENDPOINT_UNRESOLVED')
            self.assertEqual(timer.call_args_list[0].args, (h.signal.ITIMER_REAL, 3))
            self.assertEqual(timer.call_args_list[-1].args, (h.signal.ITIMER_REAL, 0))

    def test_native_process_generation_uses_exact_sdk_layout_without_live_libproc(self):
        self.assertEqual(ctypes.sizeof(h.BsdInfo), 136)
        class Function:
            def __call__(self, pid, flavor, argument, pointer, size):
                self_test.assertEqual((pid, flavor, argument, size), (123, 3, 0, 136))
                info = ctypes.cast(pointer, ctypes.POINTER(h.BsdInfo)).contents
                info.pid, info.uid, info.seconds, info.microseconds = 123, 501, 1700000000, 125000
                return 136
        self_test = self
        with patch.object(h.ctypes, 'CDLL', return_value=types.SimpleNamespace(proc_pidinfo=Function())) as load:
            self.assertEqual(h.process_identity(123), (501, (1700000000, 125000)))
            load.assert_called_once_with('/usr/lib/libproc.dylib')

    def test_direct_http_transport_is_bounded_and_never_redirects(self):
        for status, body in [(200, b'{}'), (302, b'{}'), (200, b'x' * 65537)]:
            response = types.SimpleNamespace(status=status, read=lambda size: body)
            connection = unittest.mock.Mock()
            connection.getresponse.return_value = response
            with patch.object(h.http.client, 'HTTPConnection', return_value=connection) as create:
                if status == 200 and body == b'{}':
                    self.assertEqual(h.request(8642, '/v1/models', 'synthetic'), (200, {}))
                else:
                    with self.assertRaises(h.Stop):
                        h.request(8642, '/v1/models', 'synthetic')
                create.assert_called_once_with('127.0.0.1', 8642, timeout=3)
                connection.request.assert_called_once_with('GET', '/v1/models', headers={'Authorization': 'Bearer synthetic'})
                connection.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
