# ZeroScript MAX 4.3.0 — extension (load THIS folder)

`chrome://extensions` → Developer mode → **Load unpacked** → select this folder
(`zeroscript-extension-v2/`). The card must read **ZeroScript MAX × Roblox Studio Agent 4.3.0**.
Remove any older `zeroscript-extension` card.

## What it is

A content script that drops a small control bar above the composer on 20 AI chat sites. Press
**▶ Start** on a new chat and it drives the site's model through an agentic loop: it reads the reply,
extracts the ZeroScript command, executes it through `background.js` → `bridge.py` → Roblox Studio MCP,
and types the result back so the model can continue.

## Verified behaviour in 4.3.0

| Area | Reality |
|---|---|
| Agent loop | Starts reliably. Session state (`SESSION`) is module scope; exec mode + plan are mirrored to `window.__zsExecMode/__zsPlan` and `chrome.storage`. |
| Exec modes | **Single** (1 turn) · **Continuous** (≤24 turns) · **Loop** (≤40 turns, planner→coder→checker rotation). All bounded; a budget banner stops a runaway model. |
| Command protocol | **One command per reply.** `execute_luau` uses `###LUA### … ###END_LUA###`; everything else is one JSON object. `core/parser.js` salvages truncated JSON. |
| Static Luau check | `core/sandbox.js` tokenises Luau and checks block balance before the call leaves the browser. It rejects only unparseable code, with a line number. It does **not** execute Luau. |
| Memory wall | `core/memory_wall.js` persists project memory and is injected into the system prompt **and** every agent turn (query-trimmed to ~700 chars). |
| Wall / orchestration | Event-driven (`BroadcastChannel` + `chrome.storage.onChanged`). Tasks are re-published as runtime messages so the executor tab receives them. |
| Slash modes | `/truth /code /prompt /force /smart` — the enhancer wraps **every** provider's `typeAndSend`. |
| Providers | 7 bespoke drivers (DeepSeek, ChatGPT, Gemini, Claude, Kimi, GLM, Qwen, Arena, Meta) + one generic driver + 5 thin wrappers (Perplexity, Copilot, Grok, Poe, Mistral). |
| Transport | WebSocket to the bridge with an HTTP REST fallback, SSE for status. No WebTransport, no long-poll. |

## Requirements

- Roblox Studio with **Assistant → Manage MCP Servers → Studio as MCP Server** enabled.
- The local bridge running (`start.bat` / `MacOS_START.command`, `127.0.0.1:17613` WS / `17614` HTTP, token-protected).

## Files

```
manifest.json             MV3 — 16 content-script blocks, 20 hosts, 27 host_permissions
core/config.js            identity, plans, system prompt, feedback, tool categories
core/parser.js            command extraction + JSON salvage (37 assertions)
core/sandbox.js           Luau tokenizer + block balance (36 assertions)
core/memory_wall.js       persistent project memory
core/plan_wall.js         event-driven inter-tab wall (18 assertions)
core/agent_hub.js         agent temp storage
core/prompt_enhancer.js   slash modes + spec expansion
core/agent_stability.js   composer/generation hardening
core/main.js              agentic loop, exec modes, UI, chips, diagnostics
providers/*.js            per-site drivers
background.js             service worker (bridge link, plan wake, agent temp)
overlay.css               in-page UI styles
```

## Diagnostics

```js
window.__zsDiag            // last 300 decisions of the loop
window.__zsMemoryWall.stats()
window.__zsTransportStats()
```

## Tests

From the repo root: `npm install && npm run verify` — parse checks, manifest integrity,
content-script ordering, AST scope analysis (the 4.2.0 ReferenceError class, with a self-test),
cross-module API contract, version agreement, four assertion suites, and a stubbed-browser boot test.

GPL-3.0-or-later — see `../LICENSE`.
