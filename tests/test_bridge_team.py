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

    def test_registration_is_not_communication(self):
        s = self.hub.status("planner")
        self.assertFalse(s["communication_confirmed"])
        self.assertIn("not directly communicating", s["phrase"])

    def test_missing_role_does_not_fake_start(self):
        hub = TeamHub()
        hub.register("a", "Claude", "planner")
        with self.assertRaises(TeamError):
            hub.start("studio")

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
        self.assertIn("[Claude / planner]",console.stdout)
        self.assertIn("+00:00",console.stdout)
        self.assertNotIn("Nice to meet you",console.stdout) # viewer cannot invent an AI reply
        self.request("/api/team/stop",{"team":"http-team"})

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


if __name__ == "__main__":
    unittest.main()
