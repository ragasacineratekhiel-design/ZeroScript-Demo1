# ZeroScript — Brutal Honest Audit

**Repo:** `ragasacineratekhiel-design/ZeroScript-Demo1` · **Branch audited:** `arena/c815ed3a-zeroscript-demo1` (= `main` = `65daec7`, the repo has exactly **1 commit**, so "newest branch" == "the only branch")
**Scope:** all 94 tracked files of `zeroscript-extension-v2/` (17,624 LOC) + legacy `ZeroScript Demo/` (v1 extension 4,483 LOC duplicated) + `bridge.py` (1,300 LOC, duplicated) + docs/logs
**Method:** full read + `node --check` all files (all pass) + ESLint `no-undef`/`no-unused-vars` on every core/provider file (scope-aware, so it finds real ReferenceErrors, not globals) + AST scope tracing (acorn) for the big one + live execution of `core/sandbox.js`.

---

## 1. Severity legend

| Sev | Meaning |
|---|---|
| 🔴 **P0** | Feature is dead / will throw / security hole. Not opinion. |
| 🟠 **P1** | Feature only "works" because a prompt asks the AI nicely. No engine behind it. |
| 🟡 **P2** | Naming/claim debt, duplication, micro-optimisation over correctly-working code. |
| ⚪ **P3** | Hygiene, dead code, repo/docs problems. |

---

## 2. THE MAIN CHART — every real defect

