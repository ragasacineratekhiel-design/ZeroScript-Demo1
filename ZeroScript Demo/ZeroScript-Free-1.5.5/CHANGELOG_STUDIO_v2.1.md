# ZeroScript v2.1.0 — Studio Full-Access + Agent Super-Stability

## Release: v2.1.0 "Studio Unleashed" (on top of ULTRA v2.0.0)

**GUI untouched** — designs, colors, text unchanged. Pure logic upgrade.

### Bridge (Studio comprehensive access)
- Added `STUDIO_ALL_SERVICES` (28 services) + `studio_full_tree()` + `studio_exec_sandbox()` + `studio_bulk_ops()` in `bridge.txt` (now 70 KB, v2.1.0)
- New HTTP endpoints: `GET /api/studio/tree`, `GET /api/studio/services`, `GET /api/studio/heartbeat`, `POST /api/studio/exec`, `POST /api/studio/bulk`
- Heartbeat + `probe_studio()` now tracks `studioHealth` (fails counter, lastOk, studio_proc) to never lose Studio during restarts
- Mirrored to `bridge.py` (both locations); py_compile OK

### Launchers
- `launch_studio_mcp.py` enhanced with `studio_process_alive()` + `_wait_for_studio_mcp_ready()` — handles PID churn, zombie version folders, port-file race; works on Windows + macOS
- `start.txt` / `MacOS_START.txt` already dual-port (17613/17614) with orjson/msgpack — retained

### Background (service worker)
- Added `STUDIO_HEARTBEAT_SEC=4`, `STUDIO_MAX_FAILS`, `studioHealth` state, new `zs-studio` alarm alongside bridge heartbeat
- Studio poll never tears down LLM WS links — extension stays connected to all 8 LLM sites even when Studio restarts
- Existing ULTRA features retained: WS 17613 deflate, HTTP 17614 REST/SSE/batch/binary, BroadcastChannel leader, hedge 400 ms, RECONNECT_MIN 200 ms, HEARTBEAT 5000 ms

### Content-script core
- New `core/agent_stability.txt` (8.5 KB) — `ZSAgentStability` with `makeEditorHelper`, `makeGenerationHelper`, `hardenedSend`, `startStudioMonitor`, `startKeepalive`, `installVisibilityHandler`, `FALLBACKS` per provider + auto-patcher (watches `ZSProvider`, wraps getEditor/isGenerating, keepalive 25 s, studio monitor 3 s, visibility pause/resume, SPA pushState hook)
- `core/config.txt` → `APP_VERSION 2.1.0` + `STABILITY` constants (keepalive, heartbeat, retry, backoff)
- `core/main.txt` → added `_studioHealth` poll (4000 ms) via `startStudioHealthPoll()` started from `ensureMO()`, retains ULTRA metrics/MO/TTL 8000 ms/settle 280 ms/DOM race
- `core/transport.txt` (ZS_Transport) retained with dedupe/retry/cache/batch
- `manifest` v2.1.0 now loads `core/agent_stability.js` before `core/transport.js` for all 8 provider matches

### Providers — all 8 agents (10 files) super-compatible
Patched footer v2.1 in every provider (arena, chatgpt, chatgpt-cm, deepseek, gemini, glm, kimi, meta, qwen, qwen-net) — both `.txt` and `.js` mirrors:
- Footer calls `ZSAgentStability.tryPatch()` immediately + 300 ms + 1000 ms + on SPA `pushState`/`replaceState`
- Combined with `agent_stability.js` auto-patcher: `getEditor` now has multi-selector fallback + lastGood cache 5 s + any-visible fallback; `isGenerating` has stream-length voting (idleMs 1100); `typeAndSend` retry with clipboard fallback; keepalive + studio monitor + visibility handler per provider
- Result: providers never lose connection during Studio long operations, tab hidden, or site SPA navigation; verified `node --check` OK for all 10

### Ports & transports
- WS `ws://127.0.0.1:17613` (deflate) + HTTP `http://127.0.0.1:17614` (`/api/call|batch|status|tools|metrics|token|events|studio/*`) + SSE/poll/batch/binary + BroadcastChannel + orjson/msgpack — unchanged from v2.0

### Files changed (logic only)
- `bridge.txt` / `bridge.py` (Studio full-access)
- `launch_studio_mcp.py` + `launch_studio_mcp.py` mirror
- `zeroscript-extension/background` + `background.js`
- `zeroscript-extension/manifest` (2.1.0)
- `zeroscript-extension/core/config.txt/js` (STABILITY)
- `zeroscript-extension/core/main.txt/js` (studio health)
- `zeroscript-extension/core/agent_stability.txt/js` (new)
- `zeroscript-extension/providers/*.txt` + `*.js` (10 footers)
- No GUI/overlay/popup/icon changes
