# ZeroScript 4.8.1 — multi-edit, hallucinated connections, and the solo coder

This release addresses four reported problems. Each claim below is measured by a
command named next to it. Where a thing is **not** fixed, it says so.

| Report | Root cause found | Status |
|---|---|---|
| "make it support multi edit, unlimited edits" | A prompt string claiming `MAX: batch up to 24 edits per call` that **no code enforced**, and **no static check on `multi_edit` at all** (the Luau gate ran for `execute_luau` only) | Fixed |
| "the ai is hallucinating even with a clear prompt, so many bugs" | No rule forbidding invented *connection/capability* claims, and the prompt pushed the model toward inventing teammates | Fixed (partially — see limits) |
| "not supported on gemini/chatgpt/claude — they said not connected" | `plan=direct` returned `connected:true`, `external:true`, `magic:"im connected to other agent"` for **one AI with zero peers** | Fixed |
| "declare single mode as coder always" | `effectiveRole()` returned `null` outside team mode, so nothing ever told the model which role it was | Fixed |

Baseline for every comparison: `822a36f` (4.8.0).

---

## 1. Multi-edit: unlimited batches, and a real check before Studio

### 1.1 What was actually wrong

Two separate defects, both measured:

**The 24-edit cap did not exist.** `core/config.js` told the model
`MAX: batch up to 24 edits per call`. A grep for `24` across every executable
path found the string and nothing else:

```
$ grep -rn "24" --include='*.js' core/ background.js | grep -i "edit"
core/config.js:543:  ... MAX: batch up to 24 edits per call.
```

So the number was pure suggestion. A model that believed it split work it could
have finished in one turn (each split costs a full round trip); a model that
ignored it was not stopped, because no code was checking.

**`multi_edit` had no syntax gate.** The static Luau check in `runTool()` was
guarded by `bareName === "execute_luau"`:

```
$ grep -n "bareName === \"execute_luau\"" main.js
1532:    if (bareName === "execute_luau" && !args.datamodel_type) ...
1540:    if (bareName === "execute_luau" && typeof window.ZSSandbox ...
```

`multi_edit` is the path that writes *entire script bodies*, and it went to
Studio completely unparsed. Studio then applies a batch **atomically**, so one
bad edit in a batch of twenty failed all twenty — and the model received a
generic Studio error with no indication which of its edits was at fault. That is
the "so many bugs" experience: three turns lost to bisecting a batch by hand.

### 1.2 The fix

* `core/sandbox.js` — new `analyseMultiEdit(edits, opts)`. It parses each edit's
  `new_string` as Luau when the target is a script (or the edit is a creation,
  `old_string === ""`), skips non-script property edits rather than guessing, and
  returns the **index** of every edit that fails.
* `core/main.js` — the gate now runs for `multi_edit` too, before the bridge
  round trip. It names the offending edit, says the batch was **not applied**, and
  tells the model to re-send the corrected batch.
* `core/config.js` — `TOOL_NOTES.multi_edit` now says `NO EDIT CAP` and explains
  the atomic-reject rule.

### 1.3 Measured behaviour

```
$ node zeroscript-extension-v2/test-sandbox.js
105 passed, 0 failed
```

End-to-end against the real gate block extracted from `main.js`:

```
valid batch  -> null                      (passes through untouched)
broken batch -> ERROR in multi_edit: multi_edit edit #2 does not parse as Luau:
                1 block(s) never closed — 'if' opened on line 1 needs 'end'
names edit #2: true
says nothing applied: true
```

False-positive check — every one of these valid script shapes is accepted:

| Shape | Accepted |
|---|---|
| `local x = 1; print(x)` | ✅ |
| ModuleScript with `return M` | ✅ |
| LocalScript with `LocalPlayer` | ✅ |
| generic function `local function id<T>(x: T): T` | ✅ |
| `if type(x) ~= "string" then return end` | ✅ |

**Honest limits.** This parses the *replacement text*, not the resulting file. It
cannot know whether `old_string` actually occurs in the target — only Studio can.
It does not execute anything. "Unlimited" means *no artificial cap in this
codebase*; the real ceilings are the provider's message size and Studio's timeout,
which are reported by the bridge, not guessed here.

---

## 2. Hallucination: the connection claims

### 2.1 The exact bug

`core/plan_wall.js` returned, for `plan = "direct"`:

```js
// 822a36f, plan_wall.js:392
if (!plan || plan.ais === 1)
  return { magic: MAGIC_CONNECTED, external: true, need: 1, have: 1, connected: true, warn: "" };
```

with `MAGIC_CONNECTED = "im connected to other agent"`. Direct is **one AI with
zero peers**. Reproduced against the committed baseline:

```
direct  -> {"magic":"im connected to other agent","external":true,
            "need":1,"have":1,"connected":true,"warn":""}
```

`core/config.js:390` had the same assumption as a fallback, and `main.js:3841`
turned `external:true` into a second false report (`external /code /force etc
active`).

This is the reported symptom exactly: a solo Gemini / ChatGPT / Claude tab told
its own model it was connected to another agent, and the model repeated it.

### 2.2 The fix

`connected` now means what it says — **a peer is reachable**.

