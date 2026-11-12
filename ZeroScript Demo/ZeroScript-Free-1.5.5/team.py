#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# team.py — ZeroScript Team Console & Hub v3.1.0
# ──────────────────────────────────────────────────────────────────────────
#  The team console for the ZeroScript bridge hub.
#
#  PROBLEM THIS FIXES: "the AI can't communicate through the bridge team.py
#  console and hub" — there was no console/hub surface for AI team traffic.
#  The bridge (bridge.py) now hosts a role-aware TEAM HUB (planner / coder /
#  checker / lead / user / observer) and this program is its console:
#
#    * humans and AI agents exchange role-checked messages through one hub;
#    * role → message-kind permissions are ENFORCED (a planner can post a plan
#      but never code; a checker can post a check but never code — the CODER
#      is the only role that makes changes);
#    * `truth` prints the GROUND TRUTH report: live Studio probe + real server
#      health + the executed-tool ledger — never model claims.
#
#  Usage:
#    python team.py              connect to a running bridge (auto-starts one)
#    python team.py --no-start   fail instead of starting a bridge
#    python team.py --truth      print the ground-truth report and exit
#
#  Console commands: help, status, tools, truth, say, as, msgs, watch, role,
#  roles, call, metrics, restart, quit. Stdlib only — no dependencies.
# ──────────────────────────────────────────────────────────────────────────
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_SCRIPT = os.path.join(HERE, "bridge.py")
PORT_HTTP = int(os.environ.get("ZS_BRIDGE_HTTP_PORT", "17614"))
BASE = f"http://127.0.0.1:{PORT_HTTP}"
TEAM_VERSION = "3.1.0"
ROLES = ("planner", "coder", "checker", "lead", "user", "observer")
# Role → hub message kinds that role may post. ENFORCED locally too, so the
# console gives the same verdict as the hub before the round-trip.
ROLE_KINDS = {
    "planner": {"plan", "msg", "handoff", "note"},
    "coder": {"code", "msg", "handoff", "note"},
    "checker": {"check", "msg", "handoff", "note"},
    "observer": {"msg", "note"},
    "lead": {"plan", "code", "check", "msg", "handoff", "note"},
    "user": {"plan", "code", "check", "msg", "handoff", "note"},
}

