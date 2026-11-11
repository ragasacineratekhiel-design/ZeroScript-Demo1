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
