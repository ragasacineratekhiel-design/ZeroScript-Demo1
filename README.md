# ZeroScript V2 × Roblox Studio Agent — All AI + Claude (v3.1.0)

> **Install:** `chrome://extensions` → Developer mode → **Load unpacked** → select **`zeroscript-extension-v2/`** in this repo. Card title: **ZeroScript MAX × Roblox Studio Agent 3.1.0**.

This repo serves **ZeroScript V2 / MAX 3.1** (Claude + 14 AI sites). v3.1 is the **Team Roles + Ground Truth + Bridge Team Hub** release:

- **Team roles are ENFORCED.** `planner` plans only (never writes code), `coder` is the ONLY role that writes/changes code, `checker` verifies and REPORTS but never edits — the coder makes the changes. Violations are rejected mechanically (ROLE VIOLATION before any write tool runs; the hub rejects role-violating messages too). Switch with `{"command":"set_role","params":{"role":"planner|coder|checker"}}` or tag a command with `"role":"…"`.
- **`/truth` is a real command now.** Writing `/truth` (or `{"command":"truth"}`) runs a ground-truth check: fresh Studio probe, real bridge/server health, and the ledger of tool calls that actually executed — never model claims. Unverified statements must be labelled "not verified".
- **The bridge is a team console & hub.** `bridge.py` hosts an interactive console (`help/status/tools/truth/hub/say/call`) and a role-aware message hub the AI team communicates through (`team_msg`/`team_read`, `/api/hub`); `python team.py` opens the standalone Team Console & Hub.
- **Parallel tool calls.** The bridge no longer serializes tool calls behind one lock — one slow `execute_luau` can't block everything else (this was the "AI can't communicate through the bridge" bug).

## Files

- **Folder to load:** `zeroscript-extension-v2/` (root) — same as `ZeroScript Demo/ZeroScript-Free-1.5.5/zeroscript-extension/` but without the spaced path.
- **Bridge:** `ZeroScript Demo/bridge.py` (also mirrored inside `ZeroScript Demo/ZeroScript-Free-1.5.5/`) — run `start.bat` / `MacOS_START.command`, or `python bridge.py`.
- **Team console:** `ZeroScript Demo/team.py` — `python team.py` (auto-starts the bridge; `--truth` prints the ground-truth report and exits).
- Supports: chat.deepseek.com, chatgpt.com, gemini.google.com, **claude.ai**, kimi.ai, chat.z.ai, chat.qwen.ai, arena.ai, meta.ai, perplexity.ai, copilot.microsoft.com, grok.com, poe.com, chat.mistral.ai
- Full Studio control: scripts, explorer, assets, Play mode start/stop, all game settings/services
- Bridge prerequisite: enable **Studio as MCP Server** in Roblox Studio first.

See `zeroscript-extension-v2/README.md` for full docs, and `ZeroScript Demo/ZeroScript-Free-1.5.5/CHANGELOG.md` for the complete v3.1.0 change list.

## Legacy nested path

`ZeroScript Demo/ZeroScript-Free-1.5.5/zeroscript-extension/` still exists and is also MAX 3.1.0 — it is the source; the root copy is for convenience. All three code trees (`zeroscript-extension-v2/`, the nested extension, and the bridge scripts) are kept in sync.
