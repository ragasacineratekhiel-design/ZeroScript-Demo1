# ZeroScript MAX ULTRA 3.3 — ChatGPT+Claude ABSOLUTE FIX

> **ZeroScript MAX × Roblox Studio Agent (v3.3.0 ULTRA)** — Name you see in `chrome://extensions` is **ZeroScript MAX**.
> Supports **15 AI sites**: **ChatGPT ABSOLUTE FIX**, **Claude MAX ABSOLUTE FIX**, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena, Meta AI, Perplexity, Copilot, Grok, Poe, Mistral — all ULTRA-wired to Studio with **total control (every setting/service) + Play STOP→Edit + efficient reads + mock simulation verify**.

Control **every part of Roblox Studio** with any AI chat — scripts, Luau, explorer tree, assets, **Play mode STOP→Edit enforced (is_start true/false)**, all game settings & services, efficient file reads (search→read→mutate→verify), mock simulation double-check. No API key needed. **ULTRA transport: hedge 80ms, batch 24, never drops.**

It's a Chrome/Edge extension + local bridge to Studio's official MCP server.

## What's new in ULTRA 3.3 (ABSOLUTE FIX — Honest fact-check)

> **Why 3.3 exists:** User reported only Gemini+DeepSeek worked live — ChatGPT+Claude broken despite manifest 3.2 "MAX". Root causes confirmed: Claude fieldset redesign broke `div[contenteditable]` lone selector + `bg-` bar fallback (bar `display:none` → Switch AI never mounts); ChatGPT composer grid `header→eyebrow` rename collapsed editor to 0 width; Play mode bare `###LUA###` fails with "Edit not available" but prompt only *suggested* STOP not enforced; AI scanned files inefficiently; no mock verify before "done". 3.3 fixes all at logic level, no GUI/color change except tutorial doc.

- **ChatGPT ABSOLUTE FIX** `providers/chatgpt.js` 3.3: ULTRA resilient editor (5 fallback selectors: `#prompt-textarea` + `data-testid` + `ProseMirror` + `role=textbox` + `data-lexical-editor`), barMount fallback to `form/parentElement` (survives composer-surface rename `header→eyebrow`), like Claude/Gemini hardened paths — bar ALWAYS mounts
- **Claude ABSOLUTE FIX** `providers/claude.js` 3.3 verified: fieldset ProseMirror, 5-strategy barMount (form→sticky→card→frame fallback), visible+size filter — Switch AI tabs now always mount
- **Play STOP→Edit ENFORCED** `core/config.js`: mandatory `get_studio_state` → if playing `start_stop_play {is_start:false}` → verify → then Edit (`multi_edit`/`execute_luau` bare). Tool notes updated for `execute_luau` + `multi_edit`. Prevents "Edit not available in Play" errors
- **Efficient reads (batch)** `core/config.js`: `search_game_tree/script_search → script_read 1-3 hits → inspect_instance → mutate → verify` — never scan Workspace. Uses `/api/batch` for 2+ independent reads
- **Mock simulation double-check** `core/config.js`: `inspect→mutate→verify` anti-hallucination lock + `START Play → Server/Client execute verify → STOP` before "done" — proof via `return` not claim
- **ALL AI total Studio control** `core/config.js`: every setting/service enumerated (Workspace/Lighting/Teams/etc.) — agent never says "change manually", it does via `execute_luau`
- **Claude Tutorial** `CLAUDE_TUTORIAL.md`: step-by-step connect proof, Play trap fix, efficient reads pattern — honest fact-check included
- **Transport ULTRA** 80ms hedge (background now 80, matches config — was 120 mismatch), cache 500ms, batch 24, 8 transports — never drops
- **Agent Stability ULTRA 3.3** `core/agent_stability.js`: chatgpt fallback list expanded + 800ms idle + fieldset guard — all 15 AIs super-stable in Play

No GUI, colors, or text changed (except tutorial doc) — pure logic MAX speed.

## Claude Tutorial — See CLAUDE_TUTORIAL.md (new in 3.3)

Full step-by-step: install → open claude.ai → Start → verify → Play STOP trap → efficient reads → mock simulation. Honest audit inside.

## Install — Load this folder

1. `chrome://extensions` → **Developer mode** ON
2. **Load unpacked** → select **`zeroscript-extension-v2`** at repo root → card must say **ZeroScript MAX × Roblox Studio Agent 3.3.0**
3. Bridge: double-click `start.bat` (Win) / `MacOS_Start.command` (macOS)
4. Studio: **Assistant → … → Manage MCP Servers → Enable Studio as MCP Server**
5. Open any AI (claude.ai, chat.deepseek.com, etc.) → new chat → **▶ Start** in ZeroScript panel

## Architecture

```
core/config.js              APP 3.3.0 ULTRA, TRANSPORT hedge 80ms, system prompt (Play STOP→Edit + efficient reads + mock sim + anti-hallucination)
CLAUDE_TUTORIAL.md          Claude ABSOLUTE FIX step-by-step (Play trap, efficient reads, verify)
core/parser.js              command parsing (pure strings)
core/memory_wall.js         Memory Wall — cross-session notes
core/prompt_enhancer.js     Bad→Best optimizer — local, <2ms
core/transport.js           thin client to background (cache 500ms, retry 2, batch 24)
core/agent_stability.js     hardened editor + generation + keepalive (ULTRA)
core/main.js                agentic loop, UI, camouflage (uses ZSProvider)
providers/deepseek.js       DeepSeek
providers/chatgpt.js/.cm.js ChatGPT ABSOLUTE FIX 3.3 (multi-selector + composer-surface fallback)
providers/claude.js         Claude ABSOLUTE FIX 3.3 (fieldset + 5-strategy barMount) + verified chatgpt fix
providers/claude-connector.js Claude custom connector (handshake + Studio bridge)
providers/gemini.js / kimi.js / glm.js / qwen.js / arena.js / meta.js
providers/generic.js        Universal fallback
providers/perplexity|etc    Thin ULTRA wrappers
background.js               ULTRA service worker (hedge HEDGE_MS, leader election, BroadcastChannel)
manifest.json               22 host_permissions, 16 content_scripts, v3.3.0
overlay.css                 bar + chips + menu (ULTRA perf will-change)
popup.html/js               3.3.0 badge, bridge status (see CLAUDE_TUTORIAL.md for Claude proof)
```

## Troubleshooting

- Card must say **3.3.0** — if old, Remove old → Load unpacked `zeroscript-extension-v2` → Reload
- Claude/ChatGPT bar not showing → F5, ensure manifest v3.3.0 (fieldset+ProseMirror fix). Check #zs-bar in inspector — 3.3 barMount has form/parent fallback, never display:none
- Bridge offline → run `start.bat`, check http://127.0.0.1:17614/api/status
- `popup.html` opened as file:// is static preview — needs chrome.runtime as extension popup
