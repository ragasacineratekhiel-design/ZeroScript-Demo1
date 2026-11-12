#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# tools/sync-bridge.sh (v4.6.0) — verifies canonical Python modules in
# ZeroScript Demo/ZeroScript-Free-1.5.5/ match their ZeroScript Demo/ mirrors
# (or symlinks), repairing any drift cleanly.
set -euo pipefail
cd "$(dirname "$0")/.."
FILES=(bridge.py team_hub.py team_console.py start.py launch_studio_mcp.py)
for f in "${FILES[@]}"; do
  CANON="ZeroScript Demo/ZeroScript-Free-1.5.5/$f"
  LINK="ZeroScript Demo/$f"
  if [ -L "$LINK" ]; then
    echo "OK   $LINK -> $(readlink "$LINK")"
    continue
  fi
  if [ -f "$LINK" ] && cmp -s "$CANON" "$LINK"; then
    echo "OK   $LINK matches canonical $f"
    continue
  fi
  cp "$CANON" "$LINK"
  echo "SYNC $LINK <- $CANON"
done
