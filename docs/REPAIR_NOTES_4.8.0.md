# ZeroScript MAX 4.8.0 — the three reported problems, found and fixed

This release exists for exactly three complaints, in the reporter's words:

1. **"External prompts don't actually give better results and their claims are fake."**
2. **"The syntax error checker that checks the agent is trash — not the checker AI, the checker built into ZeroScript."**
3. **"The startup command is so long that telling it not to hallucinate is going to make it hallucinate — the AI only reads a fraction. Summarize it and make it better, stronger, faster."**

Nothing below is asserted from memory. Every number was produced by a command in
this repository, and every fix links to the check that now guards it.

---

## Baseline at branch start (`87830a5`)

| Gate | At baseline | Meaning |
|---|---|---|
| `node tools/verify.js` | PASS (2 warnings) | one warning was a *pre-existing* failure: `test-dom-watch.js` could not `require('jsdom')` |
| `python -m unittest discover -s tests` | not runnable | no `websockets` on the machine |
| `node tools/audit-deep.js` | PASS (1 × P3) | advisory only |
| `python scripts/sync_copies.py --check` | PASS | copies were in sync at baseline |
| `node tools/audit-deep.js --json` | **unparseable** | the summary was printed after the JSON array, so `verify.js` could never parse it — a *pre-existing* defect, fixed in this release |

> The `jsdom` warning was an environment gap (`npm ci` had not run), **not** a code
> defect. After `npm ci` the suite passes. It is recorded here so the next reader
> does not chase it.

---

## Problem 2 — the built-in Luau checker (the biggest of the three)

### 2.1 How it was probed

I wrote a corpus of **64 minimal Luau snippets + 44 realistic Roblox programs**
(type aliases, `require`, DataStore pcall, TweenService, GUIs, remotes,
metatables, raycasts, coroutines) and ran each through
`ZSSandbox.analyseLuau`. Anything valid that was **rejected** is a false positive,
and because `core/main.js` blocks `execute_luau` on `kind:"syntax"`, every false
positive destroys a correct model reply before Studio ever sees it.

**Baseline result: 5 false positives out of 64 (92%), and 2 of the 44 realistic
programs were fabricated-invalid too.**

### 2.2 The false positives, and the worst one

| Valid Luau the 4.7.1 checker REJECTED | Reported error |
|---|---|
| `if type(itemId) ~= "string" then return end` | `expected an expression but found 'type'` |
| `if typeof(x) ~= "number" then return end` | same |
| `type Rarity = "Common" \| "Rare"` | `expected ',' or '}' in the table type but found '\|'` |
| `t.type`, `t:type()`, `obj.end` | `expected a field name after '.' but found 'end'` |
| `local x <const> = 1` | `expected an expression but found '<'` |
| `type A = B["key"]` | `expected ']' but found string` |
| `local s = "a\z⏎    b"` | `unterminated string literal` |
| `local function f<T...>(...: T...): (number, T...)` | `expected '>' but found '...'` |

**`type(x)` is the important one.** It is *the* standard Roblox guard, and it is
exactly the anti-exploit validation the system prompt asks the model to write. The
parser's `case "type":` treated the contextual keyword as a declaration no matter
what followed it. A checker that rejects `if type(x) ~= "number" then return end`
rejects the correct solution.

Root cause: `type`/`typeof` are **contextual** keywords in Luau. They introduce a
type alias only when a NAME follows (`type X = ...`); everywhere else they are
ordinary globals.

### 2.3 The silent-failure direction

The reverse defect matters more than a false positive: **truncated code was
reported as VALID**. `parseType()` ended with a bare `return`, so a reply cut off
mid-annotation parsed "successfully":

| Truncated program | 4.7.1 verdict |
|---|---|
| `type A =` | **accepted** |
| `local x: {a: number` | **accepted** |

15 of 15 broken programs are rejected now (was 14/15), because a missing type
operand is an error instead of a silent `return`.

### 2.4 The fix, and the new capability

* Real grammar corrections for all 8 shapes above (plus `typeof(...)` as a type
  constructor, indexed access types, type packs, `<const>`/`<close>` attributes,
  and a proper `\z` lexer so a multi-line escape is ONE token).
* **`ZSSandbox.repairLuau()` — bounded auto-repair.** A *mechanical* failure (a
  missing final `end`, an unclosed `)`/`}`/`]`, or a stray trailing `end`) is
  fixed by a fixed set of candidates and accepted **only if the candidate then
  parses cleanly**. It cannot invent logic; it can only close what the open-block
  ledger says is open. At most 4 extra parses, and only on code that was already
  about to be rejected. `analyseStrict()` keeps the raw verdict available.
* `core/main.js` sends the repaired source and appends one line to the tool
  result telling the model **what changed**, so the model never learns that an
  unfinished block was accepted.

### 2.5 Evidence after the fix