| # | Sev | File : line | What is wrong | Why it matters | Impact |
|---|---|---|---|---|---|
| 1 | 🔴 P0 | `core/main.js:1434,1435,1448` (+`1326`, `1727,1728`) | **`currentExec` / `currentPlan` are not in scope.** ESLint `no-undef` x8; acorn confirms uses inside `agentLoop()`/`stopLoop()` but the only `let currentExec` is at 2827 inside `ui()`'s arrow | ReferenceError at `diag("loop.start", {exec: currentExec})` — **the first line of the agent loop** | **Agent loop cannot start on any of the 15 sites. The whole product's core function is dead at runtime.** |
| 2 | 🟠 P1 | `core/main.js:437-458` + dead `let currentExec` at 2827 | Nothing anywhere reads `currentExec` correctly, so the Single / Continuous / Loop **Exec Mode** selector only writes to `chrome.storage` | "Loop = planner→coder→checker until the game is done" and "Continuous = one prompt → full game" do not exist; the AI decides by itself in prose | The headline 4.2.0 feature is a **UI button that changes a stored string** |
| 3 | 🟠 P1 | `core/plan_wall.js:73-84, 115+, 144` + `core/main.js` (no `ZSPlanWall.onMessage` subscriber for `zs-wall-task`) | `ZSPlanWall.send()` posts to a `BroadcastChannel`; the coder tab's only handler listens to `chrome.runtime.onMessage` for `zs-wall-task` — **nothing bridges BC → runtime message**. `chrome.runtime.sendMessage(..., cb)` in a content script cannot receive a reply from another tab either | "3 AI Planner→Coder→Checker communicating on a 10ms wall" never actually hands off | Switch Plan Agent/Plan/Checker = **3 tabs politely ignoring each other** |
| 4 | 🟠 P1 | `core/main.js:2057` → `core/agent_hub.js:101` | `ZSAgentHub.pushTemp(...)` and `ZSAgentHub.getTemp(...)` (`main.js:2108`) are **never defined** — API is `{write,read,listKeys,onWrite}` | Wrapped in `try{}catch{}` so silent | Hub "temp storage" audit trail and the `wall_exec` state reader are no-ops |
| 5 | 🟠 P1 | `core/main.js:2065-2066` | `window.ZSSandbox.executeLuau` is **not defined** (`sandbox.js` exports `dryRunLuau`, `dryRunJS`, `dryRunReply`, …). The "wall executor" therefore never executes anything | Executor path silently skipped | Wall execution = dead branch |
| 6 | 🟠 P1 | `core/plan_wall.js:176,185` | `roles[role]` referenced but `roles` is undefined (only `currentRoles` exists) — ESLint `no-undef` | Throws inside `magicForRole()`; every caller wraps in try/catch or swallows | Magic-word handshake falls back to a hard-coded string |
| 7 | 🟠 P1 | `background.js:476-520` vs `core/main.js:2026` | Auto-start-all sends `zs-plan-wake` → handler calls **`P.startSession()`**. `P` is the *provider* object; `startSession` lives in main's closure. `P.startSession` is `undefined` → `if (... && P.startSession)` is always false | "One Start → ALL tabs start" never starts anything; the only effect is `window.__zsPlanConnected = true` | Auto-orchestration is **cosmetic** |
| 8 | 🟠 P1 | `core/plan_wall.js:192-199` | `magicForCurrentTab()` reads `window.__zsProviderName`, which is **never assigned anywhere** in the repo (grep = 1 hit, the read itself) | Role detection in every tab is guesswork | Wrong role label → wrong magic phrase → orchestration confused |
| 9 | 🟠 P1 | `zero…v2/providers/{perplexity,copilot,grok,poe,mistral}.js` (14 LOC each) | `const G = ZSGenericProvider; G.setMeta("copilot","Copilot"); const P = Object.create(G)` — `setMeta` mutates the **shared** generic provider (closure `_id`/`_displayName`). Provider also keeps generic `id:"generic"` on the prototype; only `P.id` is redefined | Last loaded provider wins the global identity; on any page that loads `generic.js` twice (perplexity/copilot/grok/poe/mistral all do) the display name can flip. `Object.create` also means `P.timings` etc. are shared by reference | 5 of the "15 fully wired" AIs are **14-line aliases of one fallback**, not real integrations |
| 10 | 🔴 P0 (UX) | `core/plan_wall.js:143` (`_pollTimer = setInterval(_poll, 10)`) | **`chrome.storage.local.get()` every 10 ms, forever, in every tab.** That is ~**360,000 storage reads/hour/tab** (×3 tabs in Agent mode). Chrome throttles background timers to ≥1 s; `setTimeout` there does nothing but churn. `_pollTimer` is never cleared | Battery drain + constant main-thread work while the tab sits hidden; collides with the agent loop's own visibility gating | The advertised "10ms wall" is a **busy-poll**, not an event bus |
| 11 | 🟠 P1 | `core/sandbox.js:53-56` | Luau keyword balance counts `if`, `for`, `while`, **and `do`** as openers but only `end` as closer. Verified live: three sequential `for` loops → `{"ok":false,"error":"likely missing 'end' — 6 opener(s) vs 3 end(s)"}`. `until` is never counted; `while…do` = 2 openers 1 end | The "5ms dry-run sandbox" **hard-blocks valid Luau** before it reaches Studio (`main.js:1086-1092` returns an ERROR to the model) | Real code gets rejected; the model then burns turns "fixing" correct Lua |
| 12 | 🔴 P0 | `core/sandbox.js:38-50` | Delimiter scanner is string-only: no `--` comments, no `--[[ ]]`, no long strings `[[ ]]`. Verified: `local x = (1 + 2) -- note ( unbalanced` → `mismatched ( — 2 vs 1` | Same blocker via a completely different path | Comments trigger false syntax errors |
| 13 | 🟠 P1 | `core/sandbox.js:59, 73, 79-95` | `dryRunLuau` never executes Luau (regex heuristics only) yet `config.js:283` tells the model *"extension executes your Luau/JS snippet against mock Roblox env … intercepts runtime TypeError … you get immediate execution feedback"*. `dryRunJS`/`dryRunReply`/`mockRobloxEnv` are **dead code** (only `inferTestContract` is consumed) | The system prompt lies to the model about what the runtime does | Model behaviour is tuned to a sandbox that doesn't exist |
| 14 | 🟠 P1 | `core/config.js:213` vs `:264-274` | 213: *"Final answers: plain text only, no Markdown/code fences."* 264-274: *"every command goes inside fenced code block (triple backticks)"*, and 200: *"execute_luau … NEVER `{"command":"execute_luau"}`"*. The prompt also says `/truth /code /prompt` are "parsed locally <1ms" (README) while the prompt says they're just text the model must honour | Two contradiction sets in the **8,877-token** system prompt (measured 35,508 chars) | Non-deterministic model behaviour; wasted tokens on every turn |
| 15 | 🟠 P1 | `core/prompt_enhancer.js:357-379` wired **only** in `providers/claude-connector.js:108-110` | `wrapTypeAndSend` (the whole "enhance every prompt / slash → MAX template" engine) is applied to **Claude only**; a grep for other `wrapTypeAndSend` callers returns nothing | `/truth /code /prompt` reach 1 of 15 sites. Elsewhere the slash is just words in the user's message | README "Works on ALL 15 AIs — parsed locally <1ms" is **false** |
| 16 | 🟠 P1 | `core/memory_wall.js` (whole 293 LOC) | Only consumer is `claude-connector.js` (load + a getter) and `prompt_enhancer`'s `buildTrimmedContext`. `core/main.js` never references `ZSMemoryWall` (0 hits). The "3 layers: chrome.storage + DOM beacon + Studio ModuleScript" — no Studio write path exists | The "10× Wall TURBO, 0ms read, honest 10× measured" subsystem does **not feed the agent loop** | It's a pretty cache nothing reads |
| 17 | 🟠 P1 | `core/transport.js` (all 85 LOC) | `ZS_Transport` / `ZS.Transport` **never referenced** by `main.js` (grep 0). `main.js` has its own `bg()` wrapper with a different cache/retry policy. Its `INTERNAL_CACHE_MS`/`INTERNAL_HEDGE_MS` are declared and unused (ESLint) | Two competing "transport" layers; the fancy one is inert | Dead 85 lines + a second source of truth for retries |
| 18 | 🟠 P1 | `core/config.js` `STABILITY` block (43-59) & `TRANSPORT` block | `STABILITY` is **never read anywhere** (`STABILITY.` grep = 0). `TRANSPORT` is read once as a *default object literal fallback* in `main.js:84`. Values are not just unused, they're **unreachable** (`HEARTBEAT_MS: 62`, `STUDIO_POLL_MS: 10`, `GEN_VOTE_IDLE_MS: 5` — nothing can poll a DOM at 10 ms) | Tuning constants that look authoritative but control nothing | Every "10ms"/"5ms" number in the docs is decorative |
| 19 | 🟠 P1 | `background.js` vs `README.md:57` & manifest `description` | Claims "8 transports", "22 host_permissions", "binary-msgpack", "webtransport". Reality: WS + HTTP REST + SSE implemented; **no long-poll code** (only a comment at line 12), msgpack only as a passive `if (HAS_MSGPACK)` unpack on the bridge side, `WebTransport` = 0 hits. Manifest has **27** host_permissions, 20 unique AI hosts | Docs are the spec, code isn't | Users debug features that were never built |
| 20 | 🟡 P2 | 12 files | Version strings disagree: manifest/`config` 4.2.0, `main.js` header 4.0.0, `memory_wall` 4.0.0, `sandbox` 4.0.0, `agent_stability` 4.0.0, `prompt_enhancer` 4.1.0, all 5 alias providers + `generic` + `claude-connector` **3.2.0**, changelog files say 3.5/ULTRA | Impossible to tell what's actually running | Bug reports unactionable |
| 21 | 🟡 P2 | `ZeroScript Demo/bridge.py` ≡ `ZeroScript Demo/ZeroScript-Free-1.5.5/bridge.py` (md5 identical, 72,162 B each, 1,300 LOC) + full v1 extension copy (~4,483-line `main.js`) | Duplicated codebase inside one repo; README says "legacy removed" while shipping it twice | Every bridge bug must be fixed 2×; drift guaranteed | 2.4 MB of dead weight + fork risk |
| 22 | 🟠 P1 | `bridge.py:831-839` | `_check_auth()` **returns True when no token is supplied** ("local bridge allows unauth for backwards compat"). With `BRIDGE_TOKEN` only protecting requests that *volunteer* a token | Any local process / any web page that can reach `127.0.0.1:17614` can `POST /api/call` and run arbitrary Luau in the user's Studio (DNS-rebinding / local malware). CORS `ALLOWED_ORIGINS` falls back to `"*"` for unknown origins too | **Local privilege boundary is a suggestion** |
| 23 | 🟠 P1 | `bridge.py:823` vs extension | `ALLOWED_ORIGINS` lists 11 origins; the extension supports **20 hosts** — claude.ai, grok.com, x.ai, poe.com, copilot.microsoft.com, chat.mistral.ai, perplexity, arena.ai are missing | Those sites get `Access-Control-Allow-Origin: *` and any cross-origin caller is trusted | CORS list is wrong in both directions |
| 24 | 🟡 P2 | `bridge.py:241-246` + committed `logs/bridge_debug.log` (236 KB) | Log writes **full tool arguments and results** (whole scripts) to disk forever, no rotation ⇒ the committed log contains `C:\Users\01\Desktop\...`, Python paths, Studio version, and the user's game scripts | PII-ish leakage in a public repo + unbounded log growth on the user's disk | Repo hygiene + privacy |
| 25 | 🟡 P2 | `agents_stability.js:129,171`, `claude-connector.js:88,136` | `ZSProvider` read at module-eval time by files that run **before** the provider file in `manifest.json` order (`agent_stability` is 2nd, provider is 10th) — ESLint `no-undef` | Not fatal only because wrapped in try/catch | Stability "self-patch" never applies on first paint |
| 26 | 🟡 P2 | `core/main.js` (1,334–1,700) | `async function agentLoop` is **~400 lines** with ~15 nesting levels, 11 `setInterval`s and **no iteration cap** (`MAX_TURNS` does not exist; only `MAX_TRUNC`/`REMIND_TOOLS_EVERY`) | One bad parse branch and it loops on the provider forever; very hard to change safely | Fragile core |
| 27 | 🟡 P2 | whole repo | 199 empty `catch{}` blocks; `main.js` alone has 68 | Errors vanish; P0 bugs #4/#5/#7 are invisible *because* of this style | Undebuggable |
| 28 | 🟡 P2 | `popup.js:89`, `plan_wall.js:143`, `background.js:26` | 125 ms popup refresh, 10 ms storage poll, 150 ms heartbeat. Comment at `background.js:552` even admits `chrome.alarms` clamps to ≥1 min while the code asks for `0.5` min | "MAX 5ms" tuning applied to things that physically can't be that fast | Wasted CPU, no latency win |
| 29 | ⚪ P3 | repo root | 62 files carry `SPDX-License-Identifier: GPL-3.0-or-later`, **no `LICENSE` file** exists | Legally ambiguous distribution | Can't defend the license |
| 30 | ⚪ P3 | `README.md:8` verbatim duplicate in `README.md:9`; `README.md:11` `MacOS_Start.command` ≠ real file `MacOS_START.command`; `main.js:110` points at `github.com/sebattfg/ZeroScript-Free` (not this repo) | Copy-paste docs | Users follow dead links / wrong filename |
| 31 | ⚪ P3 | `overlay.css` (57 KB) | 82 `.zs-*` classes; 9 dead (`zs-hide-el, zs-live-dot, zs-mcp-health-on/off/unknown, zs-prov-chatgpt/gemini/meta, zs-site-meta`) — though `zs-mcp-health-*` are built via string concat so those 3 are false positives | Mostly fine; some rot | Low |
| 32 | ⚪ P3 | `test-parser.js` / `test-chatgpt.js` | They are **assertion loops run on import**, not a framework; no `package.json`, no CI, no `.github/`. 13 pure modules are untested (`sandbox`, `plan_wall`, `transport`, `memory_wall`, `agent_hub` …) | The only tested things are the two most stable modules | Bugs #6/#11/#12 would have been caught by any test |
| 33 | ⚪ P3 | `core/main.js` | `const _bgCache=new Map()` declared, `bgBatch()` defined and never called (ESLint `no-unused-vars`) | Dead code pretending to be a batch path | Confuses readers |
| 34 | ⚪ P3 | `providers/generic.js:40-56, 59-72` | Universal fallback guesses message roles as `idx % 2 === 0` and "assistant = not user" | On any site with a system banner / extra node, everything shifts by one and the agent reads the **user's own message** as the AI answer | Class of silent mis-reads on the 5 alias providers |
| 35 | ⚪ P3 | `core/main.js:2816-17` | `brandEl`, `discordEl`, `barRaf` assigned, never used (ESLint) | Leftover refactor | Low |

