# ZeroScript MAX 4.6.0 — extension (load THIS folder)

`chrome://extensions` → Developer mode → **Load unpacked** → select this folder
(`zeroscript-extension-v2/`). The card must read **ZeroScript MAX × Roblox Studio Agent 4.6.0**.
Remove any older `zeroscript-extension` card.

## What it is

A content script that drops a small control bar above the composer on 20 AI chat sites. Press
**▶ Start** on a new chat and it drives the site's model through an agentic loop: it reads the reply,
extracts the ZeroScript command, executes it through `background.js` → `bridge.py` → Roblox Studio MCP,
and types the result back so the model can continue.

## Verified behaviour in 4.6.0

| Area | Reality |
|---|---|
| Agent loop | Starts reliably. Session state (`SESSION`) is module scope; exec mode + plan are mirrored to `window.__zsExecMode/__zsPlan` and `chrome.storage`. |
| **Composer stays yours** | The extension never locks, covers or masks the chat box. The old "Agent is working…" panel and its transparent-text mask are deleted, not disabled. If you are typing when the agent wants to send, it waits for you (up to 20 s) and shows "Holding your draft" rather than overwriting your message. |
| Exec modes | **Single** (1 turn) · **Continuous** (≤24 turns) · **Loop** (≤40 turns, planner→coder→checker rotation). All bounded; a budget banner stops a runaway model. |
| Command protocol | **One command per reply.** `execute_luau` uses `###LUA### … ###END_LUA###`; everything else is one JSON object. `core/parser.js` salvages truncated JSON. |
| Static Luau check | `core/sandbox.js` tokenises Luau and checks block balance before the call leaves the browser. It rejects only unparseable code, with a line number. It does **not** execute Luau. |
| Memory wall | `core/memory_wall.js` persists project memory and is injected into the system prompt **and** every agent turn (query-trimmed to ~700 chars). |
| **Cross-AI peer channel** | `core/peer_wall.js`. One AI's message is delivered into another AI's **context window** — not just into a log. Distinctness is enforced at delivery: a message addressed to the same provider is refused. |
| Wall / orchestration | Event-driven (`BroadcastChannel` + background routing by provider). Tasks are re-published as runtime messages so the executor tab receives them. |
| **Bridge teams & enforced roles** | Join 3 open tabs as `planner`, `coder`, `checker` in the popup. Real-time WS + Condition long-poll mailboxes; **only `coder` can mutate Studio** (planner/checker mutations are blocked at 3 layers). |
| **`/truth` ground-truth proof** | `/truth` (plus `/brutal-honest`, `/0%-lies`) gates answers on successful Studio reads (`verify_fact` SHA-256 + FNV-1a `[VERIFIED via …]` stamps) and falls back to `NOT VERIFIED` if Studio is offline. |
| Slash modes | `/truth /code /prompt /force /smart` (plus `/follow-everything`, `/absolute-effort`) — applied before `expectedPrefix` and bypassed on team/internal turns. |
| Providers | 7 bespoke drivers (DeepSeek, ChatGPT, Gemini, Claude, Kimi, GLM, Qwen, Arena, Meta) + one generic driver + 5 thin wrappers (Perplexity, Copilot, Grok, Poe, Mistral). |
| Transport | WebSocket to the bridge with an HTTP REST fallback, SSE for status. No WebTransport, no long-poll. |

## Requirements

- Roblox Studio with **Assistant → Manage MCP Servers → Studio as MCP Server** enabled.
- The local bridge running (`python start.py` / `./MacOS_START.command`, `127.0.0.1:17613` WS / `17614` HTTP, token-protected).

## Files

```
manifest.json             MV3 — 16 content-script blocks, 20 hosts, 27 host_permissions
core/config.js            identity, plans, system prompt, feedback, tool categories
core/safe.js              safe-error core: counts swallowed failures (35 assertions)
core/parser.js            command extraction + JSON salvage (37 assertions)
core/sandbox.js           Luau tokenizer + block balance (36 assertions)
core/memory_wall.js       persistent project memory
core/plan_wall.js         event-driven inter-tab wall (18 assertions)
core/peer_wall.js         cross-AI peer channel (60 assertions)
core/agent_hub.js         agent temp storage
core/prompt_enhancer.js   slash modes + spec expansion
core/transport.js         promise-based runtime transport (coalesced reads + verifyFact)
core/agent_stability.js   composer/generation hardening
core/main.js              agentic loop, exec modes, UI, chips, diagnostics
providers/*.js            per-site drivers
background.js             service worker (bridge link, plan wake, agent temp)
overlay.css               in-page UI styles
```

## Does the AI actually talk to a *different* AI?

Mostly it did **not** before 4.6.0, despite the "2–3 AI" badge. What existed was a
`BroadcastChannel` plus a storage log: a message posted there was never turned into a turn on
another tab, and the one cross-tab action that *did* run (`execute_luau`) executed code silently
— the receiving AI never saw the sending AI's words. Two more holes: roles were assigned by
**tab index**, ignoring your role→AI mapping, and nothing stopped two roles landing on the **same**
model, which makes the "review" step a model grading itself.

4.6.0 adds `core/peer_wall.js`:

