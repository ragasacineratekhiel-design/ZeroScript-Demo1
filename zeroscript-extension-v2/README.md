# ZeroScript V2 — Claude + All AI Roblox Studio Agent

> **ZeroScript V2 × Roblox Studio Agent (v2.3.0)** — Name you see in `chrome://extensions` is **ZeroScript V2**.
> Supports **14 AI sites**: ChatGPT, DeepSeek, Gemini, **Claude**, Kimi, GLM, Qwen, Arena, Meta AI, Perplexity, Copilot, Grok, Poe, Mistral.

Control **every part of Roblox Studio** with any AI chat — scripts, Luau, explorer tree, assets, **Play mode (start/stop/is_start)**, all game settings & services. No API key needed.

It's a Chrome/Edge extension + local bridge to Studio's official MCP server.

## Install (V2) — FIXED

1. `chrome://extensions` (or `edge://extensions`) → enable **Developer mode** (top-right)
2. **Load unpacked** → select the **`zeroscript-extension-v2`** folder at the repo root
   - You will see **ZeroScript V2 × Roblox Studio Agent 2.3.0** with icon — if you still see the old version, click **Remove** on the old card first, then Load unpacked again, then **Reload**.
3. Bridge: double-click `start.bat` (Windows) / `MacOS_Start.command` (macOS)
4. In Studio: **Assistant AI → … → Manage MCP Servers → Enable Studio as MCP Server**
5. Open any supported AI — claude.ai, chat.deepseek.com, chatgpt.com, gemini.google.com, etc. — new chat → **Start session** in the ZeroScript panel.

Why `zeroscript-extension-v2` at root? The old nested path `ZeroScript Demo/.../zeroscript-extension` has spaces and was not showing as V2 on GitHub main. The root copy is the same V2 extension, just easier to load.

## Claude

Go to https://claude.ai → new chat → panel appears via **Switch AI → Claude**. Same tools: run Luau, edit scripts, inspect tree, play mode.

## All AI (Perplexity/Copilot/Grok/Poe/Mistral)

Universal `providers/generic.js` fallback — any of perplexity.ai, copilot.microsoft.com, grok.com, poe.com, chat.mistral.ai works. For best stability use DeepSeek/Claude/ChatGPT.

## Architecture (for contributors)

```
core/config.js        system prompt + OP methods + Studio total control (global ZS)
core/parser.js        command parsing — pure strings (global ZSParse)
core/main.js          agentic loop, UI, camouflage (uses ZSProvider)
providers/deepseek.js per-site DOM + generation detection + send (global ZSProvider)
providers/gemini.js   Google Gemini
providers/claude.js   Claude (claude.ai / claude.ai)
providers/generic.js  Universal fallback — Perplexity/Copilot/Grok/Poe/Mistral/any AI
providers/perplexity.js wrapper → generic, etc.
background.js         WebSocket to bridge (provider-agnostic)
manifest.json         14 hosts + 16 content_scripts, v2.3.0
popup.html/js         shows v2.3.0 badge, handles hosts, bridge status
```

Add a provider: write `providers/<site>.js` on the ZSProvider interface, add its URL to `manifest.json` + `PROVIDER_URLS` in `background.js`. No core change.

## Troubleshooting: still seeing old version / HTML doesn't work

- GitHub now shows main at v2.3.0 (merged 2026-10-27). Hard-refresh the repo page (Ctrl+Shift+R).
- In `chrome://extensions`, the card title must say **ZeroScript V2 × Roblox Studio Agent**. If it says anything else, you loaded the old nested folder — Remove it, Load unpacked → `zeroscript-extension-v2`.
- Opening `popup.html` directly as a file shows a static preview — it only goes live as an extension popup. The HTML itself is valid; the popup needs `chrome.runtime` which is extension-only.

## Support

☕ [Ko-fi](https://ko-fi.com/sebattfg)