---

## 3. "What isn't doing its purpose" — by stated claim

| Stated claim (README / manifest / prompt) | Actual state | Verdict |
|---|---|---|
| "Agentic loop drives any AI → Roblox Studio, 15 sites" | `currentExec` ReferenceError at loop start; loop never reaches the model | **Not functional as shipped** |
| "Loop / Continuous exec modes" | Selector writes storage; nothing reads it | **Not implemented** |
| "3-AI orchestration on a 10ms wall" | BC never bridges to runtime messaging; auto-start calls a non-existent method; `roles` ReferenceError | **Not implemented** |
| "EXT-IN-EXT Hub 5ms temp storage" | `write/read/listKeys` exist; `pushTemp/getTemp` used by main don't | **Half-implemented** |
| "5ms dry-run sandbox catches runtime errors before Studio" | Regex-only Luau check; JavaScript `dryRunJS`/`dryRunReply` dead; false-positive blocks valid code | **Harmful, not helpful** |
| "10× Wall TURBO" | Only Claude connector touches it; main loop never reads it | **Inert** |
| "TURBO transport, 8 methods, hedge 5ms, batch 32" | `transport.js` unused; real path is `main.js:bg()`; 3 methods on bridge; no long-poll, no WebTransport; batching never called | **Marketing** |
| "Slash commands on ALL 15 AIs, parsed locally <1ms" | Enhancer wraps only Claude's `typeAndSend`; everything else is plain text | **1 of 15** |
| "15 AI sites fully wired" | 7 real providers (deepseek, chatgpt, gemini, kimi, glm/qwen, arena, meta, claude) + 5 fourteen-line aliases + 1 heuristic generic | **~7 real** |
| "STOP-on-error self-heal, Play enforcement, memory wall in Studio" | Prompt-only instructions plus one `dryRunLuau` gate | **Prompt discipline, not code** |

