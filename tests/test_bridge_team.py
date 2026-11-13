"""Run: PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -v
Requires websockets>=13,<16. All logs/config/tokens use a temporary directory.
No Studio process is launched or terminated by these tests.
"""
import asyncio
import concurrent.futures
import importlib
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "ZeroScript Demo" / "ZeroScript-Free-1.5.5"
sys.path.insert(0, str(SOURCE))
from team_hub import TeamHub, TeamError


class TeamTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.hub = TeamHub(clock=lambda: self.now)
        for name, role in (("Claude", "planner"), ("DeepSeek", "coder"), ("Gemini", "checker")):
            self.hub.register(role, name, role)

    def start(self):
        self.hub.start("studio")
        for role in ("planner", "coder", "checker"):
            self.hub.ready(role)

    def test_expired_required_role_stops_run_and_clears_queues(self):
        self.start()
        self.hub.send("planner","coder","queued work","stale-work")
        self.now+=30
        self.hub.status("planner")
        self.now+=20
        result=self.hub.status("planner")
        self.assertFalse(result["active"])
        self.assertFalse(result["communication_confirmed"])
        self.assertEqual(list(self.hub.members["coder"]["inbox"]),[])
        self.hub.register("coder","DeepSeek","coder")
        self.assertFalse(self.hub.status("coder")["self"]["ready"])
        self.assertEqual(len([e for e in self.hub.events if e["kind"]=="expired"]),1)

    def test_inactive_room_history_is_bounded(self):
        hub=TeamHub()
        for i in range(140):
            room="room-"+str(i)
            for role in ("planner","coder","checker"):hub.register(role,role,role,room)
            hub.start(room)
            hub.stop(room)
        self.assertLessEqual(len(hub.teams),128)

    def test_registration_is_not_communication(self):
        s = self.hub.status("planner")
        self.assertFalse(s["communication_confirmed"])
        self.assertIn("not directly communicating", s["phrase"])

    def test_missing_role_does_not_fake_start(self):
        hub = TeamHub()
        hub.register("a", "Claude", "planner")
        with self.assertRaises(TeamError):
            hub.start("studio")

    # ── 4.8.0: two or more agents form a team and chat in a fixed order ─────
    def test_one_agent_is_not_a_team(self):
        hub = TeamHub()
        hub.register("a", "Claude", "planner")
        with self.assertRaises(TeamError) as caught:
            hub.start("studio")
        self.assertIn("at least 2", str(caught.exception))

    def test_two_agents_form_a_team_with_a_derived_order(self):
        hub = TeamHub()
        hub.register("p", "Claude", "planner")
        hub.register("c", "DeepSeek", "coder")
        result = hub.start("studio")
        self.assertTrue(result["ok"])
        self.assertEqual(result["roles"], ["planner", "coder"])
        self.assertEqual(result["introduction_order"], ["planner", "coder"])
        self.assertEqual(hub.status("p")["team_roles"], ["planner", "coder"])

    def test_two_agent_team_introduces_in_order_and_then_collaborates(self):
        hub = TeamHub()
        hub.register("p", "Claude", "planner")
        hub.register("c", "DeepSeek", "coder")
        hub.start("studio")
        hub.ready("p")
        hub.ready("c")
        # the planner holds the first turn; the coder must wait for it
        self.assertEqual(hub.status("p")["introduction_turn"], "planner")
        with self.assertRaises(TeamError):
            hub.send("c", "all", "Too early", "c-early")
        hub.send("p", "all", "Hi, I am the planner", "p1")
        self.assertEqual(hub.status("p")["introduction_turn"], "coder")
        hub.send("c", "all", "Hi, I am the coder", "c1")
        self.assertIsNone(hub.status("p")["introduction_turn"])
        self.assertEqual([e["role"] for e in hub.events if e["kind"] == "message"], ["planner", "coder"])
        # the coordinator now drives plan -> implement
        self.assertEqual(hub.status("p")["phase"], "plan")
        self.assertTrue(any(m.get("control") == "plan" for m in hub.inbox("p")["messages"]))
        hub.send("p", "coder", "Plan: build StageService. Reference: local S = Instance.new('Folder')", "p2")
        self.assertEqual(hub.status("p")["phase"], "implement")
        self.assertTrue(any(m.get("control") == "implement" for m in hub.inbox("c")["messages"]))

    def test_checker_reports_defects_to_the_coder_without_editing(self):
        hub = TeamHub()
        for name, role in (("Claude", "planner"), ("DeepSeek", "coder"), ("Gemini", "checker")):
            hub.register(role, name, role)
        hub.start("studio")
        for role in ("planner", "coder", "checker"):
            hub.ready(role)
        hub.send("planner", "all", "Hi, I am the planner", "p1")
        hub.send("coder", "all", "Hi, I am the coder", "c1")
        hub.send("checker", "all", "Hi, I am the checker", "k1")
        hub.send("planner", "coder", "Plan with reference code", "p2")
        hub.send("coder", "checker", "Implemented StageService, verified with get_studio_state", "c2")
        self.assertEqual(hub.status("planner")["phase"], "review")
        self.assertTrue(any(m.get("control") == "review" for m in hub.inbox("checker")["messages"]))
        hub.send("checker", "coder", "Defect: StageService has no WaitForChild. Fix: add it at line 12", "k2")
        self.assertEqual(hub.status("planner")["phase"], "fix")
        self.assertTrue(any(m.get("control") == "fix" for m in hub.inbox("coder")["messages"]))
        # the checker never mutates Studio - only the coder does
        self.assertFalse(hub.can_mutate_studio("checker"))
        self.assertTrue(hub.can_mutate_studio("coder"))

    def test_relayed_user_request_does_not_consume_the_introduction_turn(self):
        hub = TeamHub()
        hub.register("p", "Claude", "planner")
        hub.register("c", "DeepSeek", "coder")
        hub.start("studio")
        hub.ready("p")
        hub.ready("c")
        # the extension relays the user's own request; it is not an introduction
        hub.send("p", "all", "[USER REQUEST from Claude] build a tycoon game", "r1", kind="request")
        self.assertEqual(hub.status("p")["introduction_turn"], "planner")
        self.assertEqual(hub.status("p")["phase"], "introducing")
        hub.send("p", "all", "Hi, I am the planner", "p1")
        self.assertEqual(hub.status("p")["introduction_turn"], "coder")

    def test_chat_transcript_contains_only_real_messages(self):
        hub = TeamHub()
        hub.register("p", "Claude", "planner")
        hub.register("c", "DeepSeek", "coder")
        hub.start("studio")
        hub.ready("p")
        hub.ready("c")
        hub.send("p", "all", "Hello coder, real message", "1")
        chat = hub.chat("studio")
        self.assertEqual([m["text"] for m in chat["messages"]], ["Hello coder, real message"])
        self.assertEqual(chat["messages"][0]["name"], "Claude")
        self.assertEqual(chat["messages"][0]["recipient"], "all")
        self.assertEqual(sorted(m["role"] for m in chat["members"]["studio"]), ["coder", "planner"])

    def test_silent_introduction_is_re_asked_then_skipped(self):
        now = [100.0]
        # A long TTL: the tabs stay alive (they heartbeat) but the PLANNER never
        # speaks, so the coordinator must escalate and then move on.
        hub = TeamHub(ttl=600, clock=lambda: now[0], intro_timeout=90.0, intro_retry=10.0)
        hub.register("p", "Claude", "planner")
        hub.register("c", "DeepSeek", "coder")
        hub.start("studio")
        hub.ready("p")
        hub.ready("c")
        now[0] += 20
        hub.status("p")
        kinds = [e["kind"] for e in hub.events]
        self.assertIn("intro_nudge", kinds)
        self.assertTrue(any(m.get("control") == "introduce" and "Still your introduction turn" in m["text"]
                            for m in hub.inbox("p")["messages"]))
        now[0] += 120
        hub.status("p")
        self.assertIn("turn_skipped", [e["kind"] for e in hub.events])
        self.assertEqual(hub.status("p")["introduction_turn"], "coder")

    def test_duplicate_role_rejected(self):
        with self.assertRaises(TeamError):
            self.hub.register("another", "ChatGPT", "planner")

    def test_introductions_are_ordered(self):
        self.start()
        self.assertEqual(self.hub.inbox("planner")["messages"][0]["control"], "introduce")
        with self.assertRaises(TeamError):
            self.hub.send("checker", "all", "Early", "x")
        for role in ("planner", "coder", "checker"):
            self.hub.send(role, "all", f"Hello, I am the {role}", role)
        actual = [e["role"] for e in self.hub.events if e["kind"] == "message"]
        self.assertEqual(actual, ["planner", "coder", "checker"])
        self.assertIsNone(self.hub.status("planner")["introduction_turn"])

    def test_delivery_is_not_invented_and_peer_specific(self):
        self.start()
        self.hub.send("planner", "coder", "Hello coder", "1")
        self.assertFalse(self.hub.status("planner")["communication_confirmed"])
        self.assertFalse(self.hub.status("checker")["communication_confirmed"])
        inbox = self.hub.inbox("coder")["messages"]
        self.hub.ack("coder", [m["id"] for m in inbox])
        status = self.hub.status("planner")
        self.assertTrue(status["communication_confirmed"])
        self.assertIn("DeepSeek", status["phrase"])
        self.assertNotIn("Gemini", status["phrase"])
        self.assertFalse(self.hub.status("checker")["communication_confirmed"])
        self.assertTrue(self.hub.ack("coder", [m["id"] for m in inbox])["ok"])

    def test_message_idempotency_and_collision(self):
        self.start()
        first = self.hub.send("planner", "all", "Hello", "one")
        again = self.hub.send("planner", "all", "Hello", "one")
        self.assertEqual(first, again)
        self.assertEqual(len([e for e in self.hub.events if e["kind"] == "message"]), 1)
        with self.assertRaises(TeamError):
            self.hub.send("planner", "all", "Different", "one")

    def test_team_isolation(self):
        self.hub.register("other", "ChatGPT", "planner", "other-room")
        self.start()
        self.hub.send("planner", "all", "Only studio", "1")
        self.assertEqual(self.hub.inbox("other")["messages"], [])

    def test_stale_members_are_not_claimed_online(self):
        self.start()
        self.now += 46
        with self.assertRaises(TeamError):
            self.hub.status("planner")
        self.hub.register("planner", "Claude", "planner")
        self.assertEqual(self.hub.status("planner")["peers"], [])

    def test_stop_clears_mailboxes(self):
        self.start()
        self.hub.send("planner", "all", "Hello", "1")
        self.hub.stop("studio")
        self.assertEqual(self.hub.inbox("coder")["messages"], [])
        with self.assertRaises(TeamError):
            self.hub.send("planner", "all", "No", "2")

    def test_leaving_stops_team_and_clears_queued_messages(self):
        self.start()
        self.hub.leave("coder")
        self.assertFalse(self.hub.status("planner")["active"])
        self.assertEqual(self.hub.inbox("checker")["messages"], [])

    def test_limits_and_restart_cursor(self):
        self.start()
        with self.assertRaises(TeamError):
            self.hub.send("planner", "all", "x" * 12001, "1")
        with self.assertRaises(TeamError):
            self.hub.ack("planner", ["not-an-integer"])
        self.assertTrue(TeamHub().event_log(999)["reset"])
        log = self.hub.event_log(99999)
        self.assertTrue(log["reset"])
        self.assertTrue(all("timestamp" in e for e in self.hub.events))



    def test_role_mutation_permissions_and_violation_events(self):
        self.start()
        self.assertFalse(self.hub.can_mutate_studio("planner"))
        self.assertTrue(self.hub.can_mutate_studio("coder"))
        self.assertFalse(self.hub.can_mutate_studio("checker"))
        ev = self.hub.record_violation("planner", "execute_luau", "planner must not code")
        self.assertIsNotNone(ev)
        self.assertEqual(ev["kind"], "role_violation")

    def test_wait_events_wakes_immediately_on_condition_notify(self):
        import time as _t
        self.start()
        cur = self.hub.event_log(0)["cursor"]
        def delayed_send():
            _t.sleep(0.03)
            self.hub.send("planner", "all", "Wake console fast", "w1")
        t = threading.Thread(target=delayed_send, daemon=True)
        t.start()
        t0 = _t.monotonic()
        res = self.hub.wait_events(cur, timeout=2.0)
        elapsed = _t.monotonic() - t0
        self.assertTrue(any(e["kind"] == "message" for e in res["events"]))
        self.assertLess(elapsed, 0.5)

    def test_summary_reports_team_and_member_counts(self):
        self.start()
        sm = self.hub.summary("studio")
        self.assertTrue(sm["ok"])
        self.assertIn("studio", sm["teams"])
        self.assertEqual(len(sm["teams"]["studio"]["members"]), 3)


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.env = patch.dict(os.environ, {"ZS_DATA_DIR": cls.temp.name, "ZS_BRIDGE_HTTP_PORT": "0", "ZS_NO_AUTH": "0"})
        cls.env.start()
        cls.b = importlib.import_module("bridge")
        cls.server = cls.b._start_http_server()
        cls.url = "http://127.0.0.1:" + str(cls.server.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        if cls.b._log_file:
            cls.b._log_file.close()
        cls.env.stop()
        cls.temp.cleanup()

    def request(self, path, data=None, auth=True, headers=None):
        hdr = {"X-ZS-Token": self.b.BRIDGE_TOKEN} if auth else {}
        hdr.update(headers or {})
        if data is not None:
            hdr["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=json.dumps(data).encode() if data is not None else None, headers=hdr)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r), dict(r.headers)
        except urllib.error.HTTPError as r:
            return r.code, json.load(r), dict(r.headers)

    def test_missing_token_rejected(self):
        self.assertEqual(self.request("/api/tools", auth=False)[0], 401)
        self.assertEqual(self.request("/api/call", {"name": "danger"}, auth=False)[0], 401)

    def test_health_without_token(self):
        self.assertEqual(self.request("/health", auth=False)[0], 200)

    def test_web_origin_and_token_bootstrap(self):
        self.assertEqual(self.request("/api/token", auth=False)[0], 403)
        self.assertEqual(self.request("/api/token", auth=False, headers={"Origin": "https://evil.example", "X-ZS-Client": "extension"})[0], 403)
        code, result, headers = self.request("/api/token", auth=False, headers={"Origin": "chrome-extension://" + "a" * 32, "X-ZS-Client": "extension"})
        self.assertEqual(code, 200)
        self.assertEqual(result["token"], self.b.BRIDGE_TOKEN)
        self.assertNotEqual(headers.get("Access-Control-Allow-Origin"), "*")

    def test_bad_json_shape(self):
        self.assertEqual(self.request("/api/call", [1, 2])[0], 400)
        self.assertEqual(self.request("/api/call", {"name": "x", "timeout": "nan"})[0], 400)

    def test_batch_limit_rejects_before_any_execution(self):
        with patch.object(self.b, "safe_call") as call:
            self.assertEqual(self.request("/api/batch", {"calls": [{"name": "x"}] * 25})[0], 400)
            call.assert_not_called()

    def test_batch_partial_failure_preserves_results(self):
        with patch.object(self.b, "safe_call", side_effect=[{"ok": True}, {"ok": False, "error": "bad"}]):
            code, result, _ = self.request("/api/batch", {"calls": [{"name": "x"}, {"name": "y"}]})
        self.assertEqual(code, 200)
        self.assertFalse(result["ok"])
        self.assertFalse(result["atomic"])
        self.assertEqual(len(result["results"]), 2)

    def test_is_error_and_unknown_outcome_not_replayed(self):
        c = self.b.MCPClient("mock", "unused", [])
        c.is_alive = lambda: True
        with patch.object(c, "_request", return_value={"result": {"isError": True, "content": [{"type": "text", "text": "denied"}]}}):
            with self.assertRaisesRegex(RuntimeError, "denied"):
                c.call_tool("write", {}, 1)
        with patch.object(c, "_request", return_value=None) as req:
            with self.assertRaises(TimeoutError):
                c.call_tool("write", {}, 1)
            self.assertEqual(req.call_count, 1)

    def test_server_metadata(self):
        manager = self.b.MCPManager()
        c = self.b.MCPClient("blender", "unused", [])
        c.tools_cache = [{"name": "inspect", "inputSchema": {}}]
        manager.clients = {"blender": c}
        manager.rebuild_index()
        self.assertEqual(manager.list_tools()[0]["server"], "blender")

    def test_parallel_config_updates(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.b.config_add_server(f"addon{i}", "unused", [], {}), range(8)))
        self.assertTrue(all(r[0] for r in results))
        with open(self.b.CONFIG_PATH) as f:
            cfg = json.load(f)
        self.assertTrue(all(f"addon{i}" in cfg["mcpServers"] for i in range(8)))

    def test_recovery_never_kills_unknown_processes(self):
        with patch.object(self.b.subprocess, "run") as run:
            self.b._kill_orphan_studio_mcp()
            self.b._kill_port_squatter()
            self.b._reclaim_studio_port(None)
            run.assert_not_called()

    def test_retained_main_agent_temp_http(self):
        code,written,_=self.request("/api/agent_temp",{"key":"integration","value":{"hello":"main"},"ttl":10000})
        self.assertEqual(code,200)
        self.assertTrue(written["ok"])
        code,result,_=self.request("/api/agent_temp?key=integration")
        self.assertEqual(code,200)
        self.assertEqual(result["value"],{"hello":"main"})

    def test_team_http_routes_and_console_real_messages(self):
        for role,name in (("planner","Claude"),("coder","DeepSeek"),("checker","Gemini")):
            code,result,_=self.request("/api/team/register",{"member_id":"http-"+role,"name":name,"role":role,"team":"http-team"})
            self.assertEqual(code,200)
            self.assertEqual(result["self"]["role"],role)
        self.assertTrue(self.request("/api/team/start",{"team":"http-team"})[1]["ok"])
        for role in ("planner","coder","checker"):
            self.assertTrue(self.request("/api/team/ready",{"member_id":"http-"+role})[1]["ok"])
        sent=self.request("/api/team/send",{"member_id":"http-planner","to":"coder","text":"Real planner message from test","message_id":"http-message"})
        self.assertTrue(sent[1]["ok"])
        inbox=self.request("/api/team/inbox",{"member_id":"http-coder"})[1]
        self.assertEqual(inbox["messages"][0]["from"],"Claude")
        self.request("/api/team/ack",{"member_id":"http-coder","ids":[e["id"] for e in inbox["messages"]]})
        status=self.request("/api/team/status",{"member_id":"http-planner"})[1]
        self.assertTrue(status["communication_confirmed"])
        env={**os.environ,"ZS_BRIDGE_HTTP_PORT":str(self.server.server_address[1])}
        console=subprocess.run([sys.executable,str(SOURCE/"team_console.py"),"--once"],env=env,capture_output=True,text=True,timeout=5)
        self.assertEqual(console.returncode,0,console.stderr)
        self.assertIn("Real planner message from test",console.stdout)
        self.assertIn("(Planner):[Claude]:",console.stdout)
        self.assertIn("+00:00",console.stdout)
        self.assertNotIn("Nice to meet you",console.stdout) # viewer cannot invent an AI reply
        self.request("/api/team/stop",{"team":"http-team"})

    def test_two_agent_team_over_http_and_the_bare_chat_endpoint(self):
        for role, name in (("planner", "Claude"), ("coder", "DeepSeek")):
            code, result, _ = self.request("/api/team/register", {"member_id": "two-" + role, "name": name, "role": role, "team": "two-team"})
            self.assertEqual(code, 200)
        started = self.request("/api/team/start", {"team": "two-team"})[1]
        self.assertTrue(started["ok"])
        self.assertEqual(started["roles"], ["planner", "coder"])
        self.assertEqual(started["introduction_order"], ["planner", "coder"])
        for role in ("planner", "coder"):
            self.request("/api/team/ready", {"member_id": "two-" + role})
        self.request("/api/team/send", {"member_id": "two-planner", "to": "all", "text": "Hello from the planner", "message_id": "two-1"})
        code, chat, _ = self.request("/api/team/chat?team=two-team")
        self.assertEqual(code, 200)
        self.assertEqual([m["text"] for m in chat["messages"]], ["Hello from the planner"])
        self.assertEqual(chat["messages"][0]["name"], "Claude")
        self.assertEqual(len(chat["members"]["two-team"]), 2)
        # the relayed user request is a real message and does NOT consume an
        # introduction turn
        before = self.request("/api/team/status", {"member_id": "two-planner"})[1]["introduction_turn"]
        self.request("/api/team/send", {"member_id": "two-planner", "to": "all", "text": "[USER REQUEST] build it", "message_id": "two-2", "kind": "request"})
        after = self.request("/api/team/status", {"member_id": "two-planner"})[1]
        self.assertEqual(after["introduction_turn"], before)
        self.request("/api/team/stop", {"team": "two-team"})

    def test_websocket_auth_and_batch_request_id(self):
        async def check():
            import websockets
            async with websockets.serve(self.b.handler, "127.0.0.1", 0) as server:
                port = server.sockets[0].getsockname()[1]
                async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                    with self.assertRaises(websockets.exceptions.ConnectionClosed):
                        await ws.recv()
                with patch.object(self.b, "safe_call", return_value={"ok": True, "text": "actual result"}):
                    async with websockets.connect(f"ws://127.0.0.1:{port}/?token={self.b.BRIDGE_TOKEN}") as ws:
                        hello = json.loads(await ws.recv())
                        self.assertNotIn("token", hello)
                        await ws.send(json.dumps({"type": "batch", "id": 1, "calls": [{"name": "x"}]}))
                        await ws.send(json.dumps({"type": "ping", "id": 2}))
                        while True:
                            result = json.loads(await asyncio.wait_for(ws.recv(), 3))
                            if result["type"] == "batch_result":
                                self.assertEqual(result["id"], 1)
                                break
        asyncio.run(check())



    def test_role_enforcement_on_call_batch_and_studio_exec_plus_verify(self):
        for role, name in (("planner", "Claude"), ("coder", "DeepSeek"), ("checker", "Gemini")):
            self.assertEqual(self.request("/api/team/register", {"member_id": "rg-" + role, "name": name, "role": role, "team": "rg-team"})[0], 200)
        self.assertTrue(self.request("/api/team/start", {"team": "rg-team"})[1]["ok"])
        for role in ("planner", "coder", "checker"):
            self.assertTrue(self.request("/api/team/ready", {"member_id": "rg-" + role})[1]["ok"])
        # Planner and checker are blocked from execute_luau & /api/studio/exec
        c1, r1, _ = self.request("/api/call", {"name": "execute_luau", "arguments": {"code": "return 1"}, "member_id": "rg-planner"})
        self.assertEqual(c1, 200)
        self.assertFalse(r1["ok"])
        self.assertEqual(r1["kind"], "role_violation")
        c2, r2, _ = self.request("/api/studio/exec", {"code": "return 1", "member_id": "rg-checker"})
        self.assertEqual(c2, 403)
        self.assertEqual(r2["kind"], "role_violation")
        # Virtual team_send works through /api/call!
        c3, r3, _ = self.request("/api/call", {"name": "team_send", "arguments": {"to": "coder", "text": "Implement StageService", "message_id": "rg-m1"}, "member_id": "rg-planner"})
        self.assertEqual(c3, 200)
        self.assertTrue(r3["ok"])
        # /api/team/summary shows active room (requires token auth!)
        self.assertEqual(self.request("/api/team/summary?team=rg-team", auth=False)[0], 401)
        cs, rs, _ = self.request("/api/team/summary?team=rg-team")
        self.assertEqual(cs, 200)
        self.assertTrue(rs["teams"]["rg-team"]["active"])
        # /api/verify returns deterministic verification payload with sha256 when mocked
        with patch.object(self.b, "safe_call", return_value={"ok": True, "text": '{"Name":"Workspace","Gravity":196.2}'}):
            cv, rv, _ = self.request("/api/verify", {"path": "game.Workspace", "tool": "inspect_instance"})
            self.assertEqual(cv, 200)
            self.assertTrue(rv["verified"])
            self.assertEqual(len(rv["sha256"]), 64)
        self.request("/api/team/stop", {"team": "rg-team"})


if __name__ == "__main__":
    unittest.main()
