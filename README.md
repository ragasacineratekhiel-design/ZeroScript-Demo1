# Integrated release 4.6.0 — existing MAX features + bridge teams

This branch integrates main's execution modes, slash commands, static Luau sandbox, memory wall, plan wall, peer routing and fault instrumentation with authenticated bridge-team mailboxes, concurrent team startup, timestamped console, Python launcher and shared tab controls.

**New setup:** run `python "ZeroScript Demo/ZeroScript-Free-1.5.5/start.py"` (`py -3` on Windows). Python and websockets must already be installed. The batch launcher is replaced, not required. See [team setup and communication evidence](docs/TEAM_SETUP.md).

**Choose one orchestration path per tab:** normal Start keeps main's legacy execution/wall workflow. Joining a bridge team requires Start team in the popup; active bridge teams use their assigned role and bridge inbox, not legacy role rotation or peer-context injection. Leave the team before returning to normal Start. The legacy peer-wall channel is retained but does not appear in the bridge Team Console.

**Validation:** `npm ci`, `python -m pip install -r requirements-dev.txt`, then `python scripts/validate.py`. Both the existing feature suites and new bridge/team/UI suites run. Mock tests do not establish live provider, Windows desktop or Roblox compatibility.

---

## Existing MAX features (retained from main)

# ZeroScript MAX 4.6.0 × Roblox Studio Agent

A browser extension (Chrome/Edge, MV3) that lets **any AI chat window** drive **Roblox Studio** through a
local Python bridge. You talk to the AI; the extension reads its replies, finds the commands, runs them
against Studio through the MCP server, and feeds the result back so the model can keep going.

> **Install — ONE extension only:** `chrome://extensions` → Developer mode → **Load unpacked** → select
> **`zeroscript-extension-v2/`**. The card should read **ZeroScript MAX × Roblox Studio Agent 4.6.0**.
> If you still have an old `zeroscript-extension` card, remove it.

---

## What 4.6.0 fixes (Bridge Teams, Strict Role Boundaries & `/truth` Verification)

| Problem | Root cause found | 4.6.0 fix |
|---|---|---|
| **Bridge team tabs could not communicate** | (1) `PromptEnhancer.wrapTypeAndSend` and `MemoryWall.buildTrimmedContext` mutated prompts *after* `submitAndGetBase` computed `expectedPrefix`, failing `landed()` on `buildTeamPrompt` and `Bridge team inbox`; (2) `claude-connector.js` wrapped `Claude.typeAndSend` behind `main.js`'s back; (3) `P.conversationKey()` prefixed `location.hostname` (`"claude.ai/new"`), so landing-URL redirects to `/chat/<uuid>` triggered `team_leave` and `loop.abandonedNewChat`; (4) `pollTeam` dropped WS wakeups arriving mid-generation | Pre-compute enhancement/wall context before `expectedPrefix` and bypass both on team/internal turns; strip hostname in `isLandingKey()`; queue `pendingWake` and drain on `loop.end`; WS-first `team_*` + 0 ms `Condition` long-poll (`?wait=1`) + instant WS/SSE `team_event` push |
| **Planner and Checker wrote/executed Luau instead of Coder** | Role boundaries were prompt-only suggestions; `handleWallTask` matched `/coder\|checker\|executor/` so Checker Tabs ran `execute_luau` directly | Enforced in **3 layers**: `core/config.js` + `core/main.js` (`runTool` & coder-only `handleWallTask`), `background.js` (`roleCheckTool` + `member_id` forwarding), and `bridge.py`/`team_hub.py` (`check_mutation` + `[ROLE-BLOCKED]` console events). Only `coder` mutates Studio; solo single-AI sessions remain unrestricted |
| **`/truth` external commands were unverified** | `truthReads` incremented even on failed reads, no deterministic proof stamp existed, and `/brutal-honest` / `/0%-lies` were ignored | Added `verify_fact` / `POST & GET /api/verify` (read-only Studio probe returning UTC timestamp + SHA-256 digest), `[VERIFIED via <tool> fnv1a:<hash>]` output stamps, strict `r.ok` counting, offline `NOT VERIFIED` fallback, and `/brutal-honest`, `/0%-lies`, `/follow-everything`, `/absolute-effort` slash aliases |
| **8 bespoke providers had unreachable stability hooks** | `glm`, `gemini`, `meta`, `kimi`, `arena`, `deepseek`, `qwen`, and `chatgpt` placed their `ZSAgentStability` + SPA `history.pushState`/`replaceState` patch *after* `return { ... };` | Moved before `return` in all 8 providers and added a standing AST post-`return` dead-code gate in `tools/audit-deep.js` |

