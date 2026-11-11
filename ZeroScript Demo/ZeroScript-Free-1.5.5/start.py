#!/usr/bin/env python3
"""ZeroScript launcher. No automatic installs, process killing or crash replay."""
import argparse
import importlib.metadata
import os
from pathlib import Path
import subprocess
import sys
import traceback
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent


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
    parser.add_argument('--install-deps', action='store_true', help='Explicitly create a local virtual environment and install websockets; requires internet')
    parser.add_argument('--check', action='store_true', help='Validate prerequisites without starting processes')
    parser.add_argument('--no-console', action='store_true', help='Run only the bridge')
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
        for child in (bridge, viewer):
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def entrypoint():
    # .pyw / pythonw has no terminal: request a real Python console on Windows.
    if os.name=='nt' and Path(sys.executable).name.lower()=='pythonw.exe':
        executable=Path(sys.executable).with_name('python.exe')
        subprocess.Popen([str(executable), str(ROOT/'start.py'), *sys.argv[1:]], cwd=ROOT, creationflags=subprocess.CREATE_NEW_CONSOLE)
        return 0
    target=local_python()
    if target.is_file() and Path(sys.prefix).resolve()!=(ROOT/'.venv').resolve() and '--install-deps' not in sys.argv:
        return subprocess.call([str(target), str(ROOT/'start.py'), *sys.argv[1:]], cwd=ROOT)
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


if __name__ == '__main__':
    raise SystemExit(entrypoint())