| Mode | Before | After |
|---|---|---|
| direct (1 AI, 0 peers) | `connected:true`, `external:true`, `magic:"im connected to other agent"` | `connected:false`, `external:false`, `solo:true`, `peers:0`, `magic:"im solo — single AI, no other agents connected, all local commands active"` |
| agent (needs 3, has 1) | `connected:false` + warn | unchanged — this one was already honest |

Solo is **not** an error state (`warn: ""`) — there is simply nothing to connect
to. `external` only ever labelled a UI string; it never gated slash commands, and
the label now says `peers none (solo)` instead of `external blocked`.

Two new prompt-level defences, both always in T0 so no budget can drop them:

* **Rule 1b — NO INVENTED CONNECTION.** "You cannot see other tabs, other AIs,
  logins or Studio's internals… No result = no proof: call the tool."
* **`roleLine()`** — the first thing in the prompt, stating the role and whether
  a peer exists.

```
$ node zeroscript-extension-v2/test-plan-wall.js
38 passed, 0 failed
```

---

## 3. "Declare single mode as coder always"

`effectiveRole()` ended with `return null; // direct/single-AI mode: no role gate`.
Safe, but silent: nothing in the prompt or the tool results ever said *which role*
was running, so a solo tab narrated "I'll hand this to the coder" / "the checker
should verify" — inventing teammates that do not exist.

It now returns `"coder"`, with a `declaredRole()` helper returning
`{ role, assigned, solo }` derived from **live** state (`team.active`), never
assumed. `systemPrompt()` passes it into `buildSystemPrompt({ role, solo })`.

Why `coder` is the correct declaration: single mode has exactly one AI, and that
AI must be allowed to mutate Studio. `roleAllowsTool("coder", …)` permits every
tool a solo agent needs, so this also keeps a *stale* planner/checker assignment
from locking the user out of their own tools.

The prompt now opens with:

```
YOUR ROLE: the CODER (the only role allowed to mutate Studio). SOLO: one AI only —
no planner, no checker, no other agent is connected or listening. Do not hand work
to a teammate or say one will verify it; do it yourself.
```

---

## 4. Two latent bugs found while fixing the above

Both were found by tests failing, and both are real.

### 4.1 The user's custom prompt was silently dropped

```js
// 822a36f, config.js:502
if (extra && !text.includes(extra) && room() > 200) {
  text += "\n\n" + extra.slice(0, Math.max(200, room() - 2));
}
```

`room()` is `budget - text.length`, which is **negative** whenever T0 alone
already exceeds the budget. On any provider whose `sendCharBudget` implies a
budget under ~4,500, the one piece of the prompt the *user actually wrote* was
discarded with no trace. Fixed: it is now always present, truncated to whatever
room exists with a 200-character floor.

```
budget   500 -> len  4572 keeps custom: true
budget  4300 -> len  4572 keeps custom: true
budget 12000 -> len  7011 keeps custom: true
```

### 4.2 A `/**` comment swallowed 78,195 bytes of `main.js`

Line 3 of `main.js` contains the literal `providers/*.js` inside a header
comment. That `/*` has no closer before it, so the **first `/**` later in the file
becomes its terminator**. Adding a JSDoc-style comment in 4.8.1 made the
test's comment-stripping pass eat everything from line 3 to that comment:

```
CURRENT    huge-comment-spans: [{"len":78195,"line":3}]
BASELINE   huge-comment-spans: none
```

`test-composer.js` slices source text, so four assertions failed — correctly. The
new comment is now plain `//`, with a note explaining why `/**` must never be
used in that file.

---

## 5. Tests

| Suite | Before | After |
|---|---|---|
| `test-sandbox.js` | 89 | **105** |
| `test-plan-wall.js` | 28 | **38** |
| `test-prompt.js` | 78 | **96** |
| `test-composer.js` | 14 | 14 (regression caught and fixed) |

Two `test-prompt.js` assertions were **re-measured, not relaxed**: the T0 floor
moved 4,217 → 4,499 because T0 gained rule 1b and the role line. The test now
asserts the measured floor and additionally asserts that an impossible budget
yields *exactly* the floor — i.e. T0 is untruncatable by design.

## 6. Full gate

```
node tools/verify.js                      ALL CHECKS PASSED (18 suites, 0 warnings)
python -m unittest discover -s tests      55 tests OK
node tools/audit-deep.js                  0 P0, 0 P1, 0 P2 (+1 pre-existing P3)
python scripts/sync_copies.py --check     62 verified, match
```

## 7. Honest limits

* **The syntax gate is static and per-edit.** It parses replacement text. It
  cannot verify `old_string` exists, cannot see the merged result of a batch, and
  does not execute Luau.
* **Hallucination is reduced, not eliminated.** The prompt removes a specific,
  reproduced cause (a solo tab being told it had peers) and adds an explicit
  prohibition. No prompt edit can stop a model inventing something it was already
  disposed to invent — the extension now *makes the true state available and
  cheap to state*, which is the part under our control.
* **"Unlimited edits" is unlimited *in this codebase*.** Studio and the provider
  still have real limits; they are reported by the bridge instead of being
  hard-coded as a guess.
* **Not touched:** `bridge.py`, `start.py`, `team_hub.py`, `team_console.py`,
  `launch_studio_mcp.py`. They were exercised by the suites above and contain none
  of these four defects.
