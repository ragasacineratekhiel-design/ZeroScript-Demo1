# ZeroScript V2 — Claude + All AI Roblox Studio Agent (v3.1.0)

> **ZeroScript V2 × Roblox Studio Agent (v3.1.0)** — Name you see in `chrome://extensions` is **ZeroScript MAX × Roblox Studio Agent**.
> Supports **14 AI sites**: ChatGPT, DeepSeek, Gemini, **Claude**, Kimi, GLM, Qwen, Arena, Meta AI, Perplexity, Copilot, Grok, Poe, Mistral.

Control **every part of Roblox Studio** with any AI chat — scripts, Luau, explorer tree, assets, **Play mode (start/stop/is_start)**, all game settings & services. No API key needed.

It's a Chrome/Edge extension + local bridge to Studio's official MCP server.

## What's new in v3.1.0 — Team Roles + Ground Truth + Bridge Team Hub

- **Team roles (ENFORCED):** `planner` plans only and never runs write commands; `coder` is the ONLY role that writes/changes code; `checker` verifies and REPORTS but never edits — the coder makes the changes; `lead` = full access (default). Switch with `{"command":"set_role","params":{"role":"planner|coder|checker"}}`, or tag one command with `"role":"…"`. Violations are rejected mechanically (ROLE VIOLATION) before any write tool can run — and the hub rejects role-violating message kinds (planner/checker can never post `code`).
- **`/truth` is a real command:** writing `/truth` (or `{"command":"truth"}`) runs a ground-truth check — fresh Studio probe, real bridge/server health, and the ledger of tool calls that ACTUALLY executed with their real outcomes. Never accept unverified claims: statements without a tool result behind them must say "not verified".
- **Team hub:** `team_msg` / `team_read` route role-checked messages (kind `plan|code|check|handoff|msg|note`) through the bridge hub — visible in the bridge console and `team.py`. `/plan <text>` and `/check <text>` slash commands post as planner/coder-verified hand-offs.
- **Popup:** role selector (Lead/Planner/Coder/Checker/Observer) + **Ground truth** readout.

## Install (V2)

1. `chrome://extensions` (or `edge://extensions`) → enable **Developer mode** (top-right)
2. **Load unpacked** → select the **`zeroscript-extension-v2`** folder at the repo root
   - You will see **ZeroScript MAX × Roblox Studio Agent 3.1.0** — if you still see an old version, click **Remove** on the old card first, then Load unpacked again, then **Reload**.
3. Bridge: double-click `start.bat` (Windows) / `MacOS_Start.command` (macOS) — the bridge window now has an interactive console (`help` for commands).
4. Optional team console: `python team.py` (auto-starts the bridge; `--truth` prints the ground-truth report and exits).
5. In Studio: **Assistant AI → … → Manage MCP Servers → Enable Studio as MCP Server**
6. Open any supported AI — claude.ai, chat.deepseek.com, chatgpt.com, gemini.google.com, etc. — new chat → **Start session** in the ZeroScript panel.

Why `zeroscript-extension-v2` at root? The old nested path `ZeroScript Demo/.../zeroscript-extension` has spaces and was not showing as V2 on GitHub main. The root copy is the same extension, just easier to load.

## Claude

Go to https://claude.ai → new chat → panel appears via **Switch AI → Claude**. Same tools: run Luau, edit scripts, inspect tree, play mode. Team roles + `/truth` work here too.

## All AI (Perplexity/Copilot/Grok/Poe/Mistral)

Universal `providers/generic.js` fallback — any of perplexity.ai, copilot.microsoft.com, grok.com, poe.com, chat.mistral.ai works. For best stability use DeepSeek/Claude/ChatGPT.

## Architecture (for contributors)

```
core/config.js        system prompt + team roles + truth rules + OP methods (global ZS)
core/parser.js        command parsing incl. role tags + /truth slash commands (global ZSParse)
core/main.js          agentic loop, enforced role gate, truth ledger, UI (uses ZSProvider)
providers/deepseek.js per-site DOM + generation detection + send (global ZSProvider)
providers/gemini.js   Google Gemini
providers/claude.js   Claude (claude.ai)
providers/generic.js  Universal fallback — Perplexity/Copilot/Grok/Poe/Mistral/any AI
providers/perplexity.js wrapper → generic, etc.
background.js         WebSocket/HTTP to bridge + team hub routing (provider-agnostic)
manifest.json         14 hosts + 16 content_scripts, v3.1.0
popup.html/js         v3.1.0 badge, role selector, ground-truth readout, bridge status
```

Add a provider: write `providers/<site>.js` on the ZSProvider interface, add its URL to `manifest.json` + `PROVIDER_URLS` in `background.js`. No core change.

## Troubleshooting: still seeing old version / HTML doesn't work

- Hard-refresh the repo page (Ctrl+Shift+R).
- In `chrome://extensions`, the card title must say **ZeroScript MAX × Roblox Studio Agent**. If it says anything else, you loaded the old nested folder — Remove it, Load unpacked → `zeroscript-extension-v2`.
- Opening `popup.html` directly as a file shows a static preview — it only goes live as an extension popup. The HTML itself is valid; the popup needs `chrome.runtime` which is extension-only.

## Support

☕ [Ko-fi](https://ko-fi.com/sebattfg)