---

## What 4.5.0 / 4.3.0 fixed earlier

This release exists because an audit of 4.2.0 (see [`ZeroScript-Audit.md`](ZeroScript-Audit.md)) found
that several headline features were inert, and one bug stopped the product from working at all:

| Was | Now |
|---|---|
| `currentExec` read by the agent loop but declared inside `ui()` → **ReferenceError on Start**, on every site | Session state lives at module scope (`SESSION`) and is mirrored to `window.__zsExecMode` / `__zsPlan` / `__zsPlanRoles` |
| Exec modes Continuous/Loop only stored a string; nothing read it | Real bounded engine: iteration budget (24 / 40 turns), progress check, planner→coder→checker rotation |
| "10× wall" delivered nothing between tabs (BroadcastChannel never reached the executor) | Wall envelopes are re-published as runtime messages (`sendWallTask`); `plan_wall` is event-driven |
| A 10 ms `chrome.storage` busy-poll (~360k reads/hour/tab) | Event-driven delivery; a 5 s safety poll switches itself off after the first real event |
| Dry-run "sandbox" rejected **valid** Luau (counted `do` as an opener, ignored comments) | Real Luau tokenizer + block-balance analyser with line-numbered errors; warnings never block |
| `agent_hub.pushTemp/getTemp`, `sandbox.executeLuau` called but never defined | Implemented (`pushTemp`/`getTemp`/`loadTemp`); wall tasks now run the real `execute_luau` tool |
| Memory Wall built, wired to nothing | Injected into the system prompt **and** every agent turn (query-trimmed, budgeted) |
| Slash commands worked on Claude only | `wrapTypeAndSend` is installed for **every** provider by `core/main.js` |
| Five providers mutated the shared generic identity (last file won) | Per-object immutable identity via `ZSMakeMeta`; no shared mutation |
| `bridge.py` accepted requests with **no token**; CORS listed 11 of 20 hosts | Token required for every state-changing endpoint; CORS matches the 20 supported hosts |
| Prompt contradicted itself (plain text vs fenced code block) and over-claimed the sandbox/transport | Prompt states the real behaviour of the static check and the WS+HTTP transport |

Still honest about limits: **15 hosts ship a content script, 7 have bespoke DOM drivers**
(DeepSeek, ChatGPT, Gemini, Claude, Kimi, GLM, Qwen, Arena, Meta) and 5 are thin wrappers over one
generic driver (Perplexity, Copilot, Grok, Poe, Mistral). No AI integration can be guaranteed against a
site redesign; the generic driver and the provider fallbacks exist for exactly that reason.

---

## Requirements

- **Node.js ≥ 18** — only for development/verification (`npm run verify`). The extension itself needs no build step and no npm install.
- **Python 3.9+** with `websockets` — for the bridge (`start.py` / `MacOS_START.command`).
- **Roblox Studio** with *Assistant → Manage MCP Servers → Studio as MCP Server* enabled.

## Install

1. `chrome://extensions` → Developer mode ON → **Load unpacked** → `zeroscript-extension-v2/`
2. Start the bridge: **`py -3 start.py`** (Windows) or `chmod +x MacOS_START.command && ./MacOS_START.command` (macOS).
   Both live in `ZeroScript Demo/ZeroScript-Free-1.5.5/`. The bridge listens on `127.0.0.1:17613` (WS) and `127.0.0.1:17614` (HTTP).
3. In Studio: **Assistant → Manage MCP Servers → Enable Studio as MCP Server**.
4. Open any supported AI, start a **new chat**, press **▶ Start**.

The popup shows bridge/Studio health. If it says *bridge offline*, the Python process is not running.

## Using it

Type normally — the AI writes plain-text commands, the extension executes them.

