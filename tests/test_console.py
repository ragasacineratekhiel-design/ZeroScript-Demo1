import importlib.util
from pathlib import Path
import os
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


class PortResolutionTests(unittest.TestCase):
    """`_http_port()` claims to survive a malformed port env var; prove it.

    4.6.0 evaluated ZS_BRIDGE_PORT inline, so `ZS_BRIDGE_PORT=abc` raised
    ValueError and killed the console with a traceback before it printed
    anything — even though the user's mistake was only in an env var.
    """

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ("ZS_BRIDGE_PORT", "ZS_BRIDGE_HTTP_PORT")}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v

    def test_defaults(self):
        self.assertEqual(console._http_port(), 17614)

    def test_derived_from_ws_port(self):
        os.environ["ZS_BRIDGE_PORT"] = "20000"
        self.assertEqual(console._http_port(), 20001)

    def test_explicit_http_port_wins(self):
        os.environ["ZS_BRIDGE_PORT"] = "20000"
        os.environ["ZS_BRIDGE_HTTP_PORT"] = "30000"
        self.assertEqual(console._http_port(), 30000)

    def test_malformed_values_fall_back_instead_of_raising(self):
        os.environ["ZS_BRIDGE_PORT"] = "not-a-port"
        self.assertEqual(console._http_port(), 17614)
        os.environ["ZS_BRIDGE_HTTP_PORT"] = "also-bad"
        self.assertEqual(console._http_port(), 17614)

    def test_tail_count_rejects_out_of_range(self):
        self.assertEqual(console.tail_count("50"), 50)
        for bad in ("0", "1001", "-1"):
            with self.assertRaises(Exception):
                console.tail_count(bad)
