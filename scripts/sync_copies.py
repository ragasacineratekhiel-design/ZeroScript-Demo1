#!/usr/bin/env python3
"""Synchronize compatibility copies; --check is read-only and suitable for CI (v4.7.0).

Canonical extension: zeroscript-extension-v2/
Canonical Python:    ZeroScript Demo/ZeroScript-Free-1.5.5/*.py

4.7.0: fast size + SHA-256 comparison skips redundant disk writes when copies
already match (preserving mtimes and cutting I/O) and reports wall-clock time.

Stale copies (files present in the bundle but absent from the canonical tree)
are always REPORTED. They are only DELETED with --prune, because a silent delete
of a distribution file is exactly the kind of surprise a sync tool must not
spring: before 4.7.0 a rename left the old file in the bundle and --check failed
forever with no supported way to clear it.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import time

VERSION = "4.7.0"
ROOT = Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "ZeroScript Demo" / "ZeroScript-Free-1.5.5"
EXTENSION = ROOT / "zeroscript-extension-v2"
NESTED = CANONICAL / "zeroscript-extension"
PYTHON_FILES = ("bridge.py", "launch_studio_mcp.py", "team_hub.py", "team_console.py", "start.py")


def pairs():
    for source in sorted(EXTENSION.rglob("*")):
        if source.is_file() and "__pycache__" not in source.parts:
            yield source, NESTED / source.relative_to(EXTENSION)
    for name in PYTHON_FILES:
        yield CANONICAL / name, ROOT / "ZeroScript Demo" / name


def _same_bytes(a: Path, b: Path) -> bool:
    if not b.is_file() or a.stat().st_size != b.stat().st_size:
        return False
    return hashlib.sha256(a.read_bytes()).digest() == hashlib.sha256(b.read_bytes()).digest()


def main():
    t0 = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    # NOT part of the mutually-exclusive group: --prune is a modifier for --write.
    parser.add_argument("--prune", action="store_true",
                        help="with --write, delete bundle files that no longer exist in the canonical tree")
    args = parser.parse_args()
    stale = []
    updated = 0
    checked = 0
    for source, destination in pairs():
        checked += 1
        if not _same_bytes(source, destination):
            if args.write:
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                updated += 1
                print("Updated", destination.relative_to(ROOT))
            else:
                stale.append(str(destination.relative_to(ROOT)))
    # Files in the bundle with no canonical source: always reported, deleted only
    # when --prune is given alongside --write.
    extra = [
        p for p in NESTED.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and not (EXTENSION / p.relative_to(NESTED)).exists()
    ]
    pruned = 0
    if args.write and args.prune:
        for p in extra:
            p.unlink()
            pruned += 1
            print("Pruned", p.relative_to(ROOT))
        extra = []
    elapsed_ms = (time.monotonic() - t0) * 1000.0
    if stale or extra:
        print("Out-of-sync or unexpected compatibility files:")
        print("\n".join(stale + [str(p.relative_to(ROOT)) for p in extra]))
        if extra and not pruned:
            print("(pass --write --prune to delete the unexpected files above)")
        return 1
    if args.write:
        print(f"Compatibility copies match canonical sources ({updated}/{checked} updated, {pruned} pruned, {elapsed_ms:.1f}ms).")
    else:
        print(f"Compatibility copies match canonical sources ({checked} verified in {elapsed_ms:.1f}ms).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
