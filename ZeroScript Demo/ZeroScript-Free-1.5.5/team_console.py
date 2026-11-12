#!/usr/bin/env python3
"""Read-only timestamped bridge team console. Standard library only. 4.6.0.

4.6.0: long-poll wake (instant events, no 1s blind poll), --json output,
--status one-shot summary, exponential reconnect backoff, role-violation
and handoff highlighting.

No synthetic AI conversation is generated here. 'message' means an AI tab used
team_send. 'delivered' means the extension acknowledged chat submission, not
that a model read it. Closing this viewer does not stop the bridge.
"""
import argparse
import json
import os
import re
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request


ROLE_COLORS={"planner":"\033[94m", "coder":"\033[91m", "checker":"\033[92m"}
HANDOFF_TAGS={"plan":"[PLAN]","evidence":"[EVIDENCE]","defects":"[DEFECTS]","chat":"[CHAT]",
              "intro":"[INTRO]","request":"[REQUEST]"}


def enable_colors():
    if os.environ.get("NO_COLOR") is not None or not sys.stdout.isatty():
        return False
    if os.name=="nt":
        try:
            import ctypes
            kernel=ctypes.windll.kernel32
            handle=kernel.GetStdHandle(-11)
            mode=ctypes.c_ulong()
            if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
                return False
            if not kernel.SetConsoleMode(handle, mode.value | 0x0004):
                return False
        except (AttributeError, OSError):
            return False
    return True


def format_event(event, color=False):
    role=str(event.get("role", "control")).lower()
    who=event.get("name", "Bridge coordinator")
    recipient=f" -> {event['recipient']}" if event.get("recipient") else ""
    handoff=HANDOFF_TAGS.get(event.get("handoff"), "")
    if event.get("kind")=="role_violation":
        handoff="[ROLE-BLOCKED]"
    text=event.get("text", "") if event.get("kind")!="queued" else "Message queued; waiting for recipient submission."
    # Strip untrusted terminal controls before adding our own ANSI colors.
    htag=f" {handoff}" if handoff else ""
    line=f"{event.get('timestamp', '')} [{event.get('team', 'studio')}] ({role.title()}):[{who}]:{recipient}{htag} ({event.get('kind', 'event')}): {text}"
    line=re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", line)
    return ROLE_COLORS[role]+line+"\033[0m" if color and role in ROLE_COLORS else line


def format_summary(data):
    teams = data.get("teams", {}) if isinstance(data, dict) else {}
    parts = []
    items = teams.items() if isinstance(teams, dict) else [(t.get("team", "?"), t) for t in teams if isinstance(t, dict)]
    for tname, info in items:
        active = "active" if info.get("active") else "idle"
        run = info.get("run") if "run" in info else info.get("run_id")
        order = " → ".join(info.get("introduction_order") or []) or "?"
        phase = info.get("phase") or "?"
        mems = ", ".join(
            f"{m.get('role','?')}:{m.get('name','?')}({'ready' if m.get('ready') else 'joined'})"
            for m in info.get("members", [])
        ) or "none"
        parts.append(f"team={tname} ({active}, run={run}, order={order}, phase={phase}) [{mems}]")
    return " | ".join(parts) if parts else "no active teams"


def select_events(events, team=None, role=None, kind=None, tail=None):
    selected=[e for e in events if (not team or e.get('team')==team)
              and (not role or e.get('role')==role) and (not kind or e.get('kind')==kind)]
    return selected[-tail:] if tail else selected


def tail_count(value):
    number=int(value)
    if not 1<=number<=1000: raise argparse.ArgumentTypeError('tail must be between 1 and 1000')
    return number


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Print available events and exit")
    parser.add_argument("--team", help="Show only this exact team name")
    parser.add_argument("--role", choices=["planner","coder","checker","control"], help="Filter by event role")
    parser.add_argument("--kind", help="Filter event kind, e.g. message or delivered")
    parser.add_argument("--tail", type=tail_count, help="Show only the last N matching historical events, then follow new ones")
    parser.add_argument("--no-color", action="store_true", help="Disable role colors")
    parser.add_argument("--json", action="store_true", help="Emit one JSON object per event (machine-readable)")
    parser.add_argument("--status", action="store_true", help="Print a one-shot event summary and exit")
    parser.add_argument("--interval", type=float, default=1.0, help="Fallback poll interval in seconds (long-poll wakes sooner)")
    args = parser.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    root = Path(os.environ.get("ZS_DATA_DIR", Path(__file__).resolve().parent))
    port = int(os.environ.get("ZS_BRIDGE_HTTP_PORT", str(int(os.environ.get("ZS_BRIDGE_PORT", "17613")) + 1)))
    color=not args.no_color and enable_colors()
    initial=True
    cursor = 0
    waiting = False
    backoff = args.interval
    seen_kinds = {}
    print("ZeroScript Team Console — real bridge events, UTC timestamps", flush=True)
    print("Join the other agents in the extension popup (at least two tabs), then press Start team.")
    print("No model APIs are called. A registered tab is not proof of communication.\n", flush=True)
    while True:
        try:
            token = (root / ".zs_token").read_text(encoding="utf-8").strip()
            wait_qs = "" if (args.once or args.status or initial) else "&wait=1"
            request = urllib.request.Request(f"http://127.0.0.1:{port}/api/team/events?since={cursor}{wait_qs}", headers={"X-ZS-Token": token})
            with urllib.request.urlopen(request, timeout=8) as response:
                result = json.load(response)
            backoff = args.interval
            if result.get("reset"):
                cursor = 0
                print("[Bridge restarted; reconnecting to the new event stream]", flush=True)
                continue
            if result.get("truncated"):
                print("[Older events expired from the bounded log]", flush=True)
            if waiting:
                print("[Connected to bridge]", flush=True)
                waiting = False
            for event in select_events(result.get("events", []), args.team, args.role, args.kind, args.tail if initial else None):
                seen_kinds[event.get("kind", "event")] = seen_kinds.get(event.get("kind", "event"), 0) + 1
                if args.json:
                    print(json.dumps(event, ensure_ascii=False), flush=True)
                else:
                    print(format_event(event, color), flush=True)
            initial=False
            cursor = result.get("cursor", cursor)
            if args.status:
                teams_info = {}
                try:
                    sreq = urllib.request.Request(f"http://127.0.0.1:{port}/api/team/summary", headers={"X-ZS-Token": token})
                    with urllib.request.urlopen(sreq, timeout=3) as sresp:
                        teams_info = json.load(sresp).get("teams", {})
                except (OSError, ValueError, urllib.error.URLError):
                    pass
                print(f"Summary: cursor={cursor} events={seen_kinds} {format_summary({'teams': teams_info})}", flush=True)
                return 0
            if args.once:
                return 0
            time.sleep(0.02)
            continue
        except (OSError, ValueError, urllib.error.URLError) as exc:
            if args.once or args.status:
                print(f"Bridge unavailable: {exc}", file=sys.stderr)
                return 1
            if not waiting:
                print("[Waiting for bridge. Check start.py if this persists.]", flush=True)
                waiting = True
            time.sleep(backoff)
            backoff = min(backoff * 2, 5.0)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nViewer closed; bridge continues running.")
