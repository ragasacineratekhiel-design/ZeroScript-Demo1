# ZeroScript MAX ULTRA 3.2 — Claude + All AI Roblox Studio Agent

> **ZeroScript MAX × Roblox Studio Agent (v3.2.0 ULTRA)** — Name you see in `chrome://extensions` is **ZeroScript MAX**.
> Supports **15 AI sites**: ChatGPT, DeepSeek, Gemini, **Claude MAX (custom fieldset connector)**, Kimi, GLM, Qwen, Arena, Meta AI, Perplexity, Copilot, Grok, Poe, Mistral — all ULTRA-wired to Studio.

Control **every part of Roblox Studio** with any AI chat — scripts, Luau, explorer tree, assets, **Play mode (start/stop/is_start)**, all game settings & services. No API key needed. **ULTRA transport: hedge 80ms, batch 24, never drops.**

It's a Chrome/Edge extension + local bridge to Studio's official MCP server.

## What's new in ULTRA 3.2 (Everything upgraded)

- **Claude MAX ULTRA**: dedicated custom connector `providers/claude-connector.js` + fieldset-aware `providers/claude.js` (2026 Claude redesign) — ProseMirror inside `fieldset`, 80ms hedge, sits on chatbar with **zero GUI/color change**
- **Memory Wall** `core/memory_wall.js`: persistent cross-session project memory (Overview / Where live / Conventions / Key systems / Decisions / Prefs / TODO / Timeline) — chrome.storage + beacon + Studio ModuleScript
- **Bad → Best prompt optimizer** `core/prompt_enhancer.js`: turns "make a game" into publish-ready spec (8 themes) automatically
- **Transport ULTRA**: WebSocket + HTTP/REST + SSE + Long-Poll + BroadcastChannel (single WS leader) + Batch + Binary — hedge **80ms** (was 120), cache 500ms, retry 2, never hangs
- **Agent Stability ULTRA** `core/agent_stability.js`: fieldset fallbacks, 800ms idle, 1.5s Studio poll, 10s keepalive with Web Locks — stable in Play mode on all 15 AIs
- **Universal fallback** `providers/generic.js` ULTRA: works on any AI chat site, fieldset-aware, 1.6s idle
- All 15 AIs now MAX-wired — Perplexity/Copilot/Grok/Poe/Mistral upgraded to ULTRA wrappers

No GUI, colors, or text changed — pure logic MAX speed.

## Install — Load this folder

1. `chrome://extensions` → **Developer mode** ON
2. **Load unpacked** → select **`zeroscript-extension-v2`** at repo root → card must say **ZeroScript MAX × Roblox Studio Agent 3.2.0**
3. Bridge: double-click `start.bat` (Win) / `MacOS_Start.command` (macOS)
4. Studio: **Assistant → … → Manage MCP Servers → Enable Studio as MCP Server**
5. Open any AI (claude.ai, chat.deepseek.com, etc.) → new chat → **▶ Start** in ZeroScript panel

## Architecture

```
core/config.js              APP 3.2.0 ULTRA, TRANSPORT hedge 80ms, system prompt (MAX control + anti-hallucination)
core/parser.js              command parsing (pure strings)
core/memory_wall.js         Memory Wall — cross-session notes
core/prompt_enhancer.js     Bad→Best optimizer — local, <2ms
core/transport.js           thin client to background (cache 500ms, retry 2, batch 24)
core/agent_stability.js     hardened editor + generation + keepalive (ULTRA)
core/main.js                agentic loop, UI, camouflage (uses ZSProvider)
providers/deepseek.js       DeepSeek
providers/chatgpt.js/.cm.js ChatGPT
providers/claude.js         Claude ULTRA (fieldset + ProseMirror)
providers/claude-connector.js Claude custom connector (handshake + Studio bridge)
providers/gemini.js / kimi.js / glm.js / qwen.js / arena.js / meta.js
providers/generic.js        Universal fallback
providers/perplexity|etc    Thin ULTRA wrappers
background.js               ULTRA service worker (hedge HEDGE_MS, leader election, BroadcastChannel)
manifest.json               22 host_permissions, 16 content_scripts, v3.2.0
overlay.css                 bar + chips + menu (ULTRA perf will-change)
popup.html/js               3.2.0 badge, bridge status
```

## Troubleshooting

- Card must say **3.2.0** — if old, Remove old → Load unpacked `zeroscript-extension-v2` → Reload
- Bridge offline → run `start.bat`, check http://127.0.0.1:17614/api/status
- `popup.html` opened as file:// is static preview — needs chrome.runtime as extension popup
