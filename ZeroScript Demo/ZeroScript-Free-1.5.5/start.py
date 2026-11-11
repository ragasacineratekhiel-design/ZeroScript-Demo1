#!/usr/bin/env python3
"""ZeroScript launcher. No automatic installs, process killing or crash replay."""
import argparse
import importlib.metadata
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


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
    print('Checks passed: Python ' + sys.version.split()[0] + ', websockets ' + version, flush=True)


def launch_console():
    command = [sys.executable, str(ROOT / 'team_console.py')]
    if os.name == 'nt':
        return subprocess.Popen(command, cwd=ROOT, creationflags=subprocess.CREATE_NEW_CONSOLE)
    # A portable Python process cannot promise a separate desktop terminal.
    print('Team events will appear here. For a separate window run: python3 team_console.py', flush=True)
    return subprocess.Popen(command, cwd=ROOT)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate prerequisites without starting processes')
    parser.add_argument('--no-console', action='store_true', help='Run only the bridge')
    args = parser.parse_args(argv)
    try:
        check()
    except (RuntimeError, ValueError) as exc:
        print('Startup failed: ' + str(exc), file=sys.stderr)
        return 1
    if args.check:
        return 0
    viewer = bridge = None
    try:
        print('Keep this process open. Ctrl+C stops the bridge. No automatic crash restart.', flush=True)
        bridge = subprocess.Popen([sys.executable, str(ROOT / 'bridge.py')], cwd=ROOT)
        if not args.no_console:
            try:
                viewer = launch_console()
            except OSError as exc:
                print('Could not open viewer: ' + str(exc) + '. Run team_console.py manually.', file=sys.stderr)
        return bridge.wait()
    except KeyboardInterrupt:
        return 130
    except OSError as exc:
        print('Launch failed: ' + str(exc), file=sys.stderr)
        return 1
    finally:
        for child in (bridge, viewer):
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == '__main__':
    raise SystemExit(main())