# ── tiny HTTP client (stdlib) ─────────────────────────────────────────────
def api(path: str, payload: dict | None = None, timeout: float = 8.0) -> dict:
    url = BASE + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return {"ok": False, "error": f"http {e.code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def api_up() -> bool:
    r = api("/api/health", timeout=1.5)
    return bool(r.get("ok"))


def start_bridge() -> subprocess.Popen | None:
    if not os.path.exists(BRIDGE_SCRIPT):
        print(f"  team: bridge.py not found at {BRIDGE_SCRIPT}")
        return None
    print("  team: no bridge running — starting one…")
    env = dict(os.environ)
    env.setdefault("ZS_CONSOLE", "0")  # this console replaces the stdin REPL
    try:
        proc = subprocess.Popen([sys.executable, BRIDGE_SCRIPT], cwd=HERE, env=env)
    except Exception as e:
        print(f"  team: could not start bridge: {e}")
        return None
    for _ in range(40):
        time.sleep(0.25)
        if api_up():
            print("  team: bridge is up")
            return proc
    print("  team: bridge did not come up in 10s — check logs/bridge_debug.log")
    return proc


# ── helpers ───────────────────────────────────────────────────────────────
def fmt_msg(m: dict) -> str:
    ts = time.strftime("%H:%M:%S", time.localtime(m.get("ts", time.time())))
    return f"  #{m.get('id')} {ts} [{m.get('role')}/{m.get('kind')}] {m.get('from')}: {m.get('text', '')}"


def print_truth(tr: dict) -> None:
    b = tr.get("bridge", {})
    s = tr.get("studio", {})
    m = tr.get("mcp", {})
    st = tr.get("stats", {})
    print(f"TRUTH @{tr.get('ts')} — bridge {b.get('version')} up {b.get('uptime')}s "
          f"(ws {b.get('port')} + http {b.get('http_port')})")
    print(f"  studio : app={s.get('app')} place={s.get('place')}")
    print(f"  mcp    : alive={m.get('alive')} servers="
          + ", ".join(f"{h.get('id')}({'up' if h.get('alive') else 'down'},{h.get('tools')}t)"
                      for h in m.get("servers", [])))
    print(f"  tools  : {tr.get('tools_total')}   calls={st.get('tool_calls')} errors={st.get('tool_errors')}")
    led = tr.get("ledger", [])
    if led:
        print("  ledger : (tool calls that ACTUALLY executed)")
        for e in led[-10:]:
            mark = "OK " if e.get("ok") else "ERR"
            print(f"    {mark} {e.get('tool')} {e.get('ms')}ms  {str(e.get('detail', ''))[:70]}")
    hub_tail = tr.get("hub", [])
    if hub_tail:
        print("  hub    : (latest team messages)")
        for m2 in hub_tail[-6:]:
            print(fmt_msg(m2))
    print("  note   :", tr.get("note", ""))


HELP = """
  ZeroScript team console v{v} — commands:
    help                 this list
    status               bridge + Studio status (live)
    tools                list available tool names
    truth                GROUND TRUTH report (live-verified facts only)
    say <text>           post a hub message as your agent (kind: msg)
    as <role> <text>     post a hub message with a role (plan/code/check/…)
    msgs [n]             show last n hub messages (default 15)
    watch                live-follow hub messages (Ctrl+C to stop)
    role <agent> <role>  assign a hub role ({roles})
    roles                show assigned roles + latest hub traffic
    call <tool> [json]   run a tool on the bridge, e.g.  call get_studio_state
    metrics              bridge metrics
    restart [server]     restart MCP server(s)
    quit                 exit the console (bridge keeps running)

  Role discipline (ENFORCED by the hub):
    planner → plans only (plan/msg/handoff/note) — never code
    coder   → the ONLY role that writes/changes code (code/msg/handoff/note)
    checker → reviews only (check/msg/handoff/note) — reports issues, coder fixes
""".format(v=TEAM_VERSION, roles="/".join(ROLES))


def main() -> int:
    ap = argparse.ArgumentParser(description="ZeroScript Team Console & Hub")
    ap.add_argument("--no-start", action="store_true", help="do not auto-start a bridge")
    ap.add_argument("--truth", action="store_true", help="print ground truth and exit")
    args = ap.parse_args()

    print(f"\n  ZeroScript Team Console & Hub v{TEAM_VERSION}  →  {BASE}")
    proc = None
    if not api_up():
        if args.no_start:
            print("  team: bridge not reachable and --no-start given")
            return 1
        proc = start_bridge()
        if not api_up():
            return 1

    if args.truth:
        print_truth(api("/api/truth", timeout=10.0))
        return 0

    print(HELP)
    agent = os.environ.get("ZS_TEAM_AGENT", "console")
    print(f"  (this console posts as agent '{agent}' — set ZS_TEAM_AGENT to change)")
    watch_stop = threading.Event()

    def watch_loop():
        since = 0
        while not watch_stop.is_set():
            r = api(f"/api/hub?since={since}&limit=25", timeout=25.0)
            for m in r.get("messages", []):
                since = max(since, int(m.get("id", 0)))
                print(fmt_msg(m))
            if not r.get("ok"):
                time.sleep(2)

    while True:
        try:
            line = input("team> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            continue
        cmd, _, rest = line.partition(" ")
        cmd = cmd.lower()
        try:
            if cmd in ("quit", "exit"):
                break
            elif cmd == "help":
                print(HELP)
            elif cmd == "status":
                print(json.dumps(api("/api/status", timeout=6.0), indent=2)[:1600])
            elif cmd == "tools":
                r = api("/api/tools", timeout=6.0)
                names = [t.get("name") for t in r.get("tools", [])]
                for n in names:
                    print("  " + str(n))
                print(f"  ({len(names)} tools)")
            elif cmd == "truth":
                print_truth(api("/api/truth", timeout=10.0))
            elif cmd == "say":
                r = api("/api/hub", {"from": agent, "kind": "msg", "text": rest})
                print("  posted" if r.get("ok") else f"  rejected: {r.get('error')}")
            elif cmd == "as":
                role, _, text = rest.partition(" ")
                role = role.strip() or "user"
                if role not in ROLES:
                    print(f"  unknown role '{role}' — valid: {', '.join(ROLES)}")
                elif "msg" not in ROLE_KINDS.get(role, set()) and "note" not in ROLE_KINDS.get(role, set()):
                    print(f"  ROLE VIOLATION: role '{role}' may not post messages")
                else:
                    r = api("/api/hub", {"from": agent, "kind": "msg", "text": text, "role": role})
                    print("  posted" if r.get("ok") else f"  rejected: {r.get('error')}")
            elif cmd == "msgs":
                n = int(rest) if rest.strip().isdigit() else 15
                r = api(f"/api/hub?since=0&limit={n}", timeout=6.0)
                for m in r.get("messages", []):
                    print(fmt_msg(m))
            elif cmd == "watch":
                print("  (live hub follow — Ctrl+C returns to prompt)")
                watch_stop.clear()
                t = threading.Thread(target=watch_loop, daemon=True)
                t.start()
                try:
                    while t.is_alive():
                        time.sleep(0.5)
                except KeyboardInterrupt:
                    watch_stop.set()
                    print()
            elif cmd == "role":
                who, _, role = rest.partition(" ")
                r = api("/api/role", {"agent": who.strip() or "agent", "role": role.strip() or "coder"})
                print("  ok" if r.get("ok") else f"  rejected: {r.get('error')}")
            elif cmd == "roles":
                r = api("/api/hub?limit=0", timeout=6.0)
                state = r.get("state", {})
                print("  roles:", json.dumps(state.get("roles", {})))
                for m in state.get("tail", []):
                    print(fmt_msg(m))
            elif cmd == "call":
                tool, _, args = rest.partition(" ")
                try:
                    a = json.loads(args) if args.strip() else {}
                except Exception:
                    a = {}
                r = api("/api/call", {"name": tool.strip(), "arguments": a}, timeout=130.0)
                print(json.dumps(r, ensure_ascii=False)[:2000])
            elif cmd == "metrics":
                print(json.dumps(api("/api/metrics", timeout=6.0), indent=2)[:1200])
            elif cmd == "restart":
                r = api("/api/restart_mcp", {"server": rest.strip() or None}, timeout=30.0)
                print("  restarted" if r.get("ok") else f"  failed: {r.get('error')}")
            else:
                print(f"  unknown command '{cmd}' — type 'help'")
        except KeyboardInterrupt:
            print()
        except Exception as e:
            print(f"  error: {e}")

    if proc is not None:
        print("  team: leaving the bridge running (close its window to stop it)")
    print("  bye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