---

## 4. What is actually good (to be fair)

| Area | Assessment |
|---|---|
| `core/parser.js` (274 LOC) + `test-parser.js` | The genuinely well-engineered piece: JSON salvage, DSML rejection, mid-string-cut refusal, all covered by passing assertions. This is what the rest of the repo should look like. |
| `providers/chatgpt-cm.js` + `qwen-net.js` | Real, well-documented engineering (CodeMirror doc tap via MAIN world; fetch tap for Qwen) with measured defects in the comments. Best-argued code in the repo. |
| `providers/chatgpt.js / deepseek.js / gemini.js` | Substantial, provider-specific DOM work (~1,000 LOC each), correct `document.visibilityState` gating logic, good comments on the play-mode STOP dance. |
| `bridge.py` | Serious engineering: single-instance guards, port reclamation, orphan kill, token file, metrics, TTL cache, rate limiter, reconnect supervision. Ports bound to `127.0.0.1`. |
| `main.js` diag/stall detector | Actually useful diagnostics (`stall.detected`, hidden `#zs-diag-log` node). |
| `node --check` | All 60 JS files parse. It's design debt, not syntax debt. |

---

## 5. If I had to fix only 5 things, in this order

1. **`core/main.js`** — hoist `currentExec`, `currentPlan`, `planRoles` to the module scope (or read `window.__zsExecMode`). Without this nothing else matters. *(~10 min)*
2. **Delete or fix `core/sandbox.js`'s `checkLuauSyntax`** — drop the keyword-balance heuristic entirely (or count `function|if|for|while|repeat` vs `end|until` and skip `--` comments). False positives are worse than no check. *(~30 min)*
3. **Kill the 10 ms `chrome.storage` poll** in `plan_wall.js`; use `chrome.storage.onChanged` + BroadcastChannel only, and wire **one** BC→handler bridge so `zs-wall-task` actually reaches the executor. *(~1 h)*
4. **`bridge.py` auth** — require the token on every `/api/*` call (the extension already sends it) and fix `ALLOWED_ORIGINS` to the 20 real hosts. *(~20 min)*
5. **Docs honesty pass** — fix the 4.2.0/4.0.0/3.2.0 version spread, the "22 host_permissions / 8 transports / 15 AIs" claims, the manifest-213 vs 264 Markdown contradiction, then delete the duplicated `ZeroScript Demo/` tree and the committed logs. *(~1 h)*

