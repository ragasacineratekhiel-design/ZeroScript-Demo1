#!/usr/bin/env python3
"""ZeroScript launcher. No automatic installs, process killing or crash replay.

4.6.0: --status bridge/team health summary, port + config validation in
--check, console launched after bridge health (no false "waiting" noise).
4.8.0: the launcher is now a VISIBLE team surface. It prints who joined which
team and the BARE chat the agents really sent (sender, recipient, timestamp,
message text) while the bridge runs, and --status shows the same snapshot.
Nothing here invents a message: every line comes from the bridge event log.
"""
import argparse
import importlib.metadata
import json
import os
import socket
import threading
import time
import urllib.request
from pathlib import Path
import subprocess
import sys
import signal
import traceback
from datetime import datetime, timezone

VERSION = "4.8.0"
ROOT = Path(__file__).resolve().parent

# Handoff tags mirror team_console.py so both surfaces read the same way.
HANDOFF_TAGS = {
    "plan": "[PLAN]", "evidence": "[EVIDENCE]", "defects": "[DEFECTS]",
    "chat": "[CHAT]", "intro": "[INTRO]", "request": "[REQUEST]",
}


def record(message):
    """Keep startup failures available even if a double-click window closes."""
    try:
        folder=Path(os.environ.get('ZS_DATA_DIR', ROOT)) / 'logs'
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / 'start.log').open('a', encoding='utf-8') as log:
            log.write(datetime.now(timezone.utc).isoformat()+' '+str(message)+'\n')
    except OSError:
        pass  # Failure to create a diagnostic must not stop the launcher.


def local_python():
    return ROOT / '.venv' / ('Scripts/python.exe' if os.name=='nt' else 'bin/python')


def install_dependencies():
    import venv
    target=local_python()
    if not target.is_file():
        venv.EnvBuilder(with_pip=True).create(ROOT / '.venv')
    subprocess.run([str(target), '-m', 'pip', 'install', 'websockets>=13,<16'], check=True)
    print('Dependencies installed locally. Run start.py again.', flush=True)
    return 0


def check():
    if sys.version_info < (3, 9):
        raise RuntimeError('Python 3.9+ is required (3.12 recommended).')
    for name in ('bridge.py', 'team_console.py'):
        if not (ROOT / name).is_file():
            raise RuntimeError('Missing ' + name + '; extract the complete project first.')
    try:
        version = importlib.metadata.version('websockets')
    except importlib.metadata.PackageNotFoundError:
        raise RuntimeError('Missing websockets. Run: python -m pip install "websockets>=13,<16"') from None
    if not 13 <= int(version.split('.')[0]) < 16:
        raise RuntimeError('Unsupported websockets ' + version + '; install websockets>=13,<16.')
    # 4.6.0: validate config + warn (never fail) on busy ports so --check
    # stays fast and scriptable.
    config_path = ROOT / 'config.json'
    if config_path.is_file():
        try:
            json.loads(config_path.read_text(encoding='utf-8-sig'))
        except (ValueError, OSError) as exc:
            raise RuntimeError('config.json is not valid JSON: ' + str(exc)) from None
    for env_name, default in (('ZS_BRIDGE_PORT', 17613), ('ZS_BRIDGE_HTTP_PORT', 17614)):
        try:
            port = int(os.environ.get(env_name, default))
        except ValueError:
            continue
        probe = socket.socket()
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            print('Warning: port ' + str(port) + ' is already in use (bridge may already be running).', flush=True)
        finally:
            probe.close()
    print('Checks passed: Python ' + sys.version.split()[0] + ', websockets ' + version, flush=True)


def bridge_health(timeout=2.0):
    """Best-effort /health probe. Returns dict or None. Never raises."""
    try:
        port = int(os.environ.get('ZS_BRIDGE_HTTP_PORT', str(int(os.environ.get('ZS_BRIDGE_PORT', '17613')) + 1)))
    except ValueError:
        return None
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=timeout) as response:
            return json.load(response)
    except (OSError, ValueError):
        return None


def bridge_port():
    try:
        return int(os.environ.get('ZS_BRIDGE_HTTP_PORT', str(int(os.environ.get('ZS_BRIDGE_PORT', '17613')) + 1)))
    except ValueError:
        return 17614


def bridge_token():
    """The bridge's own token file. Empty when the bridge has not written it yet."""
    try:
        return (Path(os.environ.get('ZS_DATA_DIR', ROOT)) / '.zs_token').read_text(encoding='utf-8').strip()
    except OSError:
        return ''


