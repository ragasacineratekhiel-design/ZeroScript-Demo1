# 4.6.0 repair and validation notes (cumulative from 3.1–4.6)

This implements repairs to the verified findings in the earlier partial audit. It is **not** a certification that every repository file is bug-free. Provider websites, Windows shell behavior and Roblox integration require real-machine testing beyond the isolated tests.

| Prior finding | Change |
|---|---|
| Mutation hedge duplicates edits; broken fallback; placeholder coalescing; batch replay | Replaced background transport with one shared service worker, one-send mutations, read-only coalescing and no uncertain fallback/replay. Removed mutation retries from the thin transport too. |
| Missing HTTP/WS authentication, wildcard CORS, exposed token | Required tokens for API/WS; restricted Host and browser Origin; explicit extension bootstrap marker. Optional extension-ID pinning. Local-process trust remains intentional and documented. |
| Claude's missing provider exports | Exported editor/session/mount methods used by core. |
| Generation latch and Studio-drop debounce | Raw generation/growth alone extends grace; sustained drop callback fires once per outage. |
| Wrong batch response ID | Captured batch payload and request ID as coroutine defaults. |
| MCP isError ignored; unsafe transient mutation retry | Preserved MCP error semantics and removed automatic mutation retries. |
| Parser amputates source at marker strings; silently drops multiple calls; misses later open blocks | Only unwrap an entire marker-wrapped source; enumerate complete JSON/Lua calls; inspect successive open blocks. Cache keys include full text instead of a collision-prone prefix. |
| Recovery kills unrelated applications | Removed port-owner/image-name termination from launchers and recovery helpers. Shutdown still terminates children the bridge itself launched. macOS launcher forwards termination to its own MCP child. |
| Batches silently truncate, always report top-level success, claim atomicity | Reject >24 before execution; return all accepted results and aggregate failure with `atomic:false`. Prevalidate shapes/timeouts. No rollback is promised. |
| Missing server ownership in tool catalogue | Include `server` in each advertised tool specification; addon scoping no longer borrows Roblox identity. |
| Startup declares success after timeout/empty/parse failure | Reject non-text/non-tool startup outcomes and non-text readiness replies. Session start wording no longer claims verified Studio access. |
| “Full tree” ignores depth and conceals incomplete output | Preserve the legacy URL but honestly return service summaries with `truncated:true`, errors, and `requested_depth`. No recursive full-tree guarantee. Removed redundant argumentless inspect calls. |
| Concurrent config writes race | RLock around config mutations plus flush/fsync and atomic replacement. Validate IDs, args and env. |
| Unbounded bodies, threads, events and task queues | 2 MiB HTTP/WS input limits; bounded HTTP concurrency, tool slots, WS tasks and SSE queues; validated JSON types/timeouts; structured HTTP/WS validation errors. |
| MCP initialize response ignored | Validate response/result before proceeding; stop an unsuccessful child. Clear stale tools on stop/failed refresh. Queue wait consumes the tool timeout budget. |
| Generic extractor loses line breaks / guesses message authors | Preserve block/BR line breaks; accept explicit assistant ownership rather than alternating parity. Unknown DOM structures fail closed, so generic sites may need more selector work. |
| Claude reply contains thinking | Exclude thinking from reply and classification text; stream sampling can still observe growth. |
| Reconnect doesn't replace current socket | Explicitly close/replace it and clear ambiguous pending requests without replay. |
| Unknown health shows ready | Require positive Studio evidence for green/ready status. |
| Missing health poll, stale hype and contradictory batch prompt | Removed undefined poll; aligned prompt with one-call execution and non-transactional transport; replaced current docs/metadata with evidence-based descriptions. Historical changelogs remain historical. |
| Team startup/inbox broken by enhancer & landing URLs | Isolated `PromptEnhancer` and `MemoryWall` from team/internal sends, hoisted normal-mode enhancement before `expectedPrefix`, stripped `location.hostname` in `isLandingKey()`, and added `pendingWake` + WS/Condition push delivery. |
| Planner/checker mutating Studio directly | Enforced coder-only Studio mutations across `core/main.js`, `background.js`, and `bridge.py`/`team_hub.py`, emitting `role_violation` (`[ROLE-BLOCKED]`) events when planner/checker attempts a write tool. |
| `/truth` unverified claims & dead post-`return` stability blocks | Added `/api/verify` (`verify_fact`) SHA-256 Studio read proof + `r.ok`-gated `[VERIFIED via …]` stamps, and moved unreachable post-`return` stability hooks before `return` in 8 bespoke providers (enforced by `audit-deep.js`). |
| Copy drift and narrow tests | Canonical source policy, SHA-256 sync script (`scripts/sync_copies.py`), Python and Node regression suites, `[4g]` role/truth verifier gate, plus CI. |

## New collaboration design

- One planner, coder and checker per team, chosen by the user in each tab's popup.
- Concurrent role-prompt submission, independent of MCP initialization; no forced list_commands bootstrap for a team session.
- The bridge permits actual introduction sends in planner → coder → checker order. It sends only labelled coordinator instructions, not invented model greetings.
- Virtual `team_status`, `team_send`, `team_read` tools run before Studio tool-name validation.
- Explicit per-peer delivery evidence controls the communication phrase. Registration and role-prompt submission are not model-readiness proofs.
- Bounded in-memory queues, run IDs, message-ID deduplication, timestamped events, mailbox acknowledgement, stale-member expiry and team isolation.
- Ambiguous chat delivery pauses the client instead of silently resubmitting. Teams stop on leave/navigation; a bridge restart requires explicit Start again.
- Website adapters still provide the input/output interface to the actual models. Without APIs it is impossible to deliver a prompt to a website-hosted model without interacting with that website. The **inter-agent transport** is the bridge, not website-to-website messaging or Studio memory.

## Verified locally

- Python unit/integration tests run the real HTTP and WebSocket handlers with temporary data and mocked MCP calls.
- Node regression tests exercise parser, generation debounce, provider exports, generic line breaks, safe transport selection and parallel team startup submission. JSDOM checks run the actual core against a simulated chat, including background inbox acknowledgement and refusal to treat an empty editor as delivery.
- Existing parser/ChatGPT extraction smoke tests remain part of the test commands.
- Sync checks prevent divergence between root/nested extension and Python copies.

## Not established by those tests

- Live selector compatibility, login/captcha behavior, hidden-tab reliability, or model compliance on each supported website.
- Actual end-to-end AI or Roblox speedup. Local concurrency is not a remote latency benchmark.
- A model's exact identity/tier or whether it understood a delivered message.
- Automatic task planning correctness, semantic conflict resolution, transaction rollback, or cancellation of an already-started MCP operation.
- Crash-durable or exactly-once mailbox delivery. A crash between website submission and acknowledgement is inherently ambiguous without cooperation from the website/API.
- Windows `start.py` / macOS Finder behavior on a real desktop. Shell syntax and source paths are checked locally; Windows is not available in this environment.

The console viewer uses UTC timestamps. It is read-only; closing it does not stop the bridge. Its separate window is opened by the Windows launcher, while the macOS instructions use a second Terminal explicitly.
