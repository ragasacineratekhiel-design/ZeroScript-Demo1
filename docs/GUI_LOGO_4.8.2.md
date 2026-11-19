# ZeroScript 4.8.2 — deterministic GUI & logo generation

The report: **"make them understand image and able to make the best logo and guis
instead of using prompts — the gui they make are garbage, prompt wont do anything."**

The last clause is correct, and it is the whole reason this release is code and not
prose. Below is what was actually wrong, what was built, what it measures, and what
it still cannot do.

---

## 1. Why "prompt won't do anything" is right

The old prompt already told the model what good GUI looks like:

```
core/config.js (4.8.1), P_QUALITY:
  "scale-based GUI (UDim2.fromScale), TextScaled, mobile safe area 0.05, UICorner 8"
core/config.js (4.8.1), TOOL_NOTES.inspect_instance:
  "Use to design 10× better GUI: scale-based UDim2.fromScale(0.5,0.5), UICorner 8,
   dark glass 0.5 + purple/teal, Tween, Sound, Particles."
```

It had been there for several releases and the GUI still looked wrong. Adding more
adjectives could not fix it, because a model writing GUI by hand has three
structural problems that no prompt can touch:

| Problem | Why prose cannot fix it |
|---|---|
| **No coordinates.** It must invent every `UDim2` number. | A prompt can say "scale-based" but cannot supply the arithmetic for a layout. |
| **No feedback.** It cannot see what it drew. | Telling it to "make it look good" asks it to optimise a signal it does not receive. |
| **No consistency.** Each widget is a separate creative decision. | One section of prose cannot enforce the same corner radius on eight widgets. |

`"UICorner 8, purple/teal"` is an adjective list. It produced adjective-grade GUI:
individually plausible elements, inconsistent spacing, and no depth hierarchy.

## 2. What was built

`core/gui.js` — the layout **maths**, in code, where it is testable and
reproducible. The model's job shrinks from *invent the layout* to *choose a theme
and a list of widgets*.

Two new virtual commands (they run in the extension, not Studio):

| Command | Args | Emits |
|---|---|---|
| `generate_gui` | `theme`, `screen`, `widgets[]`, `title` | Complete Luau `ScreenGui` — 10 widget types across 5 screen presets |
| `generate_logo` | `style`, `theme`, `initials`, `size`, `glow` | Complete vector logo — 4 styles, aspect-locked |

Both are injected into the tool catalogue (`ensureTools`), so `list_commands`
advertises them with real signatures — a model cannot use a command it cannot see.

### 2.1 Themes are real palettes, and they are measured

7 themes × 6 colour roles. `contrastRatio()` implements WCAG 2.1 relative
luminance, so readability is a **measurement**, not a claim:

| Theme | text/bg | text/surface | muted/bg | accent/bg | AA 4.5:1 |
|---|---|---|---|---|---|
| neon | 18.04 | 16.33 | 7.46 | 4.49 | ✅ |
| glass | 17.61 | 13.46 | 8.63 | 8.00 | ✅ |
| sunset | 17.27 | 15.17 | 8.90 | 7.28 | ✅ |
| forest | 17.78 | 14.92 | 9.01 | 9.87 | ✅ |
| mono | 18.75 | 16.64 | 6.63 | 16.45 | ✅ |
| candy | 17.17 | 14.89 | 8.84 | 7.08 | ✅ |
| gold | 18.33 | 16.20 | 9.43 | 12.87 | ✅ |

Worst body-text contrast across every theme: **6.63:1** (AA requires 4.5:1).
If someone edits a theme into something unreadable, `test-gui.js` fails.

### 2.2 Consistency is structural, not requested

Radius, stroke and gradient are applied by **one function each** (`rounded`,
`stroked`, `gradient`), so no widget can have a one-off corner. Every geometry
assignment is `UDim2.fromScale`; `fromOffset` appears only for intentional pixel
insets (padding, anchors). This is asserted:

```
check("no widget SIZE is a fixed pixel size", offsetGeom.length === 0)
```

### 2.3 The generated GUI has real behaviour

The difference between "made by a model" and "made" is whether it responds:

* **buttons** — `TweenService` hover/press, `AutoButtonColor = false` (so the tween
  does not fight the default), `.Activated` wired to an action.
* **hud** — reads `GetAttribute("Coins")` and subscribes to
  `GetAttributeChangedSignal`, so it has a **data path** instead of text the model
  invented. `ResetOnSpawn = false` so it survives a respawn.
* **dialog** — confirm/cancel both call `closeDialog()`; the background is dimmed.
* **progress** — computes a real percentage and `math.clamp`s its input.
* **text** — every label gets a `UITextSizeConstraint` with a floor *and* a
  ceiling, so a title never becomes a wall or a dot.

## 3. Logos: vector, because images are impossible here

Roblox **cannot upload an image from Luau**. A "generate a logo" command that
produced a `.png` would be a lie. So logos are vector — Frames + `UICorner` +
`UIGradient` — which is the only approach that works end to end without a human
uploading a file:

| Style | What it is |
|---|---|
| `monogram` | gradient disc + initials + inner ring |
| `mark` | abstract ring with a counter-rotated square, slow rotation |
| `shield` | crest silhouette with a band and monogram |
| `bolt` | angular energy mark from two offset rotated bars |

