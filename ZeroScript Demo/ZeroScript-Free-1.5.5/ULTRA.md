# Transport notes — superseded by ZeroScript Team 3.1

The older ULTRA performance/transport claims are not current guarantees. In 3.1:

- A single extension service worker already serves all tabs; no BroadcastChannel leader election is needed.
- Studio calls use WebSocket **or** HTTP, never duplicate hedged execution. There is no automatic replay of an ambiguous mutation.
- Bridge batches accept at most 24 calls, execute sequentially, preserve results and do not roll back previous mutations.
- The extension does not implement WebTransport, binary-msgpack negotiation or a long-poll fallback chain. Legacy bridge SSE/long-poll routes remain bounded and authenticated but are not the extension's active transport strategy.
- HTTP/WS require authentication. Extension bootstrap uses a restricted browser Origin plus an explicit marker; Origin-less local clients are still a documented trust boundary. Pin `ZS_EXTENSION_ID` for a specific extension origin.
- Optional accelerators are not installed on startup. No unmeasured percentage speedup, zero-disconnection guarantee or zero-hallucination guarantee is claimed.
- Team startup submits shorter role prompts concurrently and does not wait for Roblox MCP discovery. This reduces local startup work, not the websites' model latency.

See root `README.md` and `docs/REPAIR_NOTES.md` for current implementation, tests and limits.