| Command | What it does |
|---|---|
| `/truth <ask>` (aliases: `/brutal-honest`, `/0%-lies`) | Answer only from tool-verified Studio reads (`verify_fact` SHA-256 + FNV-1a stamps); say `NOT VERIFIED` otherwise |
| `/follow-everything` · `/absolute-effort` | Aliases for `/prompt` (strict spec execution) and `/force` (exhaustive multi-angle completion) |
| `/code <build>` | Maximum-effort build: bulk `execute_luau`, full scripts, no placeholders |
| `/prompt <do>` | Execute exactly what was asked, inspect → mutate → verify, once |
| `/force <do>` | Never give up: break the task down and retry with different approaches |
| `/smart <do>` | Extra planning/verification scaffolding for weaker models |

Slash modes are combinable (`/truth /force fix Workspace.Gravity`). Where the extension can rewrite the
prompt it does so; otherwise the slash arrives as plain text and the system prompt tells the model to
honour it.

### Exec modes (left of the agent button)

- **Single** (default) — one prompt, one answer.
- **Continuous** — keeps building until the model reports completion or the 24-turn budget is reached.
- **Loop** — rotates planner → coder → checker for up to 40 turns, state shared through the wall + agent hub.

### Switch Plan (Direct / Agent / Plan / Checker)

Assign roles to open AI tabs. In Agent/Plan/Checker mode the extension wakes the other tabs, shares the
magic-word handshake and passes tasks between them. **This requires the tabs to be open and the plan
saved.**

---

## Architecture

```
manifest.json             MV3: 16 content-script blocks, 20 AI hosts, 27 host_permissions
core/config.js            App identity, plans, system prompt, tool categories, feedback text
core/parser.js            Command extraction + JSON salvage (the most-tested module)
core/sandbox.js           Luau tokenizer + block-balance static analyser (no VM, by design)
core/memory_wall.js       Persistent project memory (chrome.storage + DOM beacon)
core/plan_wall.js         Event-driven inter-tab wall (BroadcastChannel + storage events)
core/agent_hub.js         Agent temp storage (memory → BC → chrome.storage → bridge)
core/prompt_enhancer.js   Slash modes + spec/template expansion
core/agent_stability.js   Editor/generation hardening for flaky composers
core/main.js              Agentic loop, exec modes, UI, chips, diagnostics
providers/*.js            Per-site DOM drivers (7 bespoke) + generic driver + 5 thin wrappers
background.js             Service worker: bridge link (WS + HTTP), plan wake, agent temp
bridge.py                 Local MCP bridge: WS + REST + SSE, token auth, process supervision
tools/verify.js           Verification suite (see below)
```

### Verification

```bash
npm install          # acorn (AST scope checking); optional but recommended
npm run verify
```

`verify` checks: every file parses · the manifest is valid and every referenced file exists ·
content-script dependency order · **no identifier is read from a scope that cannot see its declaration**
(the 4.2.0 bug class, verified with an AST, with a self-test fixture that proves the checker works) ·
no module calls an export that does not exist · versions agree · all four test suites pass.

## Security notes

- The bridge binds to `127.0.0.1` only and **requires a token** for every state-changing endpoint
  (`X-ZS-Token`, `Authorization`, or `?token=`). The token is `ZeroScript Demo/…/.zs_token`, created on first run.
- Read-only endpoints (`/health`, `/api/status`, `/api/metrics`) stay open so the popup can show health before a token is known. Set `ZS_NO_AUTH=1` only on a machine you control.
- CORS is an explicit allowlist of the 20 supported AI hosts plus `chrome-extension://`. Unknown origins get no allow-origin header.
- The bridge log records tool names and arguments. It can contain your project's Lua, so treat `logs/` as sensitive (it is git-ignored).

## Troubleshooting

- **Card says 4.6.0?** If not: remove the old card → Load unpacked → reload the AI page (F5).
- **Bar missing?** Check the extension is 4.6.0, then look for `#zs-bar` in the inspector.
- **"Extension context invalidated"** — the extension was reloaded/updated under an open tab; reload the page.
- **Loop/Continuous not continuing?** Check the Exec selector and watch for the budget banner; press Start again to continue.
- **Nothing executes** — popup health first: bridge offline → run `start.py`. Studio not connected → enable the MCP server in Studio.
- Diagnostics: `window.__zsDiag` (last 300 loop decisions), `window.__zsMemoryWall.stats()`, `window.__zsTransportStats()`.

## Licence

GPL-3.0-or-later — see [`LICENSE`](LICENSE).
