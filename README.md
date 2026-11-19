# Integrated release 4.7.0 — existing MAX features + bridge teams

This branch integrates main's execution modes, slash commands, static Luau sandbox, memory wall, plan wall, peer routing and fault instrumentation with authenticated bridge-team mailboxes, concurrent team startup, timestamped console, Python launcher and shared tab controls.

**New setup:** run `python "ZeroScript Demo/ZeroScript-Free-1.5.5/start.py"` (`py -3` on Windows). Python and websockets must already be installed. The batch launcher is replaced, not required. See [team setup and communication evidence](docs/TEAM_SETUP.md).

**Choose one orchestration path per tab:** normal Start keeps main's legacy execution/wall workflow. Joining a bridge team requires Start team in the popup; active bridge teams use their assigned role and bridge inbox, not legacy role rotation or peer-context injection. Leave the team before returning to normal Start. The legacy peer-wall channel is retained but does not appear in the bridge Team Console.

**Validation:** `npm ci`, `python -m pip install -r requirements-dev.txt`, then `python scripts/validate.py`. Both the existing feature suites and new bridge/team/UI suites run. Mock tests do not establish live provider, Windows desktop or Roblox compatibility.

---

## 4.8.2 — GUI & logo generation (code, not prompts)

Full accounting: [`docs/GUI_LOGO_4.8.2.md`](docs/GUI_LOGO_4.8.2.md).

The prompt already said *"scale-based GUI (UDim2.fromScale), TextScaled, mobile safe
area 0.05, UICorner 8"* for several releases, and the GUI still looked wrong. More
prose could not fix it: a model writing GUI by hand has no pixel coordinates, no
feedback on what it drew, and no way to keep eight widgets consistent.

So the layout maths moved into code. `core/gui.js` + two new commands:

