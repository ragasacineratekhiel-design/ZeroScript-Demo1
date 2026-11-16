#!/usr/bin/env python3
"""Run local validation suites without touching live Studio or user processes (v4.7.0)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

VERSION = "4.7.0"
ROOT = Path(__file__).resolve().parents[1]
NPM = "npm.cmd" if os.name == "nt" else "npm"
NODE = "node.exe" if os.name == "nt" else "node"
ENV = {
    **os.environ,
    "PYTHONDONTWRITEBYTECODE": "1",
    "ZS_PYTHON": sys.executable,
    "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
}

STEPS = [
    ("sync check", [sys.executable, "scripts/sync_copies.py", "--check"]),
    ("python unit & bridge tests", [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"]),
    ("full verifier & smoke boot", [NPM, "run", "verify"]),
    ("extension, DOM, Claude & popup suites", [NPM, "run", "test:team"]),
]

# 4.7.0: stop at the first failure and SAY what failed. `check=True` raised a
# CalledProcessError whose traceback named only a subprocess, so a user saw a
# stack trace instead of "the sync check failed, here is the command".
t_all = time.monotonic()
timings = []
for label, cmd in STEPS:
    t0 = time.monotonic()
    print(f"==> [{label}] {' '.join(cmd)}", flush=True)
    proc = subprocess.run(cmd, cwd=ROOT, env=ENV)
    elapsed = time.monotonic() - t0
    if proc.returncode != 0:
        print(f"\n  ✗ [{label}] failed with exit code {proc.returncode}\n"
              f"    command: {' '.join(cmd)}\n"
              f"    {len(timings)} of {len(STEPS)} steps passed before this one.", file=sys.stderr)
        raise SystemExit(proc.returncode)
    timings.append((label, elapsed))
    print(f"    ✓ {label} ({elapsed:.2f}s)", flush=True)

# 4.6.0 standing gate: deep AST audit must report zero P0, P1, and P2 findings.
print("==> [deep AST audit] node tools/audit-deep.js --json", flush=True)
raw = subprocess.check_output([NODE, "tools/audit-deep.js", "--json"], cwd=ROOT, env=ENV, text=True)
findings = json.loads(raw)
blocking = [f for f in findings if f.get("sev") in ("P0", "P1", "P2")]
if blocking:
    for f in blocking[:10]:
        print(f"  ✗ [{f['sev']}] {f['file']}:{f['line']} {f['kind']} — {f['msg']}", file=sys.stderr)
    raise SystemExit(1)
print(f"    ✓ deep AST audit (P0=0, P1=0, P2=0, P3={len(findings)})", flush=True)

# A per-step breakdown makes a slow run diagnosable without re-running it.
print("\n  step timings:", flush=True)
for label, elapsed in timings:
    print(f"    {elapsed:7.2f}s  {label}", flush=True)
print(f"    {time.monotonic() - t_all:7.2f}s  TOTAL", flush=True)
print(f"\nValidation passed in {time.monotonic() - t_all:.2f}s (v{VERSION}).")
