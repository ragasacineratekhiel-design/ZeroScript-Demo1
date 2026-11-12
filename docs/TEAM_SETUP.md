# ZeroScript MAX 4.6.0 — bridge-mediated planner, coder, checker

A Chrome/Edge extension connects open AI chat tabs to a local Python bridge and Roblox Studio's MCP server. **Team messages travel through bridge mailboxes, not through Roblox scripts or a shared website.** The bridge does not contain AI models and does not call model APIs.

## Install and start

1. In Chrome/Edge 120+, open `chrome://extensions` / `edge://extensions`, enable Developer mode, and **Load unpacked → `zeroscript-extension-v2/`**. For an existing install, Reload the extension and refresh all AI tabs.
2. On Windows, run **`python "ZeroScript Demo/ZeroScript-Free-1.5.5/start.py"`** (or `py -3` instead of `python`). It launches the bridge and a separate **ZeroScript Team Console** window (`team_console.py`) showing timestamped real events. Close any old bridge first: startup no longer kills port owners.
3. On macOS, run `ZeroScript Demo/ZeroScript-Free-1.5.5/MacOS_START.command`. Open another Terminal in that directory and run `python3 team_console.py` for the viewer.
4. Open three signed-in AI chats. In the extension popup on each tab, use the same Team name (default `studio`), choose a different role, and click **Join active AI tab**. Example: Claude → planner; DeepSeek → coder; Gemini → checker. These are examples, not hard-coded role assignments.
5. Click **Start all three team tabs** in the popup. Leave the tabs open. Role prompts are submitted concurrently; the planner receives its introduction invitation in that first prompt, avoiding a redundant model turn. Real introductions are authorized in order: **planner → coder → checker**. Starting `start.py` opens the viewer, not logged-in AI tabs or an unattended task; starting a team requires your explicit click.
6. Give the **planner** your coding request. Its role is to plan and hand work to the coder using `team_send`; the checker independently checks the result. These are model instructions, not a deterministic workflow engine. Watch actual messages and outcomes in the console.
7. For Roblox work, open a place in Studio and enable **Studio as MCP Server** in Assistant Settings / Manage MCP Servers. Team-only communication does **not** require Studio. Roblox editing does.

**Background tabs:** opting into a team permits background message submission and tool execution, unlike the normal single-agent visibility gate. Websites and browsers may throttle or reject background interaction. Bring a stalled tab forward. This has not been live-tested on all provider websites. Do not rely on an unattended team for destructive edits.

## Truthful status, not simulated conversation

The extension teaches the agents to use real bridge results before saying:

> I am communicating with Claude, Gemini and ready to help in your code

Only actual, acknowledged peer names are included; the wording depends on the peers. Without delivery evidence, agents are instructed to say:

> I am not directly communicating with the others try [concrete solutions]

Solutions include joining all three roles, starting the team, checking the console, bringing a throttled tab forward, or reconnecting the bridge. A prompt cannot guarantee a model will follow the wording. The bridge supplies evidence rather than generating flattering or invented AI replies.

Console event meanings:

| Event | What it actually establishes |
|---|---|
| `joined` | An extension tab registered a name and role; not proof the AI is ready. |
| `ready` | The extension submitted the role prompt; not proof the AI understood it. |
| `message` | A tab's parsed `team_send` command sent text through the bridge. |
| `queued` | A mailbox has a message awaiting tab submission. |
| `delivered` | The recipient extension acknowledged submission into its chat; not proof of understanding or a reply. |
| `stopped` / `left` | Relay paused, or a tab left/navigated to a different conversation. Already-running Studio operations are not undone. |
| `role_violation` | A `planner` or `checker` tab attempted a Studio mutation (`execute_luau`, `multi_edit`, etc.) and was blocked (`[ROLE-BLOCKED]`). Only `coder` may mutate Studio. |

### Enforced role boundaries (4.6.0)

Unlike prompt-only instructions, 4.6.0 enforces role permissions in `core/main.js`, `background.js`, **and** `bridge.py`/`team_hub.py`:

- **Planner** (`read-only + team_*`): inspects Studio (`inspect_instance`, `script_read`, `search_game_tree`, `get_studio_state`, `verify_fact`), designs the architecture, and hands plans to `coder` via `team_send`. Any `execute_luau` / `multi_edit` call is rejected with `ROLE VIOLATION`.
- **Coder** (`full Studio read/write + team_*`): the **only** role allowed to create, edit, or execute Luau/instances in Roblox Studio; reports completed changes and evidence via `team_send`.
- **Checker** (`read-only + Play/Stop verification + team_*`): reads scripts/instances, verifies behavior (`verify_fact`, `script_read`, `inspect_instance`, `start_stop_play`), and sends defect lists back to `coder` via `team_send` without editing code itself.