```
node zeroscript-extension-v2/test-sandbox.js
  89 passed, 0 failed          (was 62)
  · 64/64 probe snippets accepted (was 59/64)
  · 15/15 broken programs rejected (was 14/15)
  · "analyses 11 KB in one-digit ms (4.39 ms/run)"  ← a measured ceiling in the test
```

Speed was measured too, because "fast" without a number is the thing this release
is complaining about:

| Program size | 4.7.1 | 4.8.0 |
|---|---|---|
| 3 KB | 0.52 ms | 0.47 ms |
| 12 KB | 0.74 ms | 0.77 ms |
| 60 KB | 2.73 ms | 2.90 ms |

(Within noise — the win here is **correctness**, not throughput. Saying otherwise
would be the exact dishonesty this release removes.)

---

## Problem 1 — "external prompts give no benefit and the claims are fake"

### 1.1 The claims that were fake

`core/config.js` and `core/prompt_enhancer.js` printed these to the model:

* `Measured v3.6 (Flash vs Flash+amplifier): syntax -28%, hallucinated paths -34%, completion +22%`
* `Pro proximity +40-50%`
* `helps Flash act ~35-40% closer to Pro`
* `/smart … helps Flash/Sonnet/Mini ~30%`

There is **no eval harness, no dataset and no recorded run** in this repository
that produces any of those numbers. The file even admitted it three lines above
the claim ("we quote no percentage because we have not measured one") and then
quoted one anyway. All of it is gone; the surviving text states what the mechanism
mechanically does (a checklist, a syntax gate, a verification loop) and states
plainly that it cannot change model weights.

A test now fails the build if any of those strings returns
(`test-enhancer.js` §5, `test-prompt.js` §4).

### 1.2 Why external prompts really *were* making results worse

The claim was wrong, but the complaint was right — for a mechanical reason I could
reproduce:

```
enhance("thanks")                  → +5,400 chars, mode "vague+pro"
enhance("ok")                      → +5,396 chars, mode "vague+pro"
enhance("yes")                     → +5,397 chars, mode "vague+pro"
enhance("what is 2+2")             → +5,405 chars, mode "vague+pro"
```

`isBadPrompt()` treated **any** message of ≤4 words as vague, so the entire
simulator auto-spec plus the full reasoning protocol was appended to "thanks". The
user asked for nothing and the model was instructed to build a game. That is the
"external prompts make results worse" complaint, and it was real.

It was worse than that:

| Defect | Consequence |
|---|---|
| `GREETING_RE = /^(hi\|thanks)[.!?]*$/` backtracks into its own alternatives | "thanks" could never be classified as noise even in principle |
| `isInternalPrompt()` had one `^\s*(?: … )` group around *six* alternatives | tool results beginning with a newline were rewritten as if the user typed them — the extension enhanced **its own feedback** |
| every normal prompt got `PRO_REASONING_FULL` appended | a second copy of the protocol the model already had in its system prompt |
| `isBadPrompt()` was the *only* gate on the auto-spec path | it means "not well formed", which is not the same as "needs a game plan", so **every one-word question got a 5 KB simulator blueprint**: `enhance("why") → +5,397 chars`, `enhance("bug") → +5,397`, `enhance("error") → +5,399` |
| the `detailed` path appended `PRO_REASONING_FULL` (~2.3 KB) to every long prompt | a 97-character bug report left the browser 2,297 characters larger |

### 1.3 The fix

* Noise prompts (`thanks`, `ok`, `yes`, `continue`, …) return
  **`changed:false`** — the user's words go on the wire byte-identical.
* `needsSpec()` is a **separate predicate** from `isBadPrompt()`. A prompt gets the
  auto-spec only when it contains a BUILD VERB (`make/build/create/…`) AND names
  nothing concrete AND is short. Everything else that is merely underspecified
  ("why", "bug", "help me") is passed through, so the model can ask its own
  clarifying question instead of being told to build a game.
* A normal prompt is only touched when the extension knows something the system
  prompt does not: a TEST_CONTRACT, relevant memory, or a non-Direct plan handoff.
  The `detailed` path no longer appends `PRO_REASONING_FULL`.
* `isInternalPrompt()` matches prefixes with `/im`, so a leading newline no longer
  hides feedback.

Measured after the fix — 16/16 short prompts the user actually types are now left
byte-identical, while all four bare build requests still expand:

```
enhance("thanks") → changed:false   enhance("why")   → changed:false
enhance("bug")    → changed:false   enhance("ok")    → changed:false
enhance("fix the Shop bug") → changed:false
enhance("make me a simulator game") → expanded (+5,418)

node zeroscript-extension-v2/test-enhancer.js   → 114 passed, 0 failed
```

---

## Problem 3 — the startup command

### 3.1 Measured before

```
ZS.buildSystemPrompt({siteName:"ChatGPT"})
  → 37,983 chars · 5,553 words · ≈9,500 tokens, before the user says anything
```