| Property | How it is guaranteed |
|---|---|
| Identity | each tab derives its provider from `location.hostname` (17 host patterns) |
| Distinctness | `send()` **refuses** a message to its own provider; `auditPlan()` names every duplicate-role problem in the UI |
| Delivery | two transports (BroadcastChannel + background routing by provider) and an ack; `stats().undelivered` counts messages no peer confirmed |
| **Conversation** | inbound peer messages are folded into the next prompt by `main.js` → `peerContext()`, labelled with the sending model and "do not claim to be them" |
| Real handoff | in **Loop** mode, if a role belongs to a *different* provider, the turn is handed to that tab and this tab waits for its reply instead of playing all three roles itself |

What is still true and worth knowing:

- You need **two different provider tabs open** (e.g. ChatGPT + Claude). Same-model plans are
  deliberately refused, so a 2× DeepSeek plan will not talk.
- **Arena** hosts several models on one hostname, so it counts as one provider here. A
  multi-model Arena setup is not detected as multiple AIs.
- The peer channel carries text/code between models; it does not merge their memory walls.
  Each tab keeps its own.

## Latency — what the numbers actually are

Every timing constant is now either consumed by real code or deleted. `npm run verify`
fails if a documented value disagrees with the live one, or if a declared knob has no reader.

| Path | Value | Why that value |
|---|---|---|
| Provider `waitFor` poll | **8 ms** (was 30) | a DOM read is microseconds; 8 ms still leaves the main thread idle ~99% |
| Editor read-back verify | **poll, not fixed sleep** | the old fixed 25–50 ms was *simultaneously* too slow when responsive and too short when not |
| Send-recovery poll | **8 ms** (was 62) | only runs when the send button is wedged; notices recovery ~8× sooner |
| Peer/plan delivery | **event-driven** | BroadcastChannel + background routing + ack; no polling at all |
| Status poll (tab) | **800 ms** (was 100) | background already *pushes* `zs-status` on change; the poll is a liveness net |
| Popup refresh | **800 ms** (was 125) | same reason; a popup is open for seconds |
| Theme sync | **800 ms** (was 250) | a colour swap is not a hot path |
| Camouflage sweep | **400 ms** (was 10) | a full-document `MutationObserver` already covers every change; the interval is only a convergence net |
| `chatgpt-cm` sync | **signature-gated, 400 ms ceiling** | previously a full DOM sweep 4×/s forever; now zero work when nothing changed or the tab is hidden |
| Bridge `HTTP_TIMEOUT` | **5000 ms** (was 600) | 600 ms produced false "bridge offline": `/api/status` fans out to a PowerShell probe budgeted 8 s |
| Bridge status/tools TTL | **0.4 s / 0.5 s** (was 0.06/0.08) | a TTL shorter than the work it caches guarantees a miss — we paid for the cache *and* re-ran the probe |
| Bridge Studio confirm | **0.35 s** (was 1.5) | re-probe to reject a flapping read |
| Connector handshake poll | **12 ms** (was 75) | loopback RTT is <1 ms |

Two constants that were **pure decoration** are gone: `STUDIO_POLL_MS: 10` and
`STUDIO_HEARTBEAT_MS: 6` (zero consumers). So was `STUDIO_HEARTBEAT_INTERVAL = 0.4` in
`bridge.py`. Faster numbers that nothing reads are not speed.

## Diagnostics

```js
window.__zsDiag            // last 300 decisions of the loop
window.__zsMemoryWall.stats()
window.__zsTransportStats()
window.ZSSafe.stats()      // swallowed-error counts per call site
```

The popup also shows a warning line ("⚠ N errors recorded") whenever something was caught
and recorded; clicking it copies a full JSON dump for a bug report.

### Errors are not silently swallowed any more

There were 392 empty `catch {}` blocks in 4.6.0. They are all instrumented through `core/safe.js`
with three different semantics, because "caught" and "ignored" are not the same thing:

| API | Use | Behaviour |
|---|---|---|
| `expected(site, fn)` | probes that legitimately fail (element not there yet) | silent, counted; escalates **once** at 25 consecutive failures, then at 50/100/200… |
| `seen(site, e)` | the drop-in for an old empty `catch` | counted, never logged, never rethrown |
| `wrap` / `wrapAsync` | should work; user must know | recorded as a fault and surfaced |
| `guard(site, fn, fallback)` | probe with a typed default | returns the fallback, counts |
| `retry(site, fn, {tries})` | bridge / messaging (worker asleep is normal) | jittered backoff; only the final failure is reported |

Every call site is written `globalThis.ZSSafe?.seen?.(...)` — optional-chained so a missing
module cannot turn 392 silent catches into 392 exceptions. `npm run verify` boots the whole
extension **with `core/safe.js` deleted** to prove that, and fails if an empty catch or a bare
`ZSSafe.x()` ever reappears.

## Tests

From the repo root: `npm install && npm run verify` — parse checks, manifest integrity,
content-script ordering, AST scope analysis (the 4.2.0 ReferenceError class, with a self-test),
cross-module API contract, version agreement, silent-failure hygiene (no empty catches, no unsafe
`ZSSafe` calls, load order), eleven assertion suites, and a stubbed-browser boot of all site
blocks — including a boot with `core/safe.js` removed. The count is printed by `npm run verify`;
it is not repeated here, because a number in prose is the first thing to go stale (it said "six
suites, 154 assertions" long after that stopped being true).

GPL-3.0-or-later — see `../LICENSE`.