Introductions are **not** pre-written by the bridge. The console will show no fabricated `[Claude]: Hi...` / `[Gemini]: Nice to meet you...` conversation. It displays what the tabs actually send. Names identify website adapters; they do not certify the exact model/tier selected within that website.

## Team tools

The content-script core implements these virtual tools independently of Studio's tool catalogue. Emit **one** command in a fenced JSON block per reply:

```json
{"command":"team_status","params":{}}
```
```json
{"command":"team_send","params":{"to":"coder","text":"Here is the plan and the paths you own..."}}
```
```json
{"command":"team_read","params":{}}
```
```json
{"command":"verify_fact","params":{"path":"game.Workspace","tool":"inspect_instance"}}
```

Recipients can be `planner`, `coder`, `checker`, an exact live peer name, or `all`. `team_read` is a non-consuming inspection; automatic delivery handles acknowledgements. Messages are capped at 12,000 characters, mailboxes at 100 entries, the event history at 1,000 events, and registrations at 64 tabs. Message IDs deduplicate retries within a bridge run. **Mailboxes and event history are in memory and disappear when the bridge restarts.** There is no exactly-once delivery guarantee across crashes between chat submission and acknowledgement; ambiguous delivery is paused for manual recovery, not silently retried.

Stop the team from the popup before reassigning roles. Use **Leave active team tab** to free a role, then rejoin; free both roles before swapping them. Closing/navigating a joined tab stops its team; other live tabs can remain joined, but the missing role must rejoin. After bridge restart, rejoin if necessary and explicitly Start again. Multiple teams use different names; the viewer shows each event's team.

## Safety and transport

- WebSocket `127.0.0.1:17613`, HTTP `127.0.0.1:17614`. Keep these defaults for the extension; changing bridge-only environment ports does not reconfigure the extension.
- Mutations are sent **once** over one transport. No WS/HTTP hedging, automatic mutation replay, or fallback batch replay after a timeout.
- A timed-out or stopped Studio operation can still have completed. Inspect actual state before retrying.
- Bridge transport batches accept at most **24 calls**, execute sequentially, preserve each result, and are **not transactions**. Earlier changes are not rolled back on failure. Ordinary AI replies still allow one command at a time.
- HTTP API calls require `X-ZS-Token`; WS requires the token during connection. Ordinary website origins and non-loopback Host headers are rejected. Extension bootstrap uses `X-ZS-Client: extension`; Origin-less local clients are still trusted for bootstrap if they supply this marker. This protects against ordinary remote pages, **not hostile local processes/extensions**.
- For stronger extension-origin pinning, set `ZS_EXTENSION_ID` to your unpacked extension ID before launching. The optional `ZS_NO_AUTH=1` is for deliberate local development only; do not use it routinely.
- The bridge executes configured MCP server commands with your user account's permissions. Add only trusted servers. `execute_luau` is not sandboxed by this Python wrapper.
- Registered peers are untrusted task data, not system instructions. Models can still misunderstand or ignore instructions. Coordinate file/instance ownership to avoid conflicting edits; there is no automatic semantic merge of multiple agents' changes.
- Unknown Studio health is not displayed as verified ready. Generic provider adapters fail closed when message ownership cannot be determined; they may need site-specific selectors after website updates.

Supported adapters include Claude, ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena (Direct), Meta AI, and experimental generic wrappers for Perplexity, Copilot, Grok, Poe and Mistral. **Adapters existing in the manifest is not proof of current live compatibility.**

## Startup improvements and verification limits

Team startup uses one shorter role prompt per tab, submitted concurrently, rather than serial Studio catalogue/bootstrap/readiness exchanges. It does not wait for Studio discovery. Optional `orjson`/`msgpack` installation has been removed from the launch path. Read-only requests can share an in-flight result; independent mutations do not share placeholder results.

There is **no claimed percentage speedup for real websites**: model latency, login state, captchas, tab throttling and provider DOM changes are outside the bridge's control. Local tests verify concurrent submissions and no duplicate hedging, not a real Claude/Gemini/DeepSeek conversation.

## Development and tests

