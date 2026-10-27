# ZeroScript MAX × Roblox Studio Agent — All AI + Claude (v3.4.0 ULTRA)

> **Install — ONE extension only:** `chrome://extensions` → Developer mode → **Load unpacked** → select **`zeroscript-extension-v2/`** in this repo. You should see card title **ZeroScript MAX × Roblox Studio Agent 3.4.0**.
>
> ⚠️ **If you previously loaded `zeroscript-extension/` (legacy root copy) — REMOVE it:** In `chrome://extensions` click **Remove** on the old card (version ≤3.3.0 showing path `zeroscript-extension`), keep only the `zeroscript-extension-v2` card. Loading both causes host conflicts (Mode not ready, GUI missing).

This repo serves **ZeroScript MAX** (15 AI sites, all Studio services). `main` is MAX 3.4.0 — hard-refresh (Ctrl+Shift+R) if you saw an older version.

- **Folder to load:** `zeroscript-extension-v2/` (the ONLY extension folder — legacy `zeroscript-extension/` was removed to prevent duplicates)
- **Supports:** chat.deepseek.com, chatgpt.com, gemini.google.com, **claude.ai**, kimi.ai, chat.z.ai, chat.qwen.ai, arena.ai, meta.ai, perplexity.ai, copilot.microsoft.com, grok.com, poe.com, chat.mistral.ai (+ subdomains) — **all 15 fully wired with GUI bar on chatbar**
- **Full Studio control:** scripts, explorer, assets, Play START/STOP, all game settings/services, self-heal syntax correction
- **Bridge:** `start.bat` / `MacOS_Start.command` → enable **Studio as MCP Server** in Studio first

See `zeroscript-extension-v2/README.md` for full docs + `CLAUDE_TUTORIAL.md` for Claude.

## Why only one extension folder?
Previous repo had two identical copies (`zeroscript-extension/` and `zeroscript-extension-v2/`) causing "2 extensions" and background leader-election collisions. `v3.4.0` removes the duplicate; `zeroscript-extension-v2` is the single source of truth. `ZeroScript Demo/...` archive is untouched reference.