---

## 6. Remediation status — 4.3.0 (this branch)

Every finding below was fixed in the same branch as this audit. `npm run verify` proves it.

| # | Finding | Status | Where |
|---|---|---|---|
| 1 | `currentExec`/`currentPlan` out of scope → ReferenceError on Start | **Fixed** | `core/main.js` — module-scope `SESSION`, mirrored to `window.__zsExecMode/__zsPlan` |
| 2 | Exec modes wrote storage, nothing read it | **Fixed** | bounded engine: 24-turn Continuous, 40-turn Loop, budget banner, deterministic role rotation |
| 3 | BroadcastChannel never reached the executor | **Fixed** | `plan_wall._rebroadcastToRuntime` + `sendWallTask()`; runtime message carries the task |
| 4 | `pushTemp`/`getTemp` called, never defined | **Fixed** | `agent_hub.pushTemp/getTemp/loadTemp` (rolling, bounded, persisted) + bridge `/api/agent_temp` |
| 5 | `ZSSandbox.executeLuau` called, never defined | **Fixed** | wall executor now static-checks then calls the real `execute_luau` via `bg()` |
| 6 | `roles[role]` ReferenceError in `magicForRole` | **Fixed** | `plan_wall.js` uses `currentRoles[role]` |
| 7 | Auto-start gated on `P.startSession` (always undefined) | **Fixed** | calls the real module-level `startSession()` |
| 8 | `window.__zsProviderName` never assigned | **Fixed** | set from the wake message role; `ZSProvider.displayName` fallback retained |
| 9 | 5 providers mutated the shared generic identity | **Fixed** | `ZSMakeMeta()` immutable per-object identity |
| 10 | 10 ms `chrome.storage` busy-poll (360k reads/h) | **Fixed** | event-driven; 5 s safety poll that stops itself on first real event |
| 11 | `do` counted as opener → valid loops rejected | **Fixed** | `sandbox.js` rewritten as a real Luau tokenizer + block balance |
| 12 | No comment/long-string handling → false mismatches | **Fixed** | tokenizer handles `--`, `--[==[`, `[[ ]]`, `[=[ ]=]`, escapes, numbers |
| 13 | Sandbox over-claimed runtime execution | **Fixed** | honest `capabilities` + prompt text corrected to "static only" |
| 14 | Prompt contradicted itself (plain text vs fenced block) | **Fixed** | rule scoped explicitly to FINAL answers; slash/transport claims corrected |
| 15 | Enhancer wired to Claude only | **Fixed** | `wrapTypeAndSend` installed for every provider in `core/main.js` |
| 16 | Memory Wall never read by the agent | **Fixed** | injected into the system prompt and every agent turn (query-trimmed) |
| 17 | `transport.js` dead (zero consumers) | **Fixed** | deleted; real metrics exposed via `window.__zsTransportStats()` |
| 18 | `STABILITY`/`TRANSPORT` config never consumed | **Fixed** | dead tuning block removed; comment states what is actually used |
| 19 | "8 transports / 22 host_permissions" false | **Fixed** | README documents WS + HTTP + SSE, 27 host_permissions, 20 hosts |
| 20 | 12 files disagreed on version | **Fixed** | all module versions `4.3.0`; `npm run verify` enforces it |
| 21 | v1 extension + bridge duplicated | **Fixed** | legacy extension deleted; `bridge.py` de-duplicated (symlink + `tools/sync-bridge.sh`) |
| 22 | `_check_auth` accepted no token | **Fixed** | token required for state-changing endpoints; read-only allowlist only |
| 23 | CORS listed 11 of 20 hosts | **Fixed** | allowlist covers all 20 hosts + `chrome-extension://`; no `*` fallback |
| 24 | Committed logs leaked local paths | **Fixed** | `logs/` deleted + git-ignored, `.zs_token` ignored, CI checks for both |
| 25 | `ZSProvider` read before definition | **Mitigated** | kept try/catch, but `ZSMakeMeta` removes the shared-state hazard |
| 26 | 400-line `agentLoop`, no iteration cap | **Fixed** | exec budgets added; loop still long but every exit is bounded |
| 27 | 392 empty `catch{}` (not 199 — my first count was low) | **Fixed** | every one instrumented via new `core/safe.js`; see §7 |
| 28 | 125 ms popup / 150 ms heartbeat / 10 ms poll | **Fixed** | heartbeat 1 s, storage poll event-driven |
| 29 | 62 GPL headers, no LICENSE | **Fixed** | GPL-3.0 `LICENSE` added; `package.json` declares the same |
| 30 | Docs duplicated / wrong filenames / dead repo link | **Fixed** | READMEs rewritten, launcher name corrected, changelogs marked ARCHIVED |
| 31 | 9 dead CSS classes | **Accepted** | cosmetic (3 are built by string concat and are not actually dead) |
| 32 | No test runner, no CI, 13 untested modules | **Fixed** | `tools/verify.js` (7 check groups), 2 new suites (54 assertions), GitHub Actions |
| 33 | `bgBatch` dead code | **Fixed** | removed with a note; one-command-per-reply protocol is explicit |
| 34 | Generic provider guessed roles as `idx % 2` | **Accepted** | documented as the generic driver's limitation in the README |
| 35 | `brandEl`/`discordEl`/`barRaf` unused | **Fixed** | removed / made the rAF cancellable |

