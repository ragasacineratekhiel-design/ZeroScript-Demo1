# ZeroScript Team 3.1 extension

Load this directory unpacked in Chrome/Edge 120+. Reload the extension **and refresh AI tabs** after an update. Root `zeroscript-extension-v2/` is canonical; the nested `zeroscript-extension/` is a checked compatibility copy of the same version.

For the bridge, run `ZeroScript Demo/ZeroScript-Free-1.5.5/start.py` on Windows. It opens a separate timestamped **Team Console**. On macOS use `MacOS_START.command` and run `python3 team_console.py` in a second Terminal.

## Three-agent team

1. Open three signed-in AI chats. In the popup on each, enter the same team name, choose planner/coder/checker and **Join active AI tab**.
2. Click **Start all three team tabs**. Role prompts are submitted concurrently. Actual introductions are authorized planner → coder → checker by the bridge.
3. Give the planner your task. The agents use `team_send`, `team_read` and `team_status` through the bridge, not through Studio scripts or direct website-to-website communication.
4. Check real messages and acknowledged delivery in the console. Stop the team before changing roles. Bring throttled background tabs forward. Keep drafts saved: startup refuses to overwrite an existing draft.

The bridge does not call AI model APIs, fabricate greetings, guarantee model compliance, or certify the model tier selected on a website. It still needs this extension to submit prompts into each open chat. Registration is not proof of communication; only acknowledged peer delivery enables the positive communication phrase. Delivery is not proof of model understanding.

Roblox must be open with **Studio as MCP Server** enabled for Studio work, but is not required for team-only messaging. Team startup skips the expensive Studio catalogue/bootstrap exchange. No measured live-site speedup is claimed.

Transport: authenticated loopback WebSocket or HTTP; mutation requests are never hedged or automatically replayed. Batches are sequential, at most 24 calls, not transactions. Unknown Studio health is not shown as verified ready. Generic website adapters fail closed when author roles cannot be identified and may require updated selectors.

Team mailboxes/event history are bounded and in memory, not durable across bridge restarts. Ambiguous submission/acknowledgement requires manual recovery. Team mode opts into background submission and tool execution; browser throttling can still delay it. Closing/navigating a joined tab stops the team. Stopping does not undo already-running Studio operations.

See the repository's root README and `docs/REPAIR_NOTES.md` for security boundaries, full setup, tests and known limitations. `scripts/sync_copies.py --check` verifies both extension copies match.