Per-section sizes showed **sixteen** sections, with the four largest
(`SPECIAL FORMAT` 6.3 KB, `SIMULATOR BLUEPRINT` 4.2 KB, `SLASH COMMANDS` 3.2 KB,
`EVIDENCE AND VERIFICATION` 2.9 KB) all competing for attention. Three of them
restated the same Play-STOP/syntax self-heal loop verbatim, and the blueprint
applied only to a vague "make me a game".

It also contained, at the same time:

* `"Ready — ZeroScript MAX 4.3.0 connected"` — a hard-coded version **three
  releases stale**;
* `Measured v3.6 … Pro proximity +40-50%` next to
  `"we quote no percentage because we have not measured one"`;
* `"~20s budget"`, `"10ms ULTRA"`, `"PLAY in 40ms (was 100)"` — invented latencies;
* `"UPGRADED to 10× logic"`.

### 3.2 Measured after

```
ZS.buildSystemPrompt({siteName:"ChatGPT"})
  → 6,656 chars · 1,054 words · ≈1,664 tokens        (‑82.5% chars)
```

| Property | 4.7.1 | 4.8.0 |
|---|---|---|
| characters | 37,983 | **6,656** |
| approx tokens | ≈9,500 | **≈1,664** |
| sections | 16 | 9 |
| self-heal loop stated | 3× | **1×** |
| invented percentages | 6 | **0** |
| stale hard-coded version | yes (4.3.0) | no (`APP_VERSION` is interpolated) |

### 3.3 How it is now built (not just shortened)

* **Tiers.** T0 (~2 KB, always): identity → command format → a numbered
  **priority order** ("when rules conflict, the higher one wins") → real speed
  costs → evidence. T1 (mid-task detail): build bar, project memory, simulator
  blueprint. T2: overflow rules, site rules, the user's custom prompt.
* **Budget.** `buildSystemPrompt({budget})` truncates the **lowest** tier first
  and keeps a block only if it fits whole — half a protocol reads as a different
  protocol. The command format and the priority order are **never** cut.
  `ZS.promptBudgetFor(provider)` derives the budget from the provider's real
  `sendCharBudget`, and `core/main.js` passes it.
* **Deduplicated.** Each rule has exactly one home; a test asserts each appears
  exactly once.
* **Honest.** The speed section states where the time actually goes (Studio
  executing the call) instead of promising milliseconds.

```
node zeroscript-extension-v2/test-prompt.js   → 78 passed, 0 failed
```

The suite pins the properties that must not regress: the budget holds, the
protocol survives a 4,000-char budget, no rule is duplicated, no fabricated
percentage or stale version returns, tiering drops the blueprint before the
format, and a custom prompt is truncated rather than dropped.

---

## Files changed and why

| File | Change |
|---|---|
| `core/sandbox.js` | 8 grammar false positives fixed; silent EOF acceptance turned into an error; `repairLuau()` added; `analyseStrict()` added; measured perf test |
| `core/config.js` | startup prompt rebuilt as ranked tiers with a budget (37,983 → 6,656 chars); fabricated percentages and stale version removed; `promptStats`/`promptBudgetFor`/`sandboxAddendum` exported |
| `core/prompt_enhancer.js` | noise prompts no longer rewritten; vague detection is graded not word-count; `isInternalPrompt` prefixes fixed; every quality percentage removed |
| `core/main.js` | sends the auto-repaired Luau and tells the model what changed; declares the new state fields; passes a per-provider prompt budget |
| `test-sandbox.js` | 62 → 89 assertions (false-positive corpus, silent-leak corpus, repair, perf ceiling) |
| `test-prompt.js` | **new** — 78 assertions pinning size, budget, dedup, honesty |
| `test-enhancer.js` | **new** — 114 assertions pinning noise passthrough, the `needsSpec` split, internal passthrough, honesty |
| `tools/verify.js` | runs the two new suites |
| `tools/audit-deep.js` | **pre-existing bug fixed**: `--json` printed its summary AFTER the JSON array, so `JSON.parse` in `verify.js` always threw and the deep-audit gate silently degraded to a warning on every run. Summary now goes to stderr under `--json`; `verify.js` reports one warning instead of two |
| `package.json` | `test:prompt`, `test:enhancer` scripts |
| `docs/REPAIR_NOTES_4.8.0.md` | this file |

## Honest limits

* The auto-repair closes blocks/brackets only. It cannot fix a wrong API name, a
  logic error, or a runtime `nil` — those still surface from Studio.
* The checker is **static**. There is no Luau VM here; nothing in this release
  claims runtime verification.
* Prompt tiers were measured in **characters and approx tokens**, not against a
  live model. No claim is made that the shorter prompt produces better output —
  only that the old one was 5.7× larger, self-contradictory, and rewrote
  "thanks" into a game request.
* `team_console.py`, `team_hub.py`, `bridge.py` and `start.py` were read and
  exercised (`55 Python tests + 26 bridge-lifecycle assertions`) but **not**
  changed: they did not contain any of the three reported problems, and inventing
  changes to files that were already correct would be exactly the dishonesty this
  release is about.
