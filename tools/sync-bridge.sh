#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# tools/sync-bridge.sh — the bridge used to exist as two identical 72 KB files
# (audit #21), so every fix had to be applied twice and drift was guaranteed.
# `ZeroScript Demo/bridge.py` is now a symlink to the canonical copy; this script
# verifies that and re-links if a checkout (e.g. on Windows) turned it into a copy.
set -euo pipefail
cd "$(dirname "$0")/.."
CANON="ZeroScript Demo/ZeroScript-Free-1.5.5/bridge.py"
LINK="ZeroScript Demo/bridge.py"
if [ -L "$LINK" ]; then
  echo "OK   $LINK -> $(readlink "$LINK")"
  exit 0
fi
if [ -f "$LINK" ]; then
  if cmp -s "$CANON" "$LINK"; then
    echo "OK   $LINK is an identical copy"
  else
    echo "DRIFT $LINK differs from $CANON — re-linking"
    rm -f "$LINK"; ln -s "ZeroScript-Free-1.5.5/bridge.py" "$LINK"
  fi
  exit 0
fi
ln -s "ZeroScript-Free-1.5.5/bridge.py" "$LINK"
echo "RELINKED $LINK"
