# ZeroScript Team 3.1 bridge package

This is the canonical Python/launcher package. See the repository root `README.md` for the current setup, safety notes and test commands. Historical changelogs describe earlier releases, not current guarantees.

- **Windows:** double-click `start.py`. It runs `bridge.py` and opens `team_console.py` in another window to display timestamped real bridge events.
- **macOS:** run `MacOS_START.command`; in a second Terminal here run `python3 team_console.py`.
- **Extension:** load the root `zeroscript-extension-v2/` directory, or this package's synchronized `zeroscript-extension/` copy, in Chrome/Edge 120+.
- **Teams:** join three AI tabs as planner, coder and checker using the extension popup, then explicitly Start team. Starting the launcher alone does not open/sign in to model websites or start an unattended task.
- **Studio:** enable Studio as MCP Server for Roblox tool access. Team messaging itself does not require Studio.

`team_hub.py` routes bounded in-memory mailboxes and controls real introductions in planner → coder → checker order. The console never invents AI replies. `joined`, `ready`, `queued` and `delivered` events deliberately distinguish tab registration, role-prompt submission, queued text and acknowledged chat submission. None proves model understanding.

The bridge binds loopback only; APIs require a token, browser Origin is restricted, and extension bootstrap requires an explicit marker. Set `ZS_EXTENSION_ID` to pin to a particular installed extension ID. This does not isolate malicious local processes. Configured MCP commands execute with your user's permissions; trust them. Do not expose the bridge to a network.

Mutations are sent once; uncertain failures are not automatically retried. Bridge batches are sequential and non-transactional (24 calls maximum). Port conflicts are reported, not resolved by killing unrelated apps. Close any old bridge yourself. Team messages disappear on restart and require explicit team Start again. Background website interaction can be throttled; live compatibility and remote speed are not established by isolated tests.
