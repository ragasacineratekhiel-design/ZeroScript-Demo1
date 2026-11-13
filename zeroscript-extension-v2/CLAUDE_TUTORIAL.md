# ZeroScript MAX 4.8.0 — Claude & Multi-AI Setup Guide

This guide covers connecting **Claude (`claude.ai`)** — either solo or as part of a 3-AI **Planner / Coder / Checker** bridge team — to Roblox Studio.

## 1. Install & Launch Bridge

1. Ensure **Python 3.9+** and `websockets` (`python -m pip install -r requirements-dev.txt`) are installed.
2. Start the local bridge from `ZeroScript Demo/ZeroScript-Free-1.5.5/`:
   - **Windows:** `py -3 start.py` (opens the bridge + `ZeroScript Team Console`)
   - **macOS / Linux:** `./MacOS_START.command` (and optional `python3 team_console.py` in a second terminal)
3. In **Roblox Studio**: open a place → **Assistant → Manage MCP Servers → Enable Studio as MCP Server**.
4. In **Chrome / Edge**: open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `zeroscript-extension-v2/` (card must read **4.8.0**).

## 2. Solo Agent Mode on Claude

1. Open `https://claude.ai/new` while signed in. The ZeroScript bar mounts in its own sibling slot above the composer:
   ```
   ● Standby. Start the agent, or just chat.  [▶ Start Roblox agent]
   ```
2. Click **`▶ Start Roblox agent`** on a fresh chat. `ZSClaudeConnector` verifies both the bridge and Studio in parallel (`Promise.all` with short TTL cache) and boots the session.
3. Even when Claude redirects from `/new` to `/chat/<uuid>` on the first turn, 4.6.0's hostname-aware `isLandingKey()` keeps the running loop and session pinned cleanly without dropping the first command.

## 3. Bridge Team Mode (two or more agents)

1. Open **two or more** different AI tabs (the full set: **Claude** = `planner`, **DeepSeek** = `coder`, **Gemini** = `checker`).
2. In the ZeroScript popup on each tab, keep the same **Team** name (`studio`), select that tab's role, and click **Join active AI tab**. Check the live `#team-roster` line in the popup.
3. Click **Start all joined team tabs (2 or more)**. Role prompts submit concurrently and team messages route over WebSocket + 0 ms Condition long-poll. `start.py` prints the joined agents and the bare chat live; `team_console.py` adds UTC timestamps.
4. **Ordered chat (4.8.0):** the bridge introduces one role at a time in the order of the roles that joined, re-asks a silent tab, and then drives **plan → implement → review → fix** (planner sends the plan **with reference code**, coder sends the evidence, checker sends the defects **with the exact fix**).
5. **Enforced role boundaries (unchanged):**
   - **Planner** (`read-only`): inspects Studio and sends the plan + reference code via `team_send`. Any `execute_luau` / `multi_edit` attempt is blocked (`ROLE VIOLATION`).
   - **Coder** (`mutates Studio`): the **only** role permitted to run `execute_luau`, `multi_edit`, and Studio write tools.
   - **Checker** (`read-only`): audits scripts/instances (`script_read`, `inspect_instance`, `verify_fact`, `start_stop_play`) and sends defect reports with the exact fix back to `coder` via `team_send` — it never edits.

## 4. Truthful Transport & `/truth` Verification (No Fake Claims)

- **Real transports:** WebSocket (`ws://127.0.0.1:17613`), HTTP REST (`http://127.0.0.1:17614`), and SSE (`/api/events`), authenticated with `.zs_token`. Mutations execute **once** (never hedged or silently replayed). There is no WebTransport or msgpack requirement.
- **Verified `/truth` mode:** Prefix prompts with `/truth` (or `/brutal-honest`, `/0%-lies`) to require live Studio read evidence. Agents can call:
  ```json
  {"command":"verify_fact","params":{"path":"game.Workspace","tool":"inspect_instance"}}
  ```
  which queries `/api/verify` and stamps the output with a SHA-256 digest and UTC timestamp (or reports `NOT VERIFIED` if Studio is offline).

## 5. Troubleshooting

- **Bridge offline:** run `python start.py --check` or `./MacOS_START.command --check` to verify Python and `websockets`.
- **Toolbar hidden after a site update:** open the extension popup and click **Restore toolbar** (`zs-recover-toolbar`).
- **Play mode active during edits:** stop Play mode first (`start_stop_play {"is_start": false}`) so edits apply to the `Edit` DataModel rather than a temporary runtime session.
