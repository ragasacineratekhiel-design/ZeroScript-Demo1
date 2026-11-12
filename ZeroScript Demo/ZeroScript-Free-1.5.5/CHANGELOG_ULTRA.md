# Changelog — ULTRA v2.0.0 (2026-10-26) → TEAM HUB v3.1.0 (2026-11-12)

## 3.1.0 TEAM HUB — bridge console + hub + truth + parallel calls

- **Parallel tool calls**: dropped the per-server whole-call lock (JSON-RPC ids
  already multiplex) — one slow `execute_luau` no longer blocks every other
  tool. This is what "the AI can't communicate through the bridge" actually was.
- **Team Hub** (role-aware message bus): `hub_send`/`hub_read` over WS,
  `POST /api/hub`, `GET /api/hub?since=`, SSE `hub_msg`. Role → kind
  permissions enforced (planner never posts code, checker never posts code —
  the coder makes changes).
- **Console**: stdin REPL in the bridge window (`help/status/tools/truth/hub/
  say/as/role/call/metrics/restart`) + `team.py` standalone Team Console & Hub.
- **Ground truth**: `GET /api/truth` + WS `truth` — fresh Studio probe, real
  server health, executed-tool ledger (200 entries). Nothing from model claims.
- **Speed**: probe TTL cache 0.7s, cached tool catalogue for broadcasts,
  `studio_full_tree` no longer wastes a probe per service, stdout-safe logging.
- **Compat**: websockets handler accepts both legacy `(ws, path)` and modern
  `(conn)` APIs; CORS allowlist covers all 14 AI sites (claude/copilot/grok/
  poe/mistral/perplexity were missing).

## 2.0.0 ULTRA — All logic upgraded, designs untouched

### Middle layer (PC ↔ AI) — super fast, all possible methods
- **7 transports**: WebSocket (deflate+binary) + HTTP REST + SSE + Long-Poll + Batch + msgpack + BroadcastChannel single-WS share.
- **2 ports**: 17613 WS + 17614 HTTP/SSE/metrics (env `ZS_BRIDGE_PORT` / `ZS_BRIDGE_HTTP_PORT`).
- **5× faster reconnect** (200ms vs 1000ms), 2× faster heartbeat (5s vs 10s), 3× faster stale detect (8s vs 25s).
- **HTTP API**: `POST /api/call`, `GET /api/status`, `GET /api/tools`, `POST /api/batch`, `GET /api/events` (SSE), `GET /api/poll`, `GET /api/metrics`, `GET /api/token`, CORS+Gzip+keepalive.
- **Bridge**: asyncio + ThreadingHTTPServer, `orjson` fast path, `TCP_NODELAY`/`SO_KEEPALIVE`, TTL caches, token bucket rate limit, auth token `.zs_token`, batch 12×, binary msgpack −30%.
- **Extension**: `TransportManager` races WS vs HTTP, hedge 400ms, leader election via `BroadcastChannel`, dedupe/coalesce, cache, adaptive heartbeat.

### Parser
- LRU 64-entry 800ms cache + fast-path `hasToolSignature` (indexOf before regex). Same output, 2–5× less CPU.

### Core loop
- `MutationObserver` wake, settle 500→280ms, sleeps 200→80/60ms, `bg()` dedupe/cache/metrics, `bgBatch()`, `TOOLS_TTL` 30s→8s.

### Launchers
- `start.bat` / `MacOS_Start.command` handle both ports, auto-install `orjson`/`msgpack`, kill orphans on both.

### Config & Manifest
- `ZS.TRANSPORT` + `ZS.APP_VERSION="2.0.0"`; manifest v2.0.0, `alarms` permission, http ports, `core/transport.js` in all content_scripts.

### Kept 100%
- Designs, GUIs, colors: `overlay.txt`/`overlay.css`, `popup*`, icons — untouched.

