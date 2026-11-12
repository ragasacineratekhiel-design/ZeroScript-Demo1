# Integration with main — 4.6.0

Main and the bridge-team architecture are unified at **4.6.0** with zero verifier warnings and zero P0/P1/P2 deep-audit findings.

## Retained & upgraded from main
- Module-scoped execution/session state (`SESSION`), Single/Continuous/Loop modes and bounded turn budgets.
- Slash-command prompt enhancer (`/truth`, `/code`, `/prompt`, `/force`, `/smart` plus `/brutal-honest`, `/0%-lies`, `/follow-everything`, `/absolute-effort`), static Luau analyser with immutable result caching, query-cached memory wall, event-driven plan wall, peer wall (`lmarena.ai`, `z.ai`, `qwen.ai`, `mistral.ai` host parity) and role assignment UI.
- Safe-error instrumentation (`core/safe.js`), shared runtime client (`core/transport.js`, wired into all 14 main content-script blocks), connected-editor DOM caches, virtualization-safe `itemKey`/`lastAssistantId`, reachable SPA/stability hooks across all providers, and post-`return` AST dead-code verification.
- Composer stays user-accessible: team startup and inbox delivery never reintroduce input locking or opaque covers.

## Bridge team, role enforcement & `/truth` upgrades in 4.6.0
- **Real-time bridge team delivery**: `threading.Condition` 0 ms long-poll (`/api/team/events?wait=1`), thread-safe WS + SSE `team_event` push, WS-first `team_status`/`inbox`/`ack`/`send`/`ready`, `pendingWake` post-turn drain, hostname-aware `isLandingKey()` so `/new` → `/chat/<uuid>` redirects never drop team membership or abandon the first turn, and strict `PromptEnhancer`/`MemoryWall` isolation so `expectedPrefix` always matches submitted text.
- **3-layer role boundaries**: `planner` and `checker` are read-only + `team_*`; **only `coder` can mutate Studio** (`execute_luau`, `multi_edit`, `studio_exec`, `studio_bulk`, etc.), enforced in `core/main.js` (`runTool` + `handleWallTask`), `background.js` (`roleCheckTool` + `member_id`), and `bridge.py`/`team_hub.py` (`check_mutation` + `[ROLE-BLOCKED]` events). Solo single-AI sessions remain unrestricted.
- **Verified `/truth` execution**: `verify_fact` / `/api/verify` executes real read-only Studio probes (`inspect_instance`, `script_read`, `get_studio_state`, `search_game_tree`, `list_roblox_studios`) and returns SHA-256 digests + UTC timestamps; `main.js` counts only `r.ok` reads and stamps outputs `[VERIFIED via …]`.
- **Popup & CLI observability**: `#team-roster` displays live bound roles in the popup; `team_console.py` adds `--status`, `--json`, exponential backoff, and `[ROLE-BLOCKED]` highlighting; `start.py` (`VERSION = "4.6.0"`) and `MacOS_START.command --check` validate config and dependencies cleanly.

## Validation and honest limits
Run `.venv/bin/python scripts/validate.py` to execute mirror sync verification (`55` files), Python `unittest` suites (`42` tests), `npm run verify` (all 9 check groups + 12 assertion suites + ablation boot), `npm run test:team` (extension, multi-scenario team DOM with MemoryWall+PromptEnhancer, Claude DOM, 14-provider startup, popup), and `node tools/audit-deep.js` (`P0=0, P1=0, P2=0`). Local tests use mocked MCP/DOM fixtures and do not certify live third-party website changes, Windows desktop behavior, or live Roblox Studio sessions.
