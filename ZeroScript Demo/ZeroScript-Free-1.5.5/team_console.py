#!/usr/bin/env python3
"""Read-only timestamped bridge team console. Standard library only.

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
    text=event.get("text", "") if event.get("kind")!="queued" else "Message queued; waiting for recipient submission."
    # Strip untrusted terminal controls before adding our own ANSI colors.
    line=f"{event.get('timestamp', '')} [{event.get('team', 'studio')}] ({role.title()}):[{who}]:{recipient} ({event.get('kind', 'event')}): {text}"
    line=re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", line)
    return ROLE_COLORS[role]+line+"\033[0m" if color and role in ROLE_COLORS else line


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Print available events and exit")
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    root = Path(os.environ.get("ZS_DATA_DIR", Path(__file__).resolve().parent))
    port = int(os.environ.get("ZS_BRIDGE_HTTP_PORT", str(int(os.environ.get("ZS_BRIDGE_PORT", "17613")) + 1)))
    color=enable_colors()
    cursor = 0
    waiting = False
    print("ZeroScript Team Console — real bridge events, UTC timestamps", flush=True)
    print("Join planner, coder, checker in the extension popup, then Start team.")
    print("No model APIs are called. A registered tab is not proof of communication.\n", flush=True)
    while True:
        try:
            token = (root / ".zs_token").read_text(encoding="utf-8").strip()
            request = urllib.request.Request(f"http://127.0.0.1:{port}/api/team/events?since={cursor}", headers={"X-ZS-Token": token})
            with urllib.request.urlopen(request, timeout=4) as response:
                result = json.load(response)
            if result.get("reset"):
                cursor = 0
                print("[Bridge restarted; reconnecting to the new event stream]", flush=True)
                continue
            if result.get("truncated"):
                print("[Older events expired from the bounded log]", flush=True)
            if waiting:
                print("[Connected to bridge]", flush=True)
                waiting = False
            for event in result.get("events", []):
                print(format_event(event, color), flush=True)
            cursor = result.get("cursor", cursor)
            if args.once:
                return 0
        except (OSError, ValueError, urllib.error.URLError) as exc:
            if args.once:
                print(f"Bridge unavailable: {exc}", file=sys.stderr)
                return 1
            if not waiting:
                print("[Waiting for bridge. Check start.py if this persists.]", flush=True)
                waiting = True
        time.sleep(1)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nViewer closed; bridge continues running.")