Every style is wrapped in a `UIAspectRatioConstraint` with
`AspectType.FitWithinMaxSize` — the single most common hand-made logo defect is an
oval after a stretch, and this makes it structurally impossible. Asserted per style:

```
check(`logo ${style}: aspect-locked (UIAspectRatioConstraint)`)
check(`logo ${style}: no external image asset id`, !/rbxassetid/.test(src))
```

## 4. Verification

Every generated script is parsed by the **same analyser** that gates
`execute_luau`, before the model ever sees it. So "generated" and "would be
accepted by Studio" are the same statement — if the generator ever emits invalid
Luau, the command returns an error naming the extension as the culprit instead of
handing broken code to the agent:

```
$ node -e "...build every theme×screen, every widget, every logo style..."
parse checks: 73 passed, 0 failed

$ node zeroscript-extension-v2/test-gui.js
89 passed, 0 failed
```

End-to-end through the real command block extracted from `main.js`:

```
Output of 'generate_gui':
GENERATED hud screen — theme neon, 259 lines, 8513 chars, verified to parse.
Contrast (WCAG): text/bg 18.04:1, muted/bg 7.46:1.

Output of 'generate_logo':
GENERATED shield logo — theme gold, 179 lines, 5904 chars, verified to parse.

ERROR in generate_gui: unknown theme "chartreuse" (use: neon, glass, sunset,
forest, mono, candy, gold)        ← unknown input is reported, never silently defaulted

7/7 themes OK
```

### 4.1 A real dead-argument bug this found

`buildGui({title:"Alpha"})` and `buildGui({title:"Beta"})` produced **identical
source** on the default `hud` screen — `title` only reached the widgets that render
a headline. An argument that exists and does nothing is worse than no argument, so
the `ScreenGui` name now carries it. The determinism test caught it.

## 5. The prompt now enforces "generate, then LOOK"

Generating is half the job. The other half is that the model must actually see the
result, which is what `screen_capture` is for. `P_QUALITY` gained:

> **GUI & LOGO: GENERATE, THEN LOOK.** Never hand-write GUI layout: you have no
> pixels, so every UDim2 number you invent is a guess… send the returned source
> through multi_edit EXACTLY as given… **THEN LOOK:** start_stop_play true →
> screen_capture → judge what you SEE (overlap, clipping, contrast). Fix by
> re-calling the generator with different args, never by nudging numbers. **A GUI
> you never captured is UNVERIFIED — say so.**

## 6. Honest limits

* **This does not make a model artistic.** It removes the model's opportunity to
  get *layout arithmetic* wrong. The output is a disciplined, readable, animated UI
  — not bespoke art. A human designer still beats it.
* **It cannot see the result.** Only `screen_capture` can, which is exactly why the
  prompt now requires a capture. The generator's own `capabilities` object says
  `vision: false`.
* **No image upload.** `capabilities.imageUpload === false`. A place icon in
  Studio's own UI needs a human to screenshot the rendered logo — the tool note says
  so rather than pretending a `.png` was produced.
* **Vision depends on the site, not this code.** `screen_capture` returns a real
  image through the bridge, and the pipeline attaches it (tested paths in
  `arena`/`glm`/`chatgpt`). But **ChatGPT is `supportsVision: false`** in this
  repo — deliberately, because its free tier caps image input separately and fails
  intermittently, so the core blocks the vision tools outright rather than working
  half the time. Gemini, Claude, GLM, Kimi, Meta, Qwen, Arena are `supportsVision:
  true`. On ChatGPT, `generate_gui` still works (it is pure codegen); only
  `screen_capture` is blocked, and the model is told why.
* **"Best" is a floor, not a ceiling.** What is *measured* is contrast ≥ 4.5:1,
  scale-based geometry, valid Luau, and determinism. What is *not* measured is
  whether it matches a specific art direction — that needs a human eye.

## 7. Files changed

| File | Change |
|---|---|
| `core/gui.js` | **new** — themes, contrast maths, widget catalogue, GUI + logo emitters |
| `core/main.js` | `generate_gui`/`generate_logo` dispatch; virtual tools injected into the catalogue; every result Luau-verified before return |
| `core/config.js` | `TOOL_NOTES` entries; `P_QUALITY` GUI workflow; role line budget held |
| `manifest.json` | `core/gui.js` added to all **14** content-script bundles |
| `test-gui.js` | **new** — 89 assertions |
| `tests/` | version strings to 4.8.2 |
| `tools/verify.js`, `package.json` | register `test-gui.js` / `test:gui` |

Prompt size after adding the workflow: **7,532 chars** (4.8.1: 6,929; the 4.7.x
baseline was 37,983). Held under the existing 7,597 ceiling by trimming the
workflow prose, not by raising the limit.

## 8. Full gate

```
node tools/verify.js                        ALL CHECKS PASSED (19 suites)
python -m unittest discover -s tests        55 tests OK
node tools/audit-deep.js                    0 P0, 0 P1, 0 P2
python scripts/sync_copies.py --check       64 verified, match
node zeroscript-extension-v2/test-gui.js    89 passed, 0 failed
```

Version bumped to **4.8.2** across the manifest, `package.json`, the lockfile and
24 modules — the `[version]` gate enforces this, and it caught all 24.