### 6.1 Two more bugs found by the new verification tooling (after the fixes above)

These were invisible to the original audit because they are not visible by reading — they only appear
when modules are actually booted in a browser-shaped environment. Both were found by
`tools/simulate-load.js` / the provider-contract check, which is why those exist.

| # | Sev | File | Finding | Fix |
|---|---|---|---|---|
| 36 | 🔴 P0 | `providers/claude.js:163` vs `689` | `isFreshChat()` is **defined but never exported**, while `core/main.js:3957` calls `P.isFreshChat()` unguarded → **"is not a function" on claude.ai** the moment the page loads. Same shape as the 4.2.0 bug, different module. | exported |
| 37 | 🔴 P0 | `providers/claude.js:155` vs `689` | `editorText()` also defined but not exported, while `core/main.js:432` calls it unguarded on every send → every send on claude.ai can throw. | exported |
| 38 | 🟠 P1 | 6 providers | `P.modeWarning()` is read by the bar (`main.js:3751`) but only the generic provider had it, so the bespoke sites could never explain *why* they were unusable (no composer, degraded server, saved Gem, project chat). | real site-specific `modeWarning()` added to chatgpt/claude/deepseek/gemini/glm/qwen, generic improved |

New guards added so this class cannot return:

- `tools/verify.js` **[4c] provider contract** — parses each provider's returned object literal and
  compares it against the set of `P.<method>()` calls in `main.js` that have **no** defensive guard.
