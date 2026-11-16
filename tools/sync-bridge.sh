#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# tools/sync-bridge.sh (v4.7.0) — verify/repair the Python mirrors under
# "ZeroScript Demo/" against canonical "ZeroScript Demo/ZeroScript-Free-1.5.5/".
#
# 4.7.0: this used to be a second, independent implementation of drift repair.
# `cp` unconditionally overwrote a hand-edited mirror (destroying the edit with no
# warning), it did not know about the 59 extension files that sync_copies.py also
# mirrors, and `set -e` made `cmp` abort the loop on the first missing file.
#
# It is now a thin, SAFE wrapper over scripts/sync_copies.py, which is the one
# tool that knows the full pair list:
#   (no args)  report drift, write nothing      -> exit 1 if anything differs
#   --write    copy canonical -> mirror
#   --prune    with --write, delete mirror files that have no canonical source
#
# A hand-edited mirror is REPORTED before it is overwritten, because the copy is
# canonical: the edit belongs in the canonical file, not in the mirror.
set -euo pipefail
cd "$(dirname "$0")/.."

mode=(--check)
for arg in "$@"; do
  case "$arg" in
    --write) mode=(--write) ;;
    --prune) mode+=(--prune) ;;
    -h|--help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "sync-bridge.sh: unknown argument '$arg' (use --write, --prune, --help)" >&2; exit 2 ;;
  esac
done

python_bin="${ZS_PYTHON:-python3}"
if ! command -v "$python_bin" >/dev/null 2>&1; then
  python_bin=python
fi

exec "$python_bin" scripts/sync_copies.py "${mode[@]}"
