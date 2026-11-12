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


---

## 8. Cross-AI communication — what it actually did (follow-up pass)

**Finding 39 (🔴 P0, the big one):** the extension's headline claim — "2–3 AI work together" —
was **not true**. I traced every path end to end.

| What the UI claimed | What the code did |
|---|---|
| "2 AI — Planner + Coder" | `send()` posted a `BroadcastChannel` envelope and pushed it to a local log. **No tab ever turned that envelope into an AI turn.** |
| "the coder executes the planner's spec" | The only cross-tab effect was `handleWallTask()` → `execute_luau`, which ran **silently**. The receiving AI never saw the sending AI's words. That is a remote-control channel, not a conversation. |
| "assign an AI to each role" | `wake_provider_tabs` computed `roleForTab = planRolesOrder[idx % n]` — roles came from **tab index**. The user's role→AI mapping was ignored. |
| "a different model reviews the work" | Nothing prevented two roles pointing at the **same** provider, so the "review" step was a model grading itself. |

So: the user ran two tabs, both auto-started, both talked to Roblox Studio, and the two AIs never
exchanged a single word. The permission list, the wall log and the plan UI all looked correct,
which is exactly why this survived three versions.

### Fix: `core/peer_wall.js` (60 assertions)

| Guarantee | Implementation |
|---|---|
| Identity | provider derived from `location.hostname` (17 patterns); the same table is duplicated in `background.js` and `test-peer-wall.js` asserts the two cannot drift |
| **Distinctness** | `send()` returns `{ok:false, refused:"same-provider"}` instead of delivering; `auditPlan()` reports duplicate roles and "every role is the same AI" in the plan menu and the plan button (`Agent ⚠`) |
| Delivery | BroadcastChannel **and** background routing (`peer_route` resolves provider → tab ids, refuses to deliver back into the sender's provider), plus an ack over `peer_ack` |
| **Conversation** | `main.js` `peerContext()` drains the mailbox at the top of every `submitAndGetBase()` and prepends a labelled block: *"message from CLAUDE as coder … you are working with OTHER AIs that are NOT you … do not claim to be them"* |
| Real handoff | Loop mode: if the turn's role is assigned to a **different** provider, the turn is sent to that tab and this tab **waits for its reply** (`waitForPeerReply`) instead of impersonating all three roles |
| Honesty | `stats().undelivered` counts envelopes no peer acknowledged; `reportStatus` records refusals and routing failures through `core/safe.js` |

### Verified with two real realms, not one

`test-peer-wall.js` loads the module twice in separate `vm` contexts with real hostnames
(`chatgpt.com`, `claude.ai`) and asserts the actual claim:

- a message from ChatGPT is accepted by Claude and **rejected** by a third provider;
- Claude's next prompt contains ChatGPT's words, labelled `CHATGPT`, with the anti-impersonation rule;
- ChatGPT's own mailbox stays **empty** (it did not talk to itself);
- a send to its own provider is **refused**;
- the two realms resolve to **different roles** from the same user mapping.

That last group is why the first draft of this test passed vacuously: with a plain `require()`
there is no `location`, so every module was `"unknown"`, and `sameProvider("unknown", …)` is
always false — the distinctness gate could never fire. A test that cannot fail is worthless.

### Still true after the fix (documented, not hidden)

- two *different* provider tabs must be open; same-model plans are refused by design;
- Arena is one hostname, so several Arena models are **one** provider here;
- peer text crosses models, memory walls do not — each tab keeps its own.


---

## 9. Latency pass — and the "fake fast" constants

**Finding 40 (🟠 P1): several timing constants existed only to look fast.**
`core/config.js` advertised `STUDIO_POLL_MS: 10`, `STUDIO_HEARTBEAT_MS: 6` and
`HEARTBEAT_MS: 62`; `bridge.py` declared `STUDIO_HEARTBEAT_INTERVAL = 0.4`. **None of them had a
consumer.** `config.js` also documented a 62 ms heartbeat while `background.js` ran 1000 ms, so the
tree quoted a number that did not exist. Worse, the *prompt text* told the model
"Wall latency: 10ms honest", which the model then repeated to the user.

**Finding 41 (🔴 P0, produced a real bug): `HTTP_TIMEOUT = 600` was shorter than the work it guards.**
`GET /api/status` uses it as the default, and the bridge's status build calls
`_roblox_studio_app_running()` — a PowerShell/tasklist probe budgeted 8 s. On any cold start that
read timed out, so the popup showed **"Bridge offline" while the bridge was healthy** and the tool
list silently stayed stale. A speed number had become a correctness bug.

**Finding 42 (🟠 P1): a redundant hot loop.** `main.js` ran `setInterval(scheduleSweep, 10)` — 100
sweeps/second — *on top of* a full-document `MutationObserver` doing the same work.
`providers/chatgpt-cm.js` ran a full DOM sweep every 250 ms forever, visible or not.

### What was changed, and what was deliberately *not* made faster

| Path | Before | After | Reasoning |
|---|---|---|---|
| Provider `waitFor` (9 providers) | 30 ms | **8 ms** | a DOM read is µs; 8 ms keeps the thread idle ~99% |
| Editor verify | fixed 25–50 ms sleeps | **read-back poll** | a fixed wait is both too slow and too short |
| Send-recovery poll | 62 ms | **8 ms** | recovery path only; notices recovery 8× sooner |
| Status poll | 100 ms | **800 ms** | background already pushes every change |
| Popup / theme | 125 / 250 ms | **800 ms** | not hot paths |
| Camouflage sweep | 10 ms | **400 ms** | `MutationObserver` already covers changes |
| `chatgpt-cm` sync | 250 ms full sweep | **change-gated + hidden-idle** | zero work when nothing moved |
| `HTTP_TIMEOUT` | 600 ms | **4000 ms** | 600 ms was a *bug*; it must exceed the bridge probe |
| Bridge status/tools TTL | 60 / 80 ms | **400 / 500 ms** | a TTL below the work it caches always misses |
| Bridge Studio confirm / retry | 1.5 s / 1.0 s | **0.35 s / 0.5 s** | re-probe early, still rejects flapping reads |
| Connector handshake poll | 75 ms | **12 ms** | loopback RTT < 1 ms |

Deliberately **not** reduced: MV3 service-worker heartbeat (1 s — Chrome clamps it anyway), bridge
subprocess timeouts (8–10 s — real process spawns), tool-call request timeouts (90 s — Studio may
genuinely be loading a place), and the 5 s plan-wall safety net (event delivery already covers the
fast path).

### Enforcement

New verifier group **[4f] timing honesty**:

1. no declared timing constant without a consumer;
2. every value documented in `config.js` matches the live constant in `background.js`
   (proven by injecting `HEARTBEAT_MS: 62` and watching it fail);
3. `HTTP_TIMEOUT` must exceed the cost of the probe it guards;
4. any sub-50 ms `setInterval` in a hot path warns.

`config.js`'s prompt text no longer claims a 10 ms wall; it describes the peer channel as it is.


---

## 10. The tooling was lying — and that is the worst finding in this document

**Finding 43 (🔴 P0, and it invalidates earlier "ALL CHECKS PASSED" claims).**
The verifier's AST walker had a **dangling `else`**:

```js
if (Array.isArray(v)) for (const c of v) if (c && c.type === "string") walk(c);
else if (v && typeof v.type === "string") walk(v);   // ← binds to the INNER if
```

The `else` bound to the *inner* `if`, so a single-object child — which includes
every `FunctionDeclaration.body`, a `BlockStatement` — was **never recursed into**.
The walker entered a function, visited its parameters, and stopped.

I proved the impact rather than assuming it: I planted `ghostVarInsideFunction()` — a
guaranteed ReferenceError — inside a function body and ran the suite. It printed
**"ALL CHECKS PASSED."** The check had been verifying almost nothing below the
top level of each file, for the entire project.

Second, independent bug in the same check:
`if (!declaredAnywhere.has(name)) continue;` treated *any* unknown identifier as
"probably a host global (ZS, chrome…)". Combined with the walk bug this meant the
one thing the check exists to catch — a typo'd call — was exempt by default.

### Fixed, and made structurally impossible to regress

| Change | Effect |
|---|---|
| braced every `if/else` in the walker (5 sites across 2 tools) | function bodies are visited |
| extracted **one** `findUnreachableReads(src)` | the check and its self-test now run the *same* code; a test that reimplements the checker proves nothing |
| explicit `HOST_GLOBALS` allowlist (~110 verified names) | an undeclared name is a **failure**, not an exemption |
| second fixture `tools/fixtures/undefined-inside-function.js` | an undefined call inside a nested function is now a permanent regression test |
| function-declaration **hoisting** restored after the extraction | putting a fn's name in its own scope produced 1,235 false positives |

Proof, after the fix — same planted bug:
`✗ [scope] core/main.js:376 reads "ghostVarInsideFunction" which is declared NOWHERE…`

### What the repaired check immediately found

- **`providers/generic.js` — `captchaPresent` does not exist.** I wrote
  `if (captchaPresent && captchaPresent())` in the previous pass. Guarding an
  *undeclared* variable is a ReferenceError, not a null check, so every
  generic-driver site threw there. Replaced with a real DOM probe.
- 10 unhandled async rejections, the worst being `agentLoop(base)` called bare:
  one rejection inside the agent loop killed the session silently, leaving the
  "Agent is working" cover up and no error anywhere. Now caught, the UI is
  restored, and the reason is shown.
- 3 instances of `try { someAsyncFn(); } catch {}` — a try/catch **cannot** catch a
  rejected promise. This is why `agent_hub`'s temp store and arena's
  `restoreDirectOnce` could fail with nothing recorded.
- `popup.js` and `chatgpt-cm.js` set intervals that nothing could ever clear.

### New standing gate: `[8] deep defect audit`

`tools/audit-deep.js` (a real defect hunter, not a linter) now runs inside
`npm run verify` and fails on: unparseable files, unhandled module-scope async
rejections, leaked timers, unreachable functions, and drift between providers in
helpers that are supposed to be identical.

Its own first version was wrong twice — it reported 11 unused variables that were
destructuring patterns, and 36 "provider drift" warnings for functions that are
*supposed* to differ per site (each reads a different DOM). Both were fixed by
making the check narrower and more honest, not by suppressing output.

### Honest state

| Severity | Before this pass | Now |
|---|---|---|
| P0 (broken / lying checks) | 2 | 0 |
| P1 (real defects) | 54 | 0 |
| P2 (dead / duplicated) | 7 | 7 advisory |
| P3 (hygiene) | 30 | 30 advisory |

The 37 remaining advisories are real but low-value: duplicated `fileFromImage`
across providers, `async` functions with no `await`, and single-use globals
assigned for debugging. They are listed by `node tools/audit-deep.js` rather than
hidden.

## 11. Leak pass — what the analyser could not see

The previous passes found crashes and lies. They could not find **leaks**, because
a leak is not a wrong value or a dead function: it is a thing that keeps working
after its reason is gone. This pass went looking for that class specifically.

### Fixed

| Site | What leaked | Proof it was real |
|---|---|---|
| `providers/qwen.js` | two document-wide `MutationObserver`s, `disconnect()` count 0 | `test-observers.js`: old code disconnects 0, new disconnects 2 on `pagehide` |
| `providers/qwen.js` | code observer re-scanned **every code block on every mutation** | 200 mutations x 2 observers: **200** full-document scans before, **1** after |
| `bridge.py` `MCPClient.stop()` | killed the child but never `wait()`ed or closed 3 pipes | 19 start/stop cycles: **3** descriptors leaked before, **0** after; child now always reaped |
| `bridge.py` | `call_tool`/`batch`/status-subscription were unretained `create_task`s | 2 dispatched tool tasks now cancelled on client disconnect (was 0 tracked) |
| `background.js` | `call_tool` stored the literal `{id:-1}` in the coalesce map, not its promise | a second identical call awaited that object and answered **as if it were the tool result** |
| `background.js` | `list_tools` could leave a rejected promise in the map forever | caught + `finally` delete |
| `agent_hub.js`, `plan_wall.js`, `peer_wall.js` | `BroadcastChannel` never closed; `peer_wall.close()` had no caller, `plan_wall` had no close at all | each now releases on `pagehide` |

### Not leaks, after checking (so I did not "fix" them)

| Suspect | Verdict |
|---|---|
| `core/main.js` — 11 `setInterval`s with 3 `clearInterval`s | all are page-lifetime pollers; a per-frame loop does not leak, every instance dies with the document. Verified `P.init()` is called once and the intervals are inside it |
| `bridge.py` status subscription | I wrote that it "polls forever after disconnect". **Wrong** — measured 0 pushes with no client connected. `while ws in clients` already ended it within one 3 s period. Corrected the comment to say what was actually wrong |
| `popup.js` refresh interval | already paused when hidden and cleared on `pagehide` |
| `kimi.js` input-lock observer | element-scoped and disconnected on unlock — a complete lifecycle |
| `background.js` BroadcastChannel | service worker: no `pagehide` exists, and the browser closes it on teardown |

### Honesty fixes (a model plans around what you tell it)

Six live prompt strings promised the model a **runtime sandbox** that does not
exist — "executes against mock Roblox env", "runtime TypeErrors are intercepted",
"70% of nil/Type errors are caught", "returns the precise stack". `core/sandbox.js`
is static analysis and says so in its own header. All six now describe the real
Luau tokenizer and state that runtime behaviour needs Studio.

Four percentages ("~20-35% quality gain", "~35-40% boost", "~40-50% Pro
proximity") were labelled "tested"/"measured" with no eval harness, dataset or
recorded run anywhere in this repository. They are gone; the mechanism is
described instead.

`popup.js` rendered a fabricated `tools: 14` under a "Bridge offline" label.

### The analyser itself, again

Six checks were lying, and fixing them changed the count more than fixing the
code did:

| Check | Lie | Consequence |
|---|---|---|
| `dom-injection` | template literals assumed safe when they start with `<` | `` `<b onclick="${providerText}">` `` passed — a **false negative**, the dangerous direction |
| `dom-injection` | identifier lookup saw only the first declarator of `let a=…, b=…` | false positives on `main.js` bar render |
| `unguarded-json` | comment claimed an ancestor try-search that was never written | reported **every** `JSON.parse` (7 findings) |
| `unused-var` | ignored cross-file provider globals | 4 false positives on `ZSParse`, `ZSAgentStability`, … |
| `duplicate-logic` | reported `allFiles[0].file` at line 0 | all 7 findings pointed at `background.js:0`, a location nobody can act on |
| `async-no-await` | flagged exported provider methods | `await P.ensureComposerReady()` is a uniform async interface; one provider answering synchronously is not a defect |

A "same function name, different body = drift" check was written, produced **34
findings** across 10 providers that legitimately differ per site, and was
**deleted rather than shipped** — a check that fires on everything carries no
information.

`tools/verify.js`'s provider-contract gate keyed on `/const\s+ZSProvider\s*=/`
against raw source, so **my own comment text** made `claude-connector.js` look
like a provider and failed the gate. It now strips comments first.

### Two dead watchers removed

`agent_stability.js` and `claude-connector.js` both installed
`Object.defineProperty(window, "ZSProvider", { set() { … } })` to react to a
provider appearing later. Providers declare `const ZSProvider = (() => …)()`, a
**lexical** binding: it never touches a window property or setter. Measured in one
VM realm — setter fired **0** times, `window.ZSProvider` stayed `undefined`, and
the provider attached anyway. Both watchers deleted; the retry timers are the
real attach path (verified: `attachedFlag` true, `ensureComposerReady` wrapper
present).

### Standing gates added

`observer-release`, `observer-storm`, `channel-leak`, `false-claim`, plus a
`try`-aware `unguarded-json`. Each was verified against a fixture that *should*
trip it and a fixture that should not, because a gate nobody has seen fail is a
gate you cannot trust.

| Suite | Assertions |
|---|---|
| `test-observers.js` (new) | 13 — fails 6 against the pre-fix provider |
| `test-bridge.py` (new) | 9 — fails 2 against the pre-fix `stop()` |
| all suites | **11 files, 263 assertions** — `test-composer.js` (12) and the bridge suite's
| | extra launcher cases (4) were added after that line was first written |

### The composer cover — deleted, not fixed

**Reported by the user as:** "Agent working … makes me not able to type even if the
AI is done."

**What it actually was.** Two mechanisms, both on the composer:

1. `ui.inputCover(true)` painted a fixed-position `#zs-input-cover` panel reading
   "Agent is working…" over the chat box, sized every animation frame to the
   editor's rectangle, with `pointer-events: auto` so clicks could not reach the
   input.
2. `P.setInputLock(true)` plus a `.zs-typing` class made the typed text
   `color: transparent`.

**Why it stuck.** The cover was raised in `submitAndGetBase`, in the agent loop
and in `startSession`, and lifted in their `finally` blocks. Several exits never
reach a `finally`: a new chat opened mid-bootstrap bumps `startGen`, which makes
every later `alive()` checkpoint fail — including the one guarding the cleanup.
The codebase already carried a comment about fixing exactly that, from a previous
occurrence ("the cover was stuck forever … validated live 2026-07"). A failure
mode that has needed a special case once will need it again.

**Decision.** The user asked for it gone rather than patched, and they are right:
this is not a bug in the cover, it is the cover. Removed at the source.

| | Before | After |
|---|---|---|
| `inputCover` | 9,188 chars of placement, clipping and colour-blending | 1,573 chars: inert, and removes any stale panel |
| `opaqueBg`, `parseColor`, `blendOver` | backdrop colour for the panel | deleted (0 remaining callers; `blendOver` looked used and was not) |
| `setInputLock(true)` | 2 sites (loop, bootstrap) | 0 sites |
| `.zs-typing` | transparent text + 140px height cap | never applied; stale class stripped |
| while the agent works | panel over the composer, text invisible | text visible, composer fully usable |

**The half that is easy to miss.** With the composer unlocked, the agent's next
send would overwrite whatever the user was typing. `submitAndGetBase` now compares
the box contents with the text it is about to send, waits up to 20 s for the user
to send or clear a draft, and refuses to type over it — with a banner explaining
the pause. *My first comment claimed this guard already existed. It did not.* The
audit's own dead-code check is what caught that `blendOver` had no callers after
my edit; the same scepticism is what made me check the guard instead of trusting
the comment.

`test-composer.js` (12 assertions) asserts the removal from outside: no lock is
ever engaged, no cover is created, no mask is added, a stale build's panel is
forced hidden by the stylesheet, and a draft is protected. **11 of the 12 fail
against the previous code**, so the suite measures the change rather than
describing it.

---

## 12. Remediation pass — 4.6.0 (Bridge Teams, Strict Role Enforcement, `/truth` Verification & Post-Return Dead Code)

User-reported production failures investigated line-by-line across every canonical file:

| # | Sev | Area | Exact root cause | 4.6.0 fix & regression test |
|---|---|---|---|---|
| 44 | 🔴 P0 | `core/main.js`, `core/prompt_enhancer.js`, `providers/claude-connector.js` | `submitAndGetBase` computed `expectedPrefix` *before* `ZSMemoryWall.buildTrimmedContext` and `ZSPromptEnhancer.wrapTypeAndSend` rewrote outgoing prompts. On team startup (`ZS.buildTeamPrompt`) and inbox delivery (`Bridge team inbox`), the enhancer rewrote the role prompt into a Tap Simulator spec, breaking `landed()` so `team_ready` and `team_ack` never fired in real Chrome. | Hoisted context/enhancement before `expectedPrefix`, added `isInternalPrompt()` + `__zsTeamActive` / `__zsSkipEnhance` guards, removed duplicate `wrapTypeAndSend` in `claude-connector.js`. Covered by `tests/test-team-dom.js` (now loading real `memory_wall.js` + `prompt_enhancer.js`) and `test-composer.js`. |
| 45 | 🔴 P0 | `core/main.js` (`P.conversationKey`, `startTeam`, `syncSessionState`) | `main.js:18` prefixes `P.conversationKey()` with `location.hostname` (`"claude.ai/new"`). When Claude, DeepSeek or generic sites redirected from `/new` to `/chat/<uuid>` on the first send, `syncSessionState` saw `key !== "claude.ai/new"` and immediately fired `team_leave` and `loop.abandonedNewChat`. | Added hostname-stripping `isLandingKey()` in `startTeam`, `syncSessionState`, `A.startingKey` and `A.loopKey`, plus `pendingWake` post-`loop.end` inbox drain, WS-first `team_*` actions and `threading.Condition` 0 ms long-poll (`?wait=1`). Covered by `tests/test-team-dom.js` (`/new` → `/chat/test`) and `tests/test_bridge_team.py`. |
| 46 | 🔴 P0 | `core/config.js`, `core/main.js`, `background.js`, `team_hub.py`, `bridge.py` | Planner and Checker roles were enforced only by prose instructions; `handleWallTask` even matched `/coder\|checker\|executor/`, causing Checker tabs to execute Luau directly. | Added 3-layer hard role enforcement: `ZS.roleAllowsTool` in `runTool` + coder-only `handleWallTask`, `roleCheckTool` + `member_id` forwarding in `background.js`, and `TeamHub.check_mutation` + HTTP 403 / `role_violation` console `[ROLE-BLOCKED]` events in `bridge.py`. Covered by `[4g]` in `tools/verify.js`, `tests/test-team-dom.js`, `tests/test-extension.js` and `tests/test_bridge_team.py`. |
| 47 | 🟠 P1 | `core/main.js`, `core/prompt_enhancer.js`, `bridge.py`, `background.js` | `/truth` counted failed reads toward `truthReads`, produced no cryptographic/content proof stamp, looped forever if Studio was offline, and ignored `/brutal-honest` / `/0%-lies`. | Added `verify_fact` tool + `GET/POST /api/verify` (Studio read-only probe returning SHA-256 + UTC timestamp), FNV-1a `[VERIFIED via …]` stamps on successful reads, `NOT VERIFIED` fallback when Studio is offline, and `/brutal-honest` / `/0%-lies` / `/follow-everything` / `/absolute-effort` aliases. |
| 48 | 🟠 P1 | 8 providers (`glm`, `gemini`, `meta`, `kimi`, `arena`, `deepseek`, `qwen`, `chatgpt`) | `ULTRA+` `ZSAgentStability.tryPatch` + SPA `history.pushState`/`replaceState` blocks sat *after* `return { ... };` and never executed. | Moved before `return` in all 8 providers; added AST post-`return` dead-code gate in `tools/audit-deep.js` (`P0=0, P1=0, P2=0`). |