- `tools/simulate-load.js` **[7]** — boots **every content-script block** (14 of them) in a fresh stubbed
  browser realm and asserts that each public API the loop needs actually exists.
- Vendored `tools/vendor/acorn/` so these structural checks never silently skip when `node_modules` is absent.

That last point matters: an earlier iteration of the verifier reported "ALL CHECKS PASSED" while
privacy-skipping every AST check because `acorn` was missing. A verifier that passes vacuously is
worse than none — the dependency is now committed.



---

## 7. Empty `catch {}` — the 392-block problem (follow-up pass)

The audit counted 199. The real number after a token-aware scan was **392** across 29 files.
My first count was a regex that missed `catch (e) {   }` with whitespace and nested forms.

### Why "just delete them" would have been the wrong fix

An empty catch is often *correct*: probing the DOM of 20 third-party sites throws constantly and
retrying is the right behaviour. The bug was never that the catch existed — it was that **every
one of them looked identical**, so the ones that mattered were indistinguishable from the ones
that did not. Two failures proved to be swallowed this way:

| Swallowed failure | Consequence |
|---|---|
| `bridge.py /api/agent_temp` 404 | every temp-agent write vanished (multi-agent coordination silently dead) |
| `chrome.storage.local.get` rejecting | read failure looked like "no data" → `sysCount` reset to `{0,0}`, so counters appeared to reset every reload |

