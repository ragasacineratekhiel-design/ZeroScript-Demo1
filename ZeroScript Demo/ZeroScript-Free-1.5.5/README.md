# ZeroScript bridge 4.6.0 (local MCP + Team Hub)

`bridge.py` connects the `zeroscript-extension-v2` browser extension to Roblox Studio's MCP server and hosts the authenticated multi-AI `TeamHub`. Launch it with `python start.py` (Windows/cross-platform) or `./MacOS_START.command` (macOS/Linux); both bind **only** to `127.0.0.1`:

| Endpoint | Purpose |
|---|---|
| `ws://127.0.0.1:17613` | Primary multiplexed WebSocket (`call_tool`, `batch`, `team_*`, `verify`, `team_event` push) |
| `http://127.0.0.1:17614/api/call` | Single-attempt REST tool execution (with `member_id` role enforcement + virtual `team_*`) |
| `http://127.0.0.1:17614/api/batch` | Sequential bounded batch (`≤24` calls, non-transactional, role-checked) |
| `http://127.0.0.1:17614/api/verify` | Read-only Studio ground-truth verification returning SHA-256 digest + UTC timestamp |
| `http://127.0.0.1:17614/api/team/*` | Team mailboxes (`register`, `start`, `ready`, `send`, `inbox`, `ack`, `stop`, `leave`, `summary`, `events?wait=1`) |
| `http://127.0.0.1:17614/api/agent_temp` | Bounded TTL agent-hub scratch storage |
| `http://127.0.0.1:17614/api/events` | Server-Sent Events stream (`status` + `team_event`) |
| `http://127.0.0.1:17614/health` | Unauthenticated liveness + version (`4.6.0`) |

## Authentication & Role Safety

- All state-changing and team endpoints require `.zs_token` (`X-ZS-Token`, `Authorization: Bearer`, or `?token=` on WS/SSE), generated on first run with mode `0600`.
- When a tab belongs to a bridge team, `TeamHub.check_mutation` enforces **coder-only** Studio mutations (`planner` and `checker` write attempts are rejected and logged as `role_violation` / `[ROLE-BLOCKED]` in `team_console.py`).
- Run `python ../../scripts/sync_copies.py --write` from this folder (or `python scripts/sync_copies.py --write` from the repo root) after editing canonical files so compatibility mirrors stay byte-identical.
