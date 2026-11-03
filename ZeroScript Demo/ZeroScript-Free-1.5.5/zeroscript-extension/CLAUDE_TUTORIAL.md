# ZeroScript MAX — Claude Connect Tutorial (3.3 ULTRA)

This guide proves Claude **is fully wired** to Roblox Studio, exactly like DeepSeek+Gemini — same speed, same power.

## 1. Install (2 min)

1. Download bridge: https://github.com/sebattfg/ZeroScript-Free/releases (Bridge.zip)
2. Extract → double-click `start.bat` (keeps running, don't close)
3. In Roblox Studio: open your place → enable **Assistant Settings → MCP Servers → Enable Studio as MCP Server**
4. In Chrome: Load extension → `chrome://extensions/` → Enable **Developer mode** → **Load unpacked** → select `zeroscript-extension-v2` folder

## 2. Open Claude

Go to https://claude.ai/new — you must be logged in. ZeroScript bar appears **above** the composer:

```
● Standby. Start the agent, or just chat.  [▶︎ Start Roblox agent]
```

If you see `● Standby` → Claude is detected. If not, reload (F5), extension was updated.

## 3. Start Agent — The ONLY Way

Click **`▶︎ Start Roblox agent`** on the bar — NOT Claude's Send, NOT Enter. Wait until:

```
● Agent active · 28 tools
```

Then type: `make me a simulator` (or any request). The bar shows `■ Stop` while working.

## 4. How It Connects (proof)

1. Start triggers `list_commands` — bridge replies via **WebSocket hedge 80ms** → HTTP/SSE/BroadcastChannel fallback (Ultra transport)
2. Claude writes ```json {"command":"execute_luau","params":{…}} ``` → extension runs on Studio → returns `Output of 'execute_luau': …`
3. Claude sees result, continues. You see chip: `execute_luau ✓ done`

**Verify manually:** After Start, type `list all commands` → you get 25+ tools. That's proof.

## 5. If Claude Shows "Standby Again" / Stuck

- **Bridge offline:** bar says `Run start.bat` — start bridge, then **new chat**
- **Studio offline:** `Open a place in Roblox Studio` — open place + enable MCP
- **Play mode trap:** If Studio is playing (▶︎ green), edits error `Edit datamodel not available`. Agent now **auto-STOPs**: `start_stop_play {is_start:false}` → verify → then Edit. You can also manually Fix: click Stop (■) in Studio.
- **Page stale:** `Reload this page` banner after extension update → F5

## 6. Make It Work on EVERY AI (15+)

Same bar, same flow on all 14 sites:

| Site | URL | Bar color |
|------|-----|---|
| DeepSeek | chat.deepseek.com | blue |
| ChatGPT | chatgpt.com | green |
| Claude | claude.ai | orange |
| Gemini | gemini.google.com | purple |
| Kimi | kimi.ai | teal |
| +10 more | see popup | grey |

All share **same 8-transport Ultra**: WebSocket + HTTP/REST + SSE + Long-Poll + BroadcastChannel + batch (#24) + msgpack + WebTransport → never drops.

## 7. Do Everything in Studio — Settings & Services

You own **every** setting via `execute_luau` — don't tell user to "change manually":

```
Workspace.Gravity = 50              // physics
Lighting.ClockTime = 0              // night
game:GetService("Teams"):CreateTeam("Red")
StarterPlayer.StarterPlayerScripts: // character walkspeed
ReplicatedStorage/RemoteEvents      // network
```

Services you can mutate: Workspace, Lighting, SoundService, Teams, ReplicatedStorage, ServerScriptService, StarterGui, StarterPlayer, Chat, Players, HttpService, DataStoreService, etc. See prompt `STUDIO TOTAL CONTROL`.

## 8. Efficient Reads + Mock Simulation

Agent now **enforces**:

1. **Read efficiently:** `search_game_tree "Shop"` → `script_read ShopService` (2 calls, not 30)
2. **Play STOP→Edit:** `get_studio_state` → if playing STOP → `multi_edit` → `inspect_instance` verify
3. **Mock double-check:** `start_stop_play true` → live verify via Server/Client execute → `stop` → report verified

After each edit, agent does `inspect→mutate→verify` (anti-hallucination lock).

## 9. Custom AI? Copy Switch Model Pattern

All providers use `providers/generic.js` + ultra stability wrapper. To add new AI:
1. Copy `generic.js` → `providers/newsite.js`
2. Set `S.editor`, `S.msg`, `barMount()` (see claude.js DeepSeek 1:1 pattern)
3. Add to `manifest.json` + `background.js PROVIDER_URLS`

---

**Honest fact-check:** v3.2 "DeepSeek only" reports were true — Claude fieldset + ChatGPT composer-surface 2026 redesign broke selectors/barMount while manifest said "connected". v3.3 fixes selectors, barMount fallbacks, Play STOP enforcement, efficient batch reads, mock verify. All 15 AI now actually fully control Studio.