### The model: three kinds of failure, decided by the caller

New module `core/safe.js` (35 assertions):

| API | Semantics | Behaviour |
|---|---|---|
| `expected(site, fn)` | a probe that is *supposed* to fail sometimes | counted silently; escalates **once** at 25 consecutive failures, then 50/100/200 (doubling horizon — visible forever, no log spam) |
| `seen(site, e)` | drop-in for an old empty catch | counted, never logged, never rethrown |
| `wrap` / `wrapAsync` | should work; the user must know | recorded as a real fault and surfaced |
| `guard(site, fn, fallback)` | probe with a typed default | returns the fallback |
| `retry(site, fn, {tries})` | bridge/messaging, where one failure is normal | jittered exponential backoff, only the final failure reported |

Faults are a **bounded ring** (40), bursts collapse into one row with a count, and messages are
**redacted** (long tokens and `?token=` values) before they can reach a bug report.

### The three ways "fixing" this could have made things much worse

| Risk | Mitigation | Proven by |
|---|---|---|
| A missing global turns 392 silent catches into 392 **throwing** ones | every site is `globalThis.ZSSafe?.seen?.(...)` — optional chaining cannot throw | the smoke test boots all 14 blocks **with `core/safe.js` deleted** |
| A probe that fails on every poll floods the console | `expected()` is silent until 25 consecutive failures, then doubles | 200 extra failures produce 4 report lines, not 200 |
| The reporter itself throws and breaks the page | every entry point is wrapped; `describe()` handles `null`, `Symbol`, throwing `toString`, and throwing Proxies | 7 garbage-input assertions |

### Real functionality repaired (not just instrumented)

| File | Repair |
|---|---|
| `background.js` | `fetchToken` was **one** best-effort fetch. If the bridge started a second late, the token stayed empty and **every request 401'd forever**. Now: 3 retries with backoff, then bounded slow re-fetch (≈5 min), plus 401 self-healing that refreshes the token (GET retried once — idempotent; POST returned as `retryable` so a tool is never executed twice). |
| `background.js` | `agent_temp` POST was fire-and-forget `.catch(()=>{})`; now retried and reported. |
| `core/main.js` | `setExecModeState`/`setPlanState` persistence failures are now real faults — a mode that silently does not save reverts on the next page load. |
| `core/main.js` | `loadSysCount`: a failed read no longer masquerades as "no saved counters" (that zeroing was the "my counters reset" bug). |
| `popup.js`/`popup.html` | faults are now **visible**: "⚠ N errors recorded" with click-to-copy diagnostics. Also fixed a stale `4.2.0` badge still shipping in the popup. |
| `manifest.json` | `core/safe.js` first in **16/16** content-script blocks — including `chatgpt-cm` and `qwen-net`, which my first pass missed because I only checked blocks containing `main.js`. |

### Enforcement (so this cannot regress)

`npm run verify` gained a **[4d] silent-failure hygiene** group that scans with the same lexer
used to do the rewrite (a `}` inside a string or comment cannot fake a pass):

1. **0 empty catch blocks** — proven to fire by re-introducing one;
2. **every `ZSSafe` reference optional-chained** — proven to fire by inserting a bare `ZSSafe.seen()`;
3. **`core/safe.js` loads first in every block that uses it** — proven to fire by moving it to the end of the manifest array;
4. **ablation boot** — all 14 blocks with `core/safe.js` removed.

Diagnostic site names were also made useful (`agent_stability.P` → `agent_stability.tryPatch`,
`providers/claude.barMount` → `claude.barMount`): 200 distinct sites, re-derived in place by
`tools/fix-empty-catch.js --rename` without touching the hand-written repairs.

**Verification: 19 checks, 6 test suites, 154 assertions, all green.** CI runs it.