| Command | Output | Verified by |
|---|---|---|
| `generate_gui {theme, screen, widgets, title}` | Complete Luau `ScreenGui`, 10 widget types / 5 screens | parsed by the same analyser that gates `execute_luau` |
| `generate_logo {style, theme, initials, size}` | Vector logo (no upload needed — Roblox can't upload from Luau), aspect-locked | same |

**Measured, not claimed:** 7 themes, every body-text pair clears **WCAG AA 4.5:1**
(worst 6.63:1, computed from the real luminance formula); every geometry value is
`UDim2.fromScale`; every widget gets radius/stroke/gradient from one shared function
so no widget can have a one-off corner; buttons get real `TweenService` hover/press;
the HUD reads `GetAttribute("Coins")` instead of invented text.

```
node zeroscript-extension-v2/test-gui.js   → 89 passed, 0 failed
73 theme×screen×widget×logo outputs        → 73 parse as valid Luau, 0 failures
```

**Honest limits:** this removes the opportunity to get layout arithmetic wrong; it
does not make a model artistic. It produces code, not pixels — `capabilities.vision
=== false` — which is why the prompt now requires `screen_capture` after a GUI change
and calls an uncaptured GUI UNVERIFIED. On ChatGPT `screen_capture` is blocked
(`supportsVision: false`, free-tier image quota), so `generate_gui` still works but
the model cannot look; the tool note says so.

---

## 4.8.1 — multi-edit, hallucinated connections, solo coder

Four reported problems. Full accounting with reproduced evidence is in
[`docs/REPAIR_NOTES_4.8.1.md`](docs/REPAIR_NOTES_4.8.1.md).

| Report | Root cause | Fix | Verified |
|---|---|---|---|
| **"Support multi edit, unlimited edits"** | The prompt claimed `MAX: batch up to 24 edits per call` and **no code enforced it** — a grep found the string and nothing else. Worse, `multi_edit` had **no syntax check at all** (the Luau gate was `execute_luau`-only), so a batch went to Studio unparsed and Studio rejected **all of it** on one bad edit, with no clue which one. | `analyseMultiEdit()` parses every replacement before the round trip and **names the offending edit index**; the cap text is replaced with `NO EDIT CAP`. | `test-sandbox.js` 105 assertions |
| **"It says it's connected to another agent"** | For `plan=direct` — one AI, zero peers — `getMagicForPrompt()` returned `connected:true`, `external:true`, `magic:"im connected to other agent"`. | `connected` now means "a peer is reachable". Solo exports `connected:false, solo:true, peers:0` and its own truthful magic line. | `test-plan-wall.js` 38 assertions |
| **"Declare single mode as coder always"** | `effectiveRole()` returned `null` outside team mode, so nothing ever told the model which role it was — and it invented teammates. | Returns `"coder"`, surfaced as a T0 `YOUR ROLE:` line that no budget can drop. | `test-prompt.js` 96 assertions |
| **"Hallucinating even with a clear prompt"** | No rule forbade invented *capability/connection* claims. | Rule 1b `NO INVENTED CONNECTION`: no tool result = no proof. | `test-prompt.js` |

**Two latent bugs found by the tests, both real:**

1. The user's custom prompt was **silently dropped** on any provider whose budget
   was below the T0 floor (`room() > 200` is false when `room()` is negative).
2. A `/**` comment in `main.js` became the terminator for a stray `/*` on line 3
   (`providers/*.js`), swallowing **78,195 bytes** during comment stripping and
   breaking `test-composer.js`'s source slicing.

---

## 4.8.0 — three reported problems, fixed with measured evidence

This release changes exactly three things, because these are the three defects that
were reported. Every number is reproducible; the full account with the before/after
tables is in [`docs/REPAIR_NOTES_4.8.0.md`](docs/REPAIR_NOTES_4.8.0.md).

| Report | What was actually wrong | Fix | Verified by |
|---|---|---|---|
| **"External prompts don't give better results and the claims are fake"** | Both halves were true. The claims were invented (`~35-40% closer to Pro`, `~30%`, `syntax -28%`) — there is no eval harness in this repo that could measure them. And the enhancer *did* make things worse: `isBadPrompt()` treated any ≤4-word message as vague, so `"thanks"` got **+5,400 chars** of simulator spec, and `isBadPrompt()` was also the only gate on the spec path, so **`"why"` got +5,397 chars** too. | Every percentage deleted. Noise prompts, one-word questions and clear short requests now return `changed:false` — byte-identical on the wire. `needsSpec()` is a separate predicate that fires only on a bare BUILD ask. The `detailed` path no longer re-appends the protocol. | `test-enhancer.js` — **114 assertions** |
| **"The built-in syntax checker is garbage"** | 5 of 64 valid Luau snippets were rejected, including `if type(x) ~= "string" then return end` — *the* standard Roblox guard, and exactly the anti-exploit validation the prompt asks for. Meanwhile truncated code (`type A =`) was reported **valid**. `main.js` blocks `execute_luau` on a syntax verdict, so every false positive silently destroyed a correct reply. | 8 grammar defects fixed (contextual `type`/`typeof`, string-literal unions, keyword field names, `<const>`, indexed access types, type packs, `typeof(...)` types, `\z` escapes). Truncated input is now an error. Added `repairLuau()`: a bounded, provable auto-repair that only closes a block the open-block ledger names, and tells the model what it changed. | `test-sandbox.js` — **89 assertions**, 64/64 valid accepted, 15/15 broken rejected, plus a measured ms/run ceiling |
| **"The startup command is so long it will cause hallucination"** | Measured: **37,983 chars ≈ 9,500 tokens** before the user types anything — 16 accreted sections, the 4.2 KB simulator blueprint in *every* prompt, the self-heal loop printed **3×**, `Ready — ZeroScript MAX 4.3.0` (three releases stale), invented latencies, and `Measured … +40-50% Pro proximity` three lines above "we quote no percentage". | Rebuilt as ranked tiers with a hard budget: **6,656 chars (−82.5%)**, ≈1,664 tokens, 9 sections, every rule stated exactly once, a numbered priority order for conflicts, and honest latency text. `promptBudgetFor(provider)` derives the budget from the provider's real `sendCharBudget`; the lowest tier truncates first and the command format never does. | `test-prompt.js` — **78 assertions** pinning size, budget, non-duplication, honesty and tier ordering |

Nothing else was changed. `bridge.py`, `team_hub.py`, `team_console.py` and
`start.py` were read and exercised (55 Python tests + 26 bridge-lifecycle
assertions) but contain none of the three defects, and inventing edits to correct
files would be the dishonesty this release is about.

---

## Existing MAX features (retained from main)

# ZeroScript MAX 4.7.0 × Roblox Studio Agent

A browser extension (Chrome/Edge, MV3) that lets **any AI chat window** drive **Roblox Studio** through a
local Python bridge. You talk to the AI; the extension reads its replies, finds the commands, runs them
against Studio through the MCP server, and feeds the result back so the model can keep going.

> **Install — ONE extension only:** `chrome://extensions` → Developer mode → **Load unpacked** → select
> **`zeroscript-extension-v2/`**. The card should read **ZeroScript MAX × Roblox Studio Agent 4.7.0**.
> If you still have an old `zeroscript-extension` card, remove it.

---

## What 4.7.0 changes (speed, correctness, and one honest correction)

4.7.0 is a performance and correctness release. It adds no new product surface; it
makes the existing surface cheap and removes bugs that only appeared under load or
on a second tab. Every number below is reproducible with the command named next to
it. None of them are estimates.

| Problem in 4.6.0 | Root cause | 4.7.0 fix | How it was verified |
|---|---|---|---|
| Opening the Studio agent listed services one at a time | `studio_full_tree` issued 27 serial `inspect_instance` calls, each with a 4 s timeout — a 108 s worst case on a laggy Studio | Bounded 8-worker fan-out with a 12 s wall-clock deadline; `elapsed_ms` reported in the payload | `test-bridge.py` measures 0.20 s vs 1.35 s serial at 0.05 s/call, and asserts peak concurrency > 1 |
| The popup re-probed Studio on every status burst | `probe_studio_cached` guarded on `val is not None`, but a *down* Studio returns `{"app": None}` — a non-`None` dict, so the guard never fired | Cache keyed on the timestamp, not the value; single-flight so 8 concurrent callers share one probe; a negative answer lives TTL/4 | `test-bridge.py`: 8 concurrent callers → 1 probe call; a negative answer is served from cache |
| One tab navigating away killed the whole team run | `TeamHub.leave()` called `stop(team)` on **any** departure — and a tab *reload* also fires `tabs.onUpdated` | The team stops only when the last live member leaves; otherwise it records which role is missing | `tests/test_bridge_team.py` + `test-bridge.py` |
| A `package.json`-style version went stale without the verifier noticing | `checkVersions` only matched `VERSION = "x.y.z"`, not `version: "x.y.z"` | Both forms are checked | `npm run verify` |
| A plan could not be started from defaults | `setPlan` assigned `AI_PROVIDERS[0]` to every unassigned role, so a fresh 3-role plan was "all DeepSeek" — which `peer_wall.auditPlan()` correctly rejects | Distinct defaults, caller pins reserved before any pick, and a pass-2 healer for unrequested duplicates | Exhaustive sweep: 140 multi-role plan states × every pin × every provider → 0 rejected by the real auditor |
| `memory_wall` wrote twice per save | The legacy `zsMemoryWall` mirror was rewritten on every `saveWall()` | Written once per document | `test-memory-wall.js` |

**Correction on the 4.6.0 notes:** an earlier draft of this section claimed a
26-assertion `test-bridge.py` and listed bridge changes that were not in the tree.
They had been reverted by `scripts/sync_copies.py --write` (which, correctly,
copies canonical → bundle) after being made in the wrong directory. They are now
present and verified; the full account is in
[`docs/UPGRADE_AUDIT_4.7.0.md`](docs/UPGRADE_AUDIT_4.7.0.md) §2.4.

---

## What 4.6.0 fixed (Bridge Teams, Strict Role Boundaries & `/truth` Verification)

| Problem | Root cause found | 4.7.0 fix |
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

- **Card says 4.7.0?** If not: remove the old card → Load unpacked → reload the AI page (F5).
- **Bar missing?** Check the extension is 4.7.0, then look for `#zs-bar` in the inspector.
- **"Extension context invalidated"** — the extension was reloaded/updated under an open tab; reload the page.
- **Loop/Continuous not continuing?** Check the Exec selector and watch for the budget banner; press Start again to continue.
- **Nothing executes** — popup health first: bridge offline → run `start.py`. Studio not connected → enable the MCP server in Studio.
- Diagnostics: `window.__zsDiag` (last 300 loop decisions), `window.__zsMemoryWall.stats()`, `window.__zsTransportStats()`.

## Licence

GPL-3.0-or-later — see [`LICENSE`](LICENSE).
