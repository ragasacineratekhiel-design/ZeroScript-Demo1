# ZeroScript MAX ULTRA 3.4 — UNIVERSAL AI + Syntax Auto-Correct

> **ZeroScript MAX × Roblox Studio Agent (v3.4.0 ULTRA)** — Name you see in `chrome://extensions` is **ZeroScript MAX**.
> Supports **15 AI sites — ALL FIXED**: **ChatGPT UNIVERSAL FIX**, **Claude UNIVERSAL FIX**, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena, Meta AI, Perplexity, Copilot, Grok, Poe, Mistral — all ULTRA-wired to Studio with **total control + Play STOP→Edit + syntax auto-correct + self-heal STOP-on-mistake**.

Control **every part of Roblox Studio** with any AI chat — scripts, Luau, explorer tree, assets, **Play mode STOP→Edit enforced**, syntax self-heal (STOP→verify→fix→verify like Play), all game settings & services, efficient batch reads, mock simulation double-check. No API key needed. **ULTRA transport: hedge 80ms, batch 24, never drops.**

It's a Chrome/Edge extension + local bridge to Studio's official MCP server.

## What's new in ULTRA 3.4 (UNIVERSAL FIX — Honest fact-check)

> **Why 3.4 exists:** User reported official supports all AI but this build only Gemini+DeepSeek worked — Claude/ChatGPT showed no GUI, Mode not ready, 2 extensions host conflict. Root causes: fieldset-only selector missed new Claude DOM, #prompt-textarea-only missed ChatGPT redesign; duplicate `zeroscript-extension/` folder caused leader-election collision; no auto syntax fix when AI produced bad Luau.

- **Claude UNIVERSAL FIX** `providers/claude.js` 3.4: bottom-scan editor (scans 10 selectors, picks lowest Y — survives ANY redesign), 6-strategy barMount (form→sticky→fieldset→card→frame→parent fallback — never null if editor exists), overlayBlocking helper → **GUI always mounts on top of chatbar**
- **ChatGPT UNIVERSAL FIX** `providers/chatgpt.js` 3.4: bottom-scan editor (priority #prompt-textarea + composer-input + ProseMirror + lexical + textarea + generic), 4-strategy barMount (composer-surface with dynamic eyebrow/header → form → wrap → parent chain) — survives grid `header→eyebrow` rename — **editor never collapses to 0 width**
- **Agent Stability 3.4** `core/agent_stability.js`: FALLBACKS expanded (claude+chatgpt 6+ selectors), bottom-biased hardenedGetEditor (picks lowest Y, not first match), fieldset guard — super-stable during Studio Play
- **Single-extension de-dupe** Root: removed duplicate `zeroscript-extension/` legacy copy; `README.md` now warns to Remove old card (keep only `zeroscript-extension-v2`). Manifest 3.4.0 de-dupe description included
- **Syntax auto-correction + self-heal STOP-on-mistake** `core/config.js` 3.4: new mandatory rule — on ANY error (`syntax`, `Failed to parse`, `nil value`, `unexpected`) → script_read → fix missing end/quote/paren/api/type → retry ≤3. Same universal STOP-loop for ANY self-mistake (hallucinated path/property, failed test): `get_studio_state→start_stop_play false→verify→correct→verify` — **exactly like Play mode handling**. New diagram + TOOL_NOTES updated for both `execute_luau` + `multi_edit`
- **Switch AI tabs on chatbar** `providers/*` barMount inside logic only — designs/colors/GUI text unchanged — tabs switch via existing menu (no redesign)
- **Transport ULTRA** 80ms hedge, cache 500ms, batch 24, 8 transports — super-fast, never drops, Switch AI instant

No GUI, colors, or text changed — pure logic MAX speed + self-heal.

## Claude Tutorial — See CLAUDE_TUTORIAL.md (new in 3.3)

Full step-by-step: install → open claude.ai → Start → verify → Play STOP trap → efficient reads → mock simulation. Honest audit inside. 3.4 adds syntax self-heal chapter.

## Install — Load this ONE folder

1. `chrome://extensions` → **Developer mode** ON
2. If you had old `zeroscript-extension/` — click **Remove** on that card (keeps `zeroscript-extension-v2` only — prevents 2-extension conflict)
3. **Load unpacked** → select **`zeroscript-extension-v2`** at repo root → card must say **ZeroScript MAX × Roblox Studio Agent 3.4.0**
4. Bridge: double-click `start.bat` (Win) / `MacOS_Start.command` (macOS)
5. Studio: **Assistant → … → Manage MCP Servers → Enable Studio as MCP Server**
6. Open any AI (claude.ai, chatgpt.com, gemini.google.com etc.) → new chat → **▶ Start** in ZeroScript bar (now guaranteed visible on all 15 sites)

## Architecture

```
core/config.js              APP 3.4.0 ULTRA, TRANSPORT hedge 80ms, system prompt (Play STOP→Edit + SYNTAX self-heal + efficient reads + mock sim)
CLAUDE_TUTORIAL.md          Claude UNIVERSAL FIX step-by-step (Play trap, efficient reads, verify, syntax heal)
core/parser.js              command parsing (pure strings)
core/memory_wall.js         Memory Wall — cross-session notes
core/prompt_enhancer.js     Bad→Best optimizer — local, <2ms
core/transport.js           thin client to background (cache 500ms, retry 2, batch 24)
core/agent_stability.js     ULTRA 3.4 hardened editor + generation + keepalive (bottom-scan, self-heal)
core/main.js                agentic loop, UI, camouflage (uses ZSProvider) + syntax error chips
providers/deepseek.js       DeepSeek
providers/chatgpt.js/.cm.js ChatGPT UNIVERSAL 3.4 (bottom-scan + composer-surface fallback, never null)
providers/claude.js         Claude UNIVERSAL 3.4 (bottom-scan + 6-strategy barMount) + overlayBlocking
providers/claude-connector.js Claude custom connector (handshake + Studio bridge)
providers/gemini.js / kimi.js / glm.js / qwen.js / arena.js / meta.js
providers/generic.js        Universal fallback
providers/perplexity|etc    Thin ULTRA wrappers
background.js               ULTRA service worker (hedge 80ms, leader election, BroadcastChannel, single-ext guard)
manifest.json               22 host_permissions, 16 content_scripts, v3.4.0 single-ext
overlay.css                 bar + chips + menu (ULTRA perf will-change)
popup.html/js               3.4.0 badge, bridge status + duplicate warning (see README top)
```

## Troubleshooting

- Card must say **3.4.0** — if old, Remove old → Load unpacked `zeroscript-extension-v2` → Reload. **Only ONE card should exist** (remove legacy `zeroscript-extension` card if you see 2)
- Claude/ChatGPT bar not showing → F5, check `chrome://extensions` card says 3.4.0, bar `id=zs-bar` in inspector — 3.4 barMount never returns null (parent fallback)
- Mode not ready → means getEditor found no input — 3.4 bottom-scan fixes it; if still, reload AI page (F5) and ensure no duplicate extension collision
- Syntax errors in Luau → AI now auto-fixes (STOP→verify→fix→verify loop ≤3); if still red, check Studio Output for hint copied into chip detail
- Bridge offline → run `start.bat`, check http://127.0.0.1:17614/api/status
- `popup.html` opened as file:// is static preview — needs chrome.runtime as extension popup
