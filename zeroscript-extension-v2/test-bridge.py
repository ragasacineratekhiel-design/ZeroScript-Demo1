# SPDX-License-Identifier: GPL-3.0-or-later
# test-bridge.py — lifecycle tests for the Python bridge.
# 
# These exist because the bridge cannot be exercised by reading it. Each case
# drives the real object and counts something the user would eventually feel:
# file descriptors, surviving child processes, or tool tasks still burning time
# for a socket that is already gone.
# 
# Run: python test-bridge.py   (needs `websockets`; skips the WS cases without it)
import asyncio
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_DIR = os.path.join(HERE, "..", "ZeroScript Demo", "ZeroScript-Free-1.5.5")
sys.path.insert(0, os.path.abspath(BRIDGE_DIR))

pass_n = 0
fail_n = 0


def check(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("PASS  " + name)
    else:
        fail_n += 1
        print("FAIL  " + name + (("  -> " + detail) if detail else ""))


try:
    import bridge
except SystemExit as e:  # the bridge installs a hard dependency guard
    print("SKIP  bridge import exited: " + str(e))
    sys.exit(0)
except Exception as e:
    print("SKIP  bridge import failed: " + str(e))
    sys.exit(0)

# ── 1. MCPClient.stop() must not leak descriptors or children ────────────────
child = os.path.join("/tmp", "zs_test_fake_mcp.py")
with open(child, "w", encoding="utf-8") as f:
    f.write("import sys\nfor line in sys.stdin:\n    pass\n")

client = bridge.MCPClient("probe", sys.executable, [child], None)


def open_fds():
    try:
        return len(os.listdir("/proc/self/fd"))
    except OSError:
        return -1


def child_pids():
    try:
        out = subprocess.run(["ps", "-o", "pid=,args=", "--ppid", str(os.getpid())],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    return [l for l in out.strip().splitlines() if child in l]


client.proc = subprocess.Popen([sys.executable, child], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
client.stop()
baseline = open_fds()
for _ in range(19):
    client.proc = subprocess.Popen([sys.executable, child], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    pid = client.proc.pid
    client.stop()
end = open_fds()
check("19 start/stop cycles leak no file descriptors", end - baseline <= 0,
      "descriptors %d -> %d" % (baseline, end))
check("stopped MCP child does not survive", not child_pids(),
      "leftover: " + str(child_pids()))
check("client.proc is cleared after stop", client.proc is None)

# ── 2. stop() reaps even a child that ignores terminate ─────────────────────
stubborn = os.path.join("/tmp", "zs_test_stubborn.py")
with open(stubborn, "w", encoding="utf-8") as f:
    f.write(
        "import signal, sys, time\n"
        "signal.signal(signal.SIGTERM, lambda *a: None)\n"
        "for line in sys.stdin:\n    pass\n"
    )
client2 = bridge.MCPClient("stubborn", sys.executable, [stubborn], None)
client2.proc = subprocess.Popen([sys.executable, stubborn], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
pid2 = client2.proc.pid
client2.stop()
alive = os.path.exists("/proc/%d" % pid2) if os.path.isdir("/proc") else False
check("stop() kills a child that ignores SIGTERM", not alive, "pid %d still alive" % pid2)

# ── 3. websocket connection lifecycle ───────────────────────────────────────
try:
    import websockets  # noqa: F401
    HAVE_WS = True
except Exception:
    HAVE_WS = False

if not HAVE_WS:
    print("SKIP  websocket lifecycle (websockets not installed)")
else:
    async def ws_cases():
        # tool tasks orphaned by a disconnect
        async def fake_run(ws, name, args, timeout, rid):
            await asyncio.sleep(3)

        bridge.run_tool_task = fake_run

        def live_tasks():
            n = 0
            for tasks in list(bridge._CONN_TASKS.values()):
                n += sum(1 for t in tasks if not t.done())
            return n

        ctx = await websockets.serve(bridge.handler, bridge.HOST, bridge.PORT, close_timeout=2)
        uri = "ws://%s:%s" % (bridge.HOST, bridge.PORT)
        hdr = {"X-ZS-Token": bridge.BRIDGE_TOKEN}
        ws = await websockets.connect(uri, additional_headers=hdr)
        await ws.recv()
        await ws.send(json.dumps({"type": "call_tool", "name": "slow", "arguments": {}, "id": 9, "timeout": 120000}))
        await asyncio.sleep(0.3)
        started = live_tasks()
        check("a dispatched tool task is tracked", started >= 1, "tracked %d" % started)
        await ws.close()
        await asyncio.sleep(0.5)
        check("a tool task is cancelled when its client disconnects", live_tasks() == 0,
              "%d task(s) still running for a dead socket" % live_tasks())
        check("the connection registry is emptied", len(bridge._CONN_TASKS) == 0,
              "%d group(s) left" % len(bridge._CONN_TASKS))
        check("no websocket client is left registered", len(bridge.clients) == 0,
              "%d client(s)" % len(bridge.clients))
        await ctx.__aexit__(None, None, None)

    asyncio.run(ws_cases())

# ── 4. shutdown reaches every MCP child ────────────────────────────────────
mgr = bridge.MCPManager()
mgr.clients = {"a": client, "b": client2}
client.proc = subprocess.Popen([sys.executable, child], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
client2.proc = subprocess.Popen([sys.executable, stubborn], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
mgr.stop_all()
check("stop_all() releases every configured server", not child_pids(),
      "leftover: " + str(child_pids()))

print("\n%d passed, %d failed" % (pass_n, fail_n))
sys.exit(1 if fail_n else 0)
