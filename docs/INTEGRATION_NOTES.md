# Integration with main — 4.5.0

Main (`c4ff464`) and the session's original base had unrelated Git histories. The integration commit joins those histories on the existing PR branch; it does not replace main with the older implementation.

## Retained from main
- Module-scoped execution/session state, Single/Continuous/Loop modes and budgets.
- Slash-command prompt enhancer, static Luau analyser, memory wall, plan wall, peer wall and role assignment UI.
- Peer routing/acknowledgements, provider-tab discovery/wake, temporary agent hub and fault reporting.
- Safe-error instrumentation, provider improvements, audit tools, license, existing feature tests and verification workflow.
- Composer stays user-accessible: team startup does not reintroduce input locking or opaque covers.

## Added/reconciled
- Authenticated bridge teams, concurrent role-prompt submission, ordered real introductions, bounded mailboxes and timestamped console.
- Python launcher with dependency checks and owned-child cleanup; batch launcher intentionally replaced.
- Shared active-tab status, toolbar restore and local stop controls. Existing popup fault display retained.
- Mutation transport uses one attempt, not WS/HTTP hedging. Read/tool parser and submission-evidence fixes retained.
- Python temporary-agent HTTP routes preserved alongside team routes. WebSocket authentication accepts the existing header token and the extension's query token.
- Connection-owned async tool tasks are cancelled and removed on disconnect; cancellation cannot undo an operation already running in an MCP child/thread.
- Both existing and added test suites are part of npm test. Python lifecycle tests use temporary data and an ephemeral WS port.
- CI's Python 3.9 matrix pins Ubuntu 22.04: the previous setup failure was Python 3.9 not available for Ubuntu 26.04, not an application test failure.

## Deliberate boundaries
Normal Start retains the legacy wall workflow. Joined bridge tabs use Start team instead. During an active bridge team, legacy peer-context injection and execution-mode role rotation are bypassed, without overwriting saved normal-mode settings. The Team Console only shows bridge-team events, not legacy peer-wall messages.

The main bridge symlink is represented by synchronized Python compatibility copies for Windows portability. The nested extension compatibility copy is synchronized, but install only the canonical zeroscript-extension-v2 folder. Historical tracked runtime logs have been removed from version control; generated logs and tokens stay ignored.

## Validation and limits
Local validation passed the existing verifier, its feature tests including the 13 Python bridge-lifecycle assertions, the added Python suite (28 tests), JavaScript regression suite (19 checks), manifest-ordered provider startup/control simulations, Claude/team DOM and popup simulations. Tests also exercise retained legacy peer routing, role mappings and temporary-agent storage through the integrated background worker/HTTP bridge.

One verifier warning remains: core/transport.js is not loaded by the main manifest. It is retained as compatibility code for the session's regression tests; live transport is owned by background.js. Static checks also report advisory findings; passing verification is not proof of absence of bugs. No live AI-account, Windows desktop, Roblox Studio or performance certification is claimed.
