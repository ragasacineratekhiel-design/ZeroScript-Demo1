#!/usr/bin/env python3
"""Synchronize compatibility copies; --check is read-only and suitable for CI."""
import argparse
from pathlib import Path
import shutil

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    stale = []
    for source, destination in pairs():
        if not destination.exists() or source.read_bytes() != destination.read_bytes():
            if args.write:
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                print("Updated", destination.relative_to(ROOT))
            else:
                stale.append(str(destination.relative_to(ROOT)))
    # Unexpected files are reported, never silently deleted.
    extra = [str(p.relative_to(ROOT)) for p in NESTED.rglob("*") if p.is_file() and "__pycache__" not in p.parts and not (EXTENSION / p.relative_to(NESTED)).exists()]
    if stale or extra:
        print("Out-of-sync or unexpected compatibility files:")
        print("\n".join(stale + extra))
        return 1
    print("Compatibility copies match canonical sources.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
