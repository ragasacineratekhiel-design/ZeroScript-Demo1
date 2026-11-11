#!/usr/bin/env python3
"""Repository source validation + mock suites. Does not test live websites/Studio.
Run with the Python interpreter containing requirements-dev.txt, after npm ci.
"""
import ast
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def run(command):
    print('RUN:', ' '.join(map(str, command)), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def main():
    # Include untracked new sources, exclude runtime/dependency/git directories.
    excluded = {'.git', '.venv', 'node_modules', '__pycache__', '.cache'}
    counts = {'python': 0, 'javascript': 0, 'json': 0}
    for p in ROOT.rglob('*'):
        if any(part in excluded for part in p.relative_to(ROOT).parts) or not p.is_file():
            continue
        if p.suffix == '.py':
            ast.parse(p.read_text(encoding='utf-8-sig'), filename=str(p))
            counts['python'] += 1
        elif p.suffix == '.js':
            subprocess.run(['node', '--check', str(p)], check=True, capture_output=True)
            counts['javascript'] += 1
        elif p.suffix == '.json':
            json.loads(p.read_text(encoding='utf-8-sig'))
            counts['json'] += 1
    print('Syntax/JSON source inventory:', counts, flush=True)
    run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v'])
    # npm.cmd is needed on Windows when not using a shell.
    import os
    run(['npm.cmd' if os.name == 'nt' else 'npm', 'test'])
    run([sys.executable, 'scripts/sync_copies.py', '--check'])
    run(['git', 'diff', '--check'])
    print('PASS local validation. NOT live-browser/Windows/Roblox certification.', flush=True)


if __name__ == '__main__':
    main()
