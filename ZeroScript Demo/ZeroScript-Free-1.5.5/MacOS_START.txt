#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# MacOS_Start.command
# ---------------------------------------------------------------------------
#  Self-contained macOS/Linux launcher for the ZeroScript bridge.
#  Double-clickable in Finder (that is why it is a .command, not a .sh: a .sh
#  opens in an editor instead of running). It has NO dependency on start.py -
#  it finds Python, ensures the one required library is installed, frees a
#  previous bridge still holding the port, then runs bridge.py itself.
#  The Windows equivalent is start.bat.
# ---------------------------------------------------------------------------
set -u

# Run from the folder this script lives in, so bridge.py is found regardless of
# where Finder launched it from.
cd "$(dirname "$0")" || exit 1

BRIDGE_PORT="${ZS_BRIDGE_PORT:-17613}"
BRIDGE_HTTP_PORT="${ZS_BRIDGE_HTTP_PORT:-17614}"
LOG_DIR="logs"
LOG_FILE="$LOG_DIR/start.log"
mkdir -p "$LOG_DIR" 2>/dev/null

log() {
    # Best-effort append; never abort the launch if logging fails.
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

pause_and_exit() {
    # A double-clicked .command opens a fresh Terminal window; without this the
    # window closes instantly and any error scrolls away unread.
    echo
    read -n 1 -s -r -p "Press any key to close this window..."
    echo
    exit "${1:-0}"
}

echo
echo "  === ZeroScript Bridge v2.0.0 ULTRA ==="
echo "  WS 17613 + HTTP 17614 + SSE/Batch/Binary"
echo
log "===== MacOS_Start.command launched ====="

# --- 0. bridge.py must be next to us ---------------------------------------
# If the user ran this out of a half-extracted download, bridge.py is missing
# and Python would fail with a confusing error. Say the real thing instead.
if [ ! -f "bridge.py" ]; then
    echo "  ERROR: bridge.py was not found next to this launcher."
    echo "  Extract the WHOLE download, then run MacOS_Start.command from that folder."
    log "FATAL: bridge.py missing next to launcher."
    pause_and_exit 1
fi

# --- 1. Find a usable Python (3.9+ with a working pip) ----------------------
echo "  [1/3] Looking for Python 3.9+..."
PY=""
py_ok() {
    command -v "$1" >/dev/null 2>&1 || return 1
    "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1
}
for cand in python3 python; do
    if py_ok "$cand"; then
        PY="$cand"
        break
    fi
done

if [ -z "$PY" ]; then
    echo "  ERROR: Python 3.9 or newer was not found."
    echo "  Install it from https://www.python.org/downloads/ then run this again."
    echo "  (On macOS you can also run:  xcode-select --install)"
    log "FATAL: no Python 3.9+ found."
    pause_and_exit 1
fi
PY_VER="$("$PY" --version 2>&1)"
echo "        Found: $PY ($PY_VER)"
log "Python found: $PY ($PY_VER)"

# --- 2. Ensure deps (websockets + ultra optional) --------------------
echo "  [2/3] Checking dependencies (websockets + ultra) ..."
if ! "$PY" -c "import websockets" >/dev/null 2>&1; then
    echo "        Installing websockets - first time only..."
    log "websockets missing, installing via pip --user."
    if ! "$PY" -m pip install --user websockets >/dev/null 2>&1; then
        log "pip --user failed; retrying with --break-system-packages."
        "$PY" -m pip install --user --break-system-packages websockets >/dev/null 2>&1 || true
    fi
    if ! "$PY" -c "import websockets" >/dev/null 2>&1; then
        echo
        echo "  ERROR: could not install 'websockets'."
        echo "      $PY -m pip install --user websockets"
        log "FATAL: websockets install failed."
        pause_and_exit 1
    fi
fi
echo "        websockets OK"
# optional ultra libs (best-effort)
if ! "$PY" -c "import orjson" >/dev/null 2>&1; then
    echo "        Installing orjson (optional, +30% speed) ..."
    "$PY" -m pip install --user orjson >/dev/null 2>&1 || "$PY" -m pip install --user --break-system-packages orjson >/dev/null 2>&1 || true
fi
if ! "$PY" -c "import msgpack" >/dev/null 2>&1; then
    echo "        Installing msgpack (optional, binary) ..."
    "$PY" -m pip install --user msgpack >/dev/null 2>&1 || "$PY" -m pip install --user --break-system-packages msgpack >/dev/null 2>&1 || true
fi
log "deps OK."

# --- 3. Replace any previous bridge holding ports (both ultra ports) -----
echo "  [3/3] Starting bridge (WS $BRIDGE_PORT + HTTP $BRIDGE_HTTP_PORT) ..."
if command -v lsof >/dev/null 2>&1; then
    for P in "$BRIDGE_PORT" "$BRIDGE_HTTP_PORT"; do
        OLD_PID="$(lsof -ti "tcp:$P" -s TCP:LISTEN 2>/dev/null | head -n1)"
        if [ -n "${OLD_PID:-}" ]; then
            echo "        Previous bridge on $P pid $OLD_PID — replacing..."
            log "Killing previous bridge pid $OLD_PID on port $P."
            kill -TERM "$OLD_PID" 2>/dev/null || true; sleep 1
            if kill -0 "$OLD_PID" 2>/dev/null; then kill -9 "$OLD_PID" 2>/dev/null || true; sleep 1; fi
        fi
    done
fi

echo
echo "  ############################################################"
echo "  ##   KEEP THIS WINDOW OPEN - DO NOT CLOSE IT              ##"
echo "  ##   ZeroScript stops working if you close it. Just       ##"
echo "  ##   minimize this window and leave it running.           ##"
echo "  ############################################################"
echo
log "Launching bridge.py with $PY"

"$PY" bridge.py
BRIDGE_EXIT=$?
log "bridge.py exited with code $BRIDGE_EXIT"

echo
if [ "$BRIDGE_EXIT" -ne 0 ]; then
    echo "  Bridge stopped with ERROR code $BRIDGE_EXIT - scroll up for the Python"
    echo "  error and include this whole window in any bug report (logs/start.log)."
else
    echo "  Bridge stopped normally."
fi
pause_and_exit "$BRIDGE_EXIT"
