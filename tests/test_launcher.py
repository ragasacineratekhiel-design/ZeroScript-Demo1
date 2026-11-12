"""Launcher process ownership tests: no real child processes or desktop required."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / 'ZeroScript Demo' / 'ZeroScript-Free-1.5.5' / 'start.py'
spec = importlib.util.spec_from_file_location('zs_launcher', SOURCE)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_check_does_not_spawn(self):
        with patch.object(launcher, 'check'), patch.object(launcher.subprocess, 'Popen') as spawn:
            self.assertEqual(launcher.main(['--check']), 0)
            spawn.assert_not_called()

    def test_failure_does_not_spawn(self):
        with patch.object(launcher, 'check', side_effect=RuntimeError('missing dependency')), patch.object(launcher.subprocess, 'Popen') as spawn:
            self.assertEqual(launcher.main([]), 1)
            spawn.assert_not_called()

    def test_crash_not_restarted_and_viewer_cleaned_up(self):
        bridge = Mock()
        bridge.wait.return_value = 7
        bridge.poll.return_value = 7
        viewer = Mock()
        viewer.poll.return_value = None
        with patch.object(launcher, 'check'), patch.object(launcher.subprocess, 'Popen', return_value=bridge) as spawn, patch.object(launcher, 'launch_console', return_value=viewer):
            self.assertEqual(launcher.main([]), 7)
            self.assertEqual(spawn.call_count, 1)
            viewer.terminate.assert_called_once()
            bridge.terminate.assert_not_called()

    def test_interrupt_stops_owned_bridge(self):
        bridge = Mock()
        bridge.poll.return_value = None
        bridge.wait.side_effect = [KeyboardInterrupt(), None]
        with patch.object(launcher, 'check'), patch.object(launcher.subprocess, 'Popen', return_value=bridge):
            self.assertEqual(launcher.main(['--no-console']), 130)
            bridge.terminate.assert_called_once()

    def test_explicit_dependency_install_uses_local_environment(self):
        with patch.object(launcher, 'local_python', return_value=Path('/local/env/python')), patch('venv.EnvBuilder') as builder, patch.object(launcher.subprocess, 'run') as run:
            self.assertEqual(launcher.main(['--install-deps']),0)
            builder.return_value.create.assert_called_once()
            command=run.call_args.args[0]
            self.assertEqual(command[0],'/local/env/python')
            self.assertIn('websockets>=13,<16',command)

    @unittest.skipIf(__import__('os').name=='nt', 'POSIX subprocess smoke; Windows console requires desktop testing')
    def test_real_launcher_reaches_bridge_health(self):
        import json, os, signal, socket, sys, tempfile, time, urllib.request
        sockets=[]
        for _ in range(2):
            sock=socket.socket();sock.bind(('127.0.0.1',0));sockets.append(sock)
        wsport,httpport=[sock.getsockname()[1] for sock in sockets]
        for sock in sockets:sock.close()
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp,'config.json').write_text('{"mcpServers":{}}')
            env={**os.environ,'ZS_DATA_DIR':tmp,'ZS_BRIDGE_PORT':str(wsport),'ZS_BRIDGE_HTTP_PORT':str(httpport)}
            with tempfile.TemporaryFile(mode='w+') as output:
                child=subprocess.Popen([sys.executable,str(SOURCE),'--no-console'],cwd=tmp,env=env,stdout=output,stderr=output)
                try:
                    deadline=time.monotonic()+10
                    healthy=False
                    while child.poll() is None and time.monotonic()<deadline:
                        try:
                            with urllib.request.urlopen(f'http://127.0.0.1:{httpport}/health',timeout=.3) as response:
                                healthy=json.load(response)['ok']
                            if healthy:break
                        except OSError:time.sleep(.05)
                    output.seek(0)
                    self.assertTrue(healthy,output.read())
                finally:
                    if child.poll() is None:child.send_signal(signal.SIGTERM)
                    try:child.wait(timeout=8)
                    except subprocess.TimeoutExpired:child.kill();child.wait()
                with self.assertRaises(OSError):
                    urllib.request.urlopen(f'http://127.0.0.1:{httpport}/health',timeout=.3)

    def test_reuses_local_venv_even_when_interpreter_is_symlinked(self):
        with patch.object(launcher, 'local_python') as target, patch.object(launcher, 'wait_owned', return_value=0) as call, patch.object(launcher.sys, 'prefix', '/different/environment'):
            target.return_value.is_file.return_value=True
            target.return_value.__str__.return_value='/local/venv/bin/python'
            self.assertEqual(launcher.entrypoint(),0)
            call.assert_called_once()

    def test_launcher_version_is_4_7_0(self):
        self.assertEqual(launcher.VERSION, '4.7.0')

    def test_format_chat_shows_the_bare_message(self):
        line = launcher.format_chat({
            'timestamp': '2026-11-12T10:11:12.345+00:00', 'kind': 'message',
            'name': 'Claude', 'role': 'planner', 'recipient': 'coder', 'handoff': 'plan',
            'text': 'Build StageService like this',
        })
        self.assertIn('Claude (planner) -> coder', line)
        self.assertIn('[PLAN]', line)
        self.assertIn('Build StageService like this', line)

    def test_status_shows_joined_members_and_the_bare_chat(self):
        chat = {
            'ok': True,
            'members': {'studio': [
                {'id': 'a', 'name': 'Claude', 'role': 'planner', 'ready': True},
                {'id': 'b', 'name': 'DeepSeek', 'role': 'coder', 'ready': False},
            ]},
            'messages': [{'seq': 3, 'timestamp': '2026-11-12T10:11:12.345+00:00', 'kind': 'message',
                          'name': 'Claude', 'role': 'planner', 'recipient': 'coder', 'handoff': 'plan',
                          'text': 'Build the StageService like this'}],
        }
        summary = {'ok': True, 'teams': {'studio': {'active': True, 'introduction_order': ['planner', 'coder'],
                                                    'phase': 'plan', 'members': []}}}
        events = {'ok': True, 'events': [{'kind': 'message'}], 'cursor': 3}

        def fake_get(path):
            if path.startswith('/api/team/chat'):
                return chat
            if path.startswith('/api/team/summary'):
                return summary
            if path.startswith('/api/team/events'):
                return events
            return None

        with patch.object(launcher, 'bridge_health', return_value={'ok': True}), \
                patch.object(launcher, 'http_get', side_effect=fake_get), \
                patch('builtins.print') as printed:
            self.assertEqual(launcher.status_summary(), 0)
        text = '\n'.join(str(call) for call in printed.call_args_list)
        self.assertIn('Claude (planner, ready)', text)
        self.assertIn('DeepSeek (coder, joined)', text)
        self.assertIn('planner -> coder', text)
        self.assertIn('Build the StageService like this', text)

    def test_team_watch_prints_messages_and_joins(self):
        events = [
            {'seq': 1, 'kind': 'joined', 'name': 'Claude', 'role': 'planner', 'team': 'studio',
             'timestamp': '2026-11-12T10:00:00.000+00:00', 'text': 'Claude joined'},
            {'seq': 2, 'kind': 'message', 'name': 'Claude', 'role': 'planner', 'recipient': 'coder',
             'handoff': 'intro', 'timestamp': '2026-11-12T10:00:01.000+00:00', 'text': 'Hi, I am the planner'},
        ]

        def fake_get(path, **_kwargs):
            if path.startswith('/api/team/chat'):
                return {'ok': True, 'members': {}, 'messages': []}
            if path.startswith('/api/team/summary'):
                return {'ok': True, 'teams': {}}
            if 'wait=1' in path:
                return {'ok': True, 'events': events, 'cursor': 2}
            return {'ok': True, 'events': [], 'cursor': 0}

        stop = __import__('threading').Event()
        with patch.object(launcher, 'bridge_health', return_value={'ok': True}), \
                patch.object(launcher, 'http_get', side_effect=fake_get), \
                patch('builtins.print') as printed:
            watcher = __import__('threading').Thread(target=launcher.watch_team, args=(stop,), daemon=True)
            watcher.start()
            __import__('time').sleep(0.4)
            stop.set()
            watcher.join(timeout=2)
        text = '\n'.join(str(call) for call in printed.call_args_list)
        self.assertIn('Claude (planner) joined team studio', text)
        self.assertIn('Hi, I am the planner', text)
