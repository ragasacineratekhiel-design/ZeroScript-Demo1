# ZeroScript bridge (local MCP bridge)

`bridge.py` connects the browser extension to Roblox Studio's MCP server. It is started by
`start.bat` (Windows) or `MacOS_START.command` (macOS) and listens **only** on loopback:

| Endpoint | Purpose |
|---|---|
| `ws://127.0.0.1:17613` | Primary transport (multiplexed, deflate) |
| `http://127.0.0.1:17614/api/call` | REST fallback for one tool call |
| `http://127.0.0.1:17614/api/batch` | Several read-only calls in one round trip |
| `http://127.0.0.1:17614/api/agent_temp` | Agent-hub temp storage (TTL, bounded) |
| `http://127.0.0.1:17614/api/events` | SSE status stream |
| `http://127.0.0.1:17614/health` | Liveness + version |

## Auth

Every state-changing endpoint requires the bridge token (`X-ZS-Token` header, `Authorization: Bearer`,
or `?token=` for SSE). The token is generated on first run into `.zs_token` (mode 0600) and handed to the
extension over the WebSocket `connected` frame.

`/health`, `/api/status` and `/api/metrics` stay readable without a token so the popup and installers can
check health. `ZS_NO_AUTH=1` disables auth entirely — only for a machine you control.

## Notes

- The bridge writes `logs/bridge_debug.log`, which contains tool names **and arguments** (your Lua).
  It is git-ignored; treat it as sensitive and delete it freely.
- `ZeroScript Demo/bridge.py` is a symlink to this file. Run `tools/sync-bridge.sh` from the repo root
  after editing, or on checkouts where symlinks were flattened.