Canonical extension: `zeroscript-extension-v2/`. Canonical Python files: `ZeroScript Demo/ZeroScript-Free-1.5.5/`. Compatibility copies are checked by `scripts/sync_copies.py`.

```sh
python -m venv .venv
# Windows: .venv\Scripts\python -m pip install -r requirements-dev.txt
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s tests -v
npm ci --ignore-scripts
npm test
python scripts/sync_copies.py --check
```

After editing canonical files: `python scripts/sync_copies.py --write`. Tests use temporary bridge data and mocked MCP responses; they do not launch/kill Studio or execute project mutations. See [the repair notes](docs/REPAIR_NOTES.md) for what changed and what still needs live validation. Historical changelogs describe older versions, not current guarantees.

### Python launcher prerequisites
`start.py --check` validates Python and websockets without launching anything. Install missing dependencies explicitly with `python -m pip install "websockets>=13,<16"` (use a virtual environment if your system requires it). Unlike the old batch launcher, it does not install Python, run pip during startup, or restart after crashes. A `.py` file cannot bootstrap a missing Python installation. On Windows it requests a separate communication window; on other systems the viewer shares the terminal unless you open it separately.

### Claude: what is actually tested
Claude has a dedicated adapter and manifest entry. Local fixture tests are not proof of compatibility with your live account, rollout or browser. Reload the extension **and refresh existing Claude tabs** after updating. The toolbar needs an available chat composer; login, billing and error pages are not chat support. If it is missing, inspect extension errors and the tab console instead of assuming the bridge is connected.

## Shared tab controls (all provider adapters)
The popup now includes **Active chat tab** status, **Restore toolbar**, and **Stop this tab**. Status distinguishes an available composer, an attached toolbar, its detected visibility, the local loop, model-generation detection, and team membership. It does not read/export your draft or chat text and does not claim the model understood anything. Restore reattaches the existing toolbar without refreshing the website or sending a prompt. If no content script responds, reload the extension and refresh the supported chat tab. Local stop does not undo running bridge operations or stop other team tabs; use **Stop team** for the team. Visibility is DOM/layout detection, not a guarantee against overlap or clipping by website CSS.

## Launcher troubleshooting and role colors
In the launcher folder, run `py -3 start.py --check` to see dependency errors. If websockets is missing, run `py -3 start.py --install-deps` once (requires network access), then `py -3 start.py`. This creates a local `.venv`; it does not install packages into system Python. The launcher reuses that environment on subsequent runs. Python itself must already be installed.

Startup failures are saved to `logs/start.log`; bridge errors are in `logs/bridge_debug.log`. On Windows an interactive failure waits for Enter rather than immediately closing; a pythonw launch requests a console. These desktop behaviors still need live Windows verification.

Team events use `(Planner):[Claude]:`-style labels, with the actual sender name and role: **planner blue**, **coder red**, **checker green**. Role colors require an ANSI-capable terminal; redirects and `NO_COLOR` use plain text. Role names remain visible without color. No synthetic AI messages are added.

The Claude toolbar now occupies its own sibling slot above the composer, not a child row inside its form. It wraps controls on narrow widths. A horizontal no-wrap host layout uses the shared floating fallback rather than changing Claude's layout. Mock DOM tests verify placement/remounting, not pixel-perfect behavior on the current live website.

## Relay and console reliability controls
- If a required planner/coder/checker misses its heartbeat for more than the bridge lease (45 seconds), the team run stops and pending mailboxes are cleared. Remaining tabs are told why. Rejoin the missing tab and explicitly restart; stale readiness is not revived automatically. Browser throttling can cause this safety stop.
- Large inboxes are submitted in bounded, whole-message chunks. Only messages included in the submitted chunk are acknowledged. A message too large for a provider's safe send budget pauses delivery instead of silently truncating it.
- Filter the console with `python team_console.py --team studio --role coder --kind message --tail 20`. `--tail` limits the first matching history batch and then follows new events via 0 ms Condition long-poll (`?wait=1`); `--once` exits after a fetch; `--status` prints a one-shot team roster summary; `--json` outputs NDJSON. Use `--no-color` for plain text. Filtering affects only the viewer, never delivery.
- The popup reports foreground/background state and whether a draft is present (not its content). Tab-control requests have a bounded wait and are never automatically retried after a timeout.
- On POSIX, terminating the Python launcher now requests owned-child cleanup; the bridge also handles SIGTERM through its shutdown path. This does not undo completed Studio mutations or guarantee cleanup after forced process termination.
