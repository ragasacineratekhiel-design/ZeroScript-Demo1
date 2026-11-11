import importlib.util
from pathlib import Path
import unittest

SOURCE=Path(__file__).resolve().parents[1]/'ZeroScript Demo'/'ZeroScript-Free-1.5.5'/'team_console.py'
spec=importlib.util.spec_from_file_location('zs_console',SOURCE)
console=importlib.util.module_from_spec(spec)
spec.loader.exec_module(console)

class ConsoleTests(unittest.TestCase):
    def test_role_prefix_and_colors(self):
        for role,code in [('planner','94'),('coder','91'),('checker','92')]:
            event={'timestamp':'2026-11-11T00:00:00Z','name':'Claude','role':role,'kind':'message','text':'hello'}
            plain=console.format_event(event)
            self.assertIn(f'({role.title()}):[Claude]:',plain)
            self.assertNotIn('\033',plain)
            colored=console.format_event(event,True)
            self.assertTrue(colored.startswith('\033['+code+'m'))
            self.assertTrue(colored.endswith('\033[0m'))

    def test_untrusted_text_cannot_control_terminal(self):
        line=console.format_event({'name':'Claude\033[2J','role':'coder','text':'hello\rspoof\033[31m\x9b'})
        self.assertNotIn('\033',line)
        self.assertNotIn('\r',line)
        self.assertNotIn('\x9b',line)
