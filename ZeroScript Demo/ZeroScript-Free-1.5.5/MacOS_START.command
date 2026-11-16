#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# MacOS_START.command (v4.7.0)
# ---------------------------------------------------------------------------
#  Self-contained macOS/Linux launcher for the ZeroScript 4.7.0 bridge.
#  Double-clickable in Finder (.command opens Terminal; .sh opens an editor).
#  Supports `--check` for non-interactive dependency & syntax validation.
# ---------------------------------------------------------------------------
set -u

cd "$(dirname "$0")" || exit 1

CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
    CHECK_ONLY=1
fi

BRIDGE_PORT="${ZS_BRIDGE_PORT:-17613}"
BRIDGE_HTTP_PORT="${ZS_BRIDGE_HTTP_PORT:-$((BRIDGE_PORT + 1))}"
LOG_DIR="logs"
LOG_FILE="$LOG_DIR/start.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log() {
    printf '%s %s
' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

pause_and_exit() {
    local code="${1:-0}"
    if [ "$CHECK_ONLY" -eq 1 ] || [ ! -t 0 ]; then
        exit "$code"
    fi
    echo
    read -n 1 -s -r -p "Press any key to close this window..."
    echo
    exit "$code"
}

echo
echo "  === ZeroScript Bridge v4.7.0 Team ==="
echo "  WS 127.0.0.1:$BRIDGE_PORT + HTTP 127.0.0.1:$BRIDGE_HTTP_PORT | Authenticated Team Mailboxes & Studio MCP"
echo
log "===== MacOS_START.command v4.7.0 launched (check=$CHECK_ONLY) ====="

if [ ! -f "bridge.py" ]; then
    echo "  ERROR: bridge.py was not found next to this launcher."
    echo "  Extract the full archive, then run MacOS_START.command from that folder."
    log "FATAL: bridge.py missing next to launcher."
    pause_and_exit 1
fi

echo "  [1/3] Looking for Python 3.9+..."
PY=""
py_ok() {
    command -v "$1" >/dev/null 2>&1 || return 1
    "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1
}
if [ -x ".venv/bin/python" ] && py_ok ".venv/bin/python"; then
    PY=".venv/bin/python"
elif [ -x "../../.venv/bin/python" ] && py_ok "../../.venv/bin/python"; then
    PY="../../.venv/bin/python"
else
    for cand in python3 python; do
        if py_ok "$cand"; then
            PY="$cand"
            break
        fi
    done
fi

if [ -z "$PY" ]; then
    # A .venv that exists but fails py_ok silently fell through to system Python
    # above, which is where "I have 3.12 installed, why is it saying 3.9" starts.
    if [ -e ".venv/bin/python" ] || [ -e "../../.venv/bin/python" ]; then
        echo "  NOTE: a local .venv exists but is not a working Python 3.9+ interpreter."
        echo "        Recreate it with: rm -rf .venv && python3 -m venv .venv"
    fi
    echo "  ERROR: Python 3.9 or newer was not found."
    echo "  Install it from https://www.python.org/downloads/ then run this again."
    log "FATAL: no Python 3.9+ found."
    pause_and_exit 1
fi
PY_VER="$("$PY" --version 2>&1)"
echo "        Found: $PY ($PY_VER)"
log "Python found: $PY ($PY_VER)"

echo "  [2/3] Checking websockets dependency..."
if ! "$PY" -c "import websockets" >/dev/null 2>&1; then
    if [ "$CHECK_ONLY" -eq 1 ]; then
        echo "  ERROR: websockets is not installed for $PY."
        echo "  Run: $PY -m pip install 'websockets>=13,<16'"
        exit 1
    fi
    echo "        Installing websockets into local .venv (first run only)..."
    log "websockets missing; creating local .venv."
    if "$PY" -m venv .venv >/dev/null 2>&1 && .venv/bin/python -m pip install 'websockets>=13,<16' >/dev/null 2>&1; then
        PY=".venv/bin/python"
    elif ! "$PY" -m pip install --user 'websockets>=13,<16' >/dev/null 2>&1; then
        echo
        echo "  ERROR: could not install 'websockets'."
        echo "  Run manually: $PY -m pip install --user 'websockets>=13,<16'"
        log "FATAL: websockets install failed."
        pause_and_exit 1
    fi
fi
echo "        websockets OK"
log "deps OK."

# 4.7.0: the launcher never looked at the ports, so the banner cheerfully printed
# "WS 127.0.0.1:17613" even when something else already owned it. macOS ships
# `lsof`; on Linux fall back to `ss`, and stay silent if neither exists.
port_busy() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
    elif command -v ss >/dev/null 2>&1; then
        ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
    else
        return 1
    fi
}
for _port in "$BRIDGE_PORT" "$BRIDGE_HTTP_PORT"; do
    if port_busy "$_port"; then
        echo "  NOTE: port $_port is already in use."
        echo "        If that is a bridge you left running, close it. Otherwise set"
        echo "        ZS_BRIDGE_PORT to another port in BOTH the shell and the extension."
        log "port $_port already in use"
    fi
done

if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "  [3/3] Preflight check passed."
    exit 0
fi

echo "  [3/3] Starting bridge (WS $BRIDGE_PORT + HTTP $BRIDGE_HTTP_PORT) ..."
echo "        Existing port owners are never killed; close any old bridge yourself."
echo "        Team Console (run in a second Terminal): $PY team_console.py"
echo "        One-shot team status:                    $PY team_console.py --status"
echo
echo "  ############################################################"
echo "  ##   KEEP THIS WINDOW OPEN WHILE USING ZEROSCRIPT         ##"
echo "  ##   Minimize it to keep Roblox Studio + AI tabs linked.  ##"
echo "  ############################################################"
echo
log "Launching bridge.py with $PY"

"$PY" bridge.py
BRIDGE_EXIT=$?
log "bridge.py exited with code $BRIDGE_EXIT"
echo
if [ "$BRIDGE_EXIT" -eq 0 ]; then
    echo "  Bridge stopped normally. You can close this window."
else
    echo "  Bridge exited with code $BRIDGE_EXIT (no automatic crash loop; see logs/bridge_debug.log)."
fi
pause_and_exit "$BRIDGE_EXIT"