def http_get(path, timeout=3.0):
    """Authenticated GET against the bridge. Returns the parsed JSON or None."""
    token = bridge_token()
    headers = {'X-ZS-Token': token} if token else {}
    request = urllib.request.Request(f'http://127.0.0.1:{bridge_port()}{path}', headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except (OSError, ValueError):
        return None


def format_member(member):
    state = 'ready' if member.get('ready') else 'joined'
    return f"{member.get('name', '?')} ({member.get('role', '?')}, {state})"


def format_chat(event, indent='  '):
    """One bare chat entry: who said what to whom, with the REAL message text."""
    stamp = str(event.get('timestamp', ''))[11:23]
    who = event.get('name') or 'agent'
    role = event.get('role') or 'agent'
    recipient = event.get('recipient') or 'all'
    tag = HANDOFF_TAGS.get(event.get('handoff'), '')
    header = f"{indent}{stamp}  {who} ({role}) -> {recipient}" + (f' {tag}' if tag else '')
    body = str(event.get('text', ''))
    if not body:
        return header
    return header + '\n' + '\n'.join(indent + '    ' + line for line in body.splitlines())


def print_team_snapshot(quiet=False):
    """Print who joined which team and the bare chat the agents really sent."""
    chat = http_get('/api/team/chat?limit=40')
    summary = http_get('/api/team/summary')
    if not isinstance(chat, dict):
        if not quiet:
            print('Team status unavailable: the bridge did not answer /api/team/chat', flush=True)
        return False
    teams = summary.get('teams') if isinstance(summary, dict) else {}
    teams = teams or {}
    members = chat.get('members') or {}
    for name, roster in sorted(members.items()):
        info = teams.get(name, {})
        order = info.get('introduction_order') or [m.get('role') for m in roster]
        state = 'active' if info.get('active') else 'idle'
        phase = info.get('phase') or 'idle'
        order_text = ' -> '.join(order) if order else 'unknown'
        print(f"Team {name}: {state} ({len(roster)} joined, order: {order_text}, phase: {phase})", flush=True)
        for member in roster:
            print('  - ' + format_member(member), flush=True)
    if not members:
        print('No agent has joined a team yet. Open the AI tabs and press Join in the extension popup.', flush=True)
    messages = chat.get('messages') or []
    print(f"Team chat ({len(messages)} message(s) sent by the agents):", flush=True)
    for event in messages:
        print(format_chat(event), flush=True)
    if not messages:
        print('  (no agent messages yet - the team has not spoken)', flush=True)
    return True


def watch_team(stop_event):
    """Follow the bridge event log: joins and bare chats, as they happen."""
    cursor = 0
    snapshot_done = False
    while not stop_event.is_set():
        try:
            if not snapshot_done:
                # The bridge may still be booting: wait for it instead of
                # printing a failure the user cannot act on.
                if not bridge_health(timeout=1.0):
                    stop_event.wait(0.5)
                    continue
                if not print_team_snapshot(quiet=True):
                    stop_event.wait(1.0)
                    continue
                head = http_get('/api/team/events?since=0')
                if isinstance(head, dict):
                    cursor = head.get('cursor', cursor)
                snapshot_done = True
                continue
            payload = http_get(f'/api/team/events?since={cursor}&wait=1', timeout=9.0)
        except Exception:
            # A watcher must never die: a broken poll is retried, not fatal.
            stop_event.wait(1.0)
            continue
        if not isinstance(payload, dict):
            stop_event.wait(1.0)
            continue
        if payload.get('reset'):
            cursor = 0
            print('[bridge restarted; team event stream reset]', flush=True)
            continue
        for event in payload.get('events', []):
            kind = event.get('kind')
            if kind == 'message':
                print(format_chat(event, indent=''), flush=True)
            elif kind == 'joined':
                print(f"* {event.get('name')} ({event.get('role')}) joined team {event.get('team')}", flush=True)
            elif kind == 'role_violation':
                print(f"! {event.get('text')}", flush=True)
            elif kind in ('started', 'stopped', 'collab', 'expired', 'intro_nudge', 'turn_skipped', 'left'):
                print(f"* {event.get('text')}", flush=True)
        cursor = payload.get('cursor', cursor)


def status_summary():
    """--status: bridge health + joined members + the bare team chat."""
    health = bridge_health(timeout=3.0)
    if not health:
        print('Bridge is not running. Start it with: python start.py', flush=True)
        return 1
    print('Bridge: ' + json.dumps(health), flush=True)
    events = http_get('/api/team/events?since=0')
    if isinstance(events, dict):
        kinds = {}
        for event in events.get('events', []):
            kinds[event.get('kind', 'event')] = kinds.get(event.get('kind', 'event'), 0) + 1
        print('Team events: ' + json.dumps(kinds), flush=True)
    print_team_snapshot()
    return 0


def launch_console():
    command = [sys.executable, str(ROOT / 'team_console.py')]
    if os.name == 'nt':
        return subprocess.Popen(command, cwd=ROOT, creationflags=subprocess.CREATE_NEW_CONSOLE)
    # A portable Python process cannot promise a separate desktop terminal, so
    # the console would print into THIS window - and this launcher now renders
    # the same team activity itself. Keep one source of truth: the console is
    # silenced here and stays available as its own window on demand.
    print('Team joins and chats appear here. For the full viewer run: python3 team_console.py', flush=True)
    return subprocess.Popen(command, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-deps', action='store_true', help='Explicitly create a local virtual environment and install websockets; requires internet')
    parser.add_argument('--check', action='store_true', help='Validate prerequisites without starting processes')
    parser.add_argument('--no-console', action='store_true', help='Run only the bridge')
    parser.add_argument('--status', action='store_true', help='Print bridge health, the joined agents and the bare team chat, then exit (no processes started)')
    args = parser.parse_args(argv)
    if args.install_deps:
        return install_dependencies()
    record("Launcher Python: "+sys.executable)
    try:
        check()
    except (RuntimeError, ValueError) as exc:
        record('Startup failed: '+str(exc))
        print('Startup failed: ' + str(exc), file=sys.stderr)
        print('To install dependencies locally: python start.py --install-deps', file=sys.stderr)
        return 1
    if args.status:
        return status_summary()
    if args.check:
        return 0
    viewer = bridge = None
    stop_watch = threading.Event()
    watcher = None
    try:
        print('Keep this process open. Ctrl+C stops the bridge. No automatic crash restart.', flush=True)
        bridge = subprocess.Popen([sys.executable, str(ROOT / 'bridge.py')], cwd=ROOT)
        # 4.6.0: wait briefly for bridge health so the console does not open
        # into a false "waiting for bridge" state. Best-effort, never fatal.
        if bridge.poll() is None:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and bridge.poll() is None:
                if bridge_health(timeout=0.2):
                    break
                time.sleep(0.05)
        # 4.8.0: the launcher itself shows team activity - who joined and the
        # bare chat the agents really sent - so the team is visible in THIS
        # window without a second terminal.
        watcher = threading.Thread(target=watch_team, args=(stop_watch,), name='zs-team-watch', daemon=True)
        watcher.start()
        if not args.no_console:
            try:
                viewer = launch_console()
            except OSError as exc:
                print('Could not open viewer: ' + str(exc) + '. Run team_console.py manually.', file=sys.stderr)
        code=bridge.wait()
        record("Bridge exited with code "+str(code))
        if code: print("Bridge stopped with an error. See logs/bridge_debug.log and logs/start.log.", file=sys.stderr)
        return code
    except KeyboardInterrupt:
        return 130
    except OSError as exc:
        print('Launch failed: ' + str(exc), file=sys.stderr)
        return 1
    finally:
        stop_watch.set()
        for child in (bridge, viewer):
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def wait_owned(command):
    child=subprocess.Popen(command,cwd=ROOT)
    try:
        return child.wait()
    except KeyboardInterrupt:
        return 130
    finally:
        if child.poll() is None:
            child.terminate()
            try: child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill();child.wait()


def entrypoint():
    # .pyw / pythonw has no terminal: request a real Python console on Windows.
    if os.name=='nt' and Path(sys.executable).name.lower()=='pythonw.exe':
        executable=Path(sys.executable).with_name('python.exe')
        subprocess.Popen([str(executable), str(ROOT/'start.py'), *sys.argv[1:]], cwd=ROOT, creationflags=subprocess.CREATE_NEW_CONSOLE)
        return 0
    target=local_python()
    if target.is_file() and Path(sys.prefix).resolve()!=(ROOT/'.venv').resolve() and '--install-deps' not in sys.argv:
        return wait_owned([str(target), str(ROOT/'start.py'), *sys.argv[1:]])
    try:
        code=main()
    except Exception:
        details=traceback.format_exc()
        record(details)
        print(details, file=sys.stderr)
        code=1
    # Keep failures visible when launched by double click. CLI --check stays scriptable.
    if code and os.name=='nt' and '--check' not in sys.argv and sys.stdin and sys.stdin.isatty():
        try: input('Startup failed. Press Enter to close this window…')
        except (EOFError, KeyboardInterrupt): pass
    return code


def _shutdown_signal(signum, frame):
    raise KeyboardInterrupt


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, _shutdown_signal)
    raise SystemExit(entrypoint())
