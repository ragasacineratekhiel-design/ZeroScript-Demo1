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

    def test_console_filters_and_tail(self):
        events=[{'seq':1,'team':'a','role':'coder','kind':'message'},
                {'seq':2,'team':'b','role':'planner','kind':'joined'},
                {'seq':3,'team':'a','role':'coder','kind':'message'}]
        self.assertEqual([e['seq'] for e in console.select_events(events,'a','coder','message',1)],[3])
        self.assertEqual(console.select_events(events,role='checker'),[])
        with self.assertRaises(Exception):console.tail_count('0')

    def test_role_violation_and_summary_formatting(self):
        ev = {'timestamp': '2026-11-12T00:00:00Z', 'name': 'Claude', 'role': 'planner', 'kind': 'role_violation', 'text': 'execute_luau blocked'}
        out = console.format_event(ev)
        self.assertIn('[ROLE-BLOCKED]', out)
        sm = console.format_summary({'teams': [{'team': 'studio', 'active': True, 'run_id': 2, 'members': [{'role': 'planner', 'name': 'Claude', 'ready': True}]}]})
        self.assertIn('team=studio', sm)
        self.assertIn('planner:Claude(ready)', sm)
