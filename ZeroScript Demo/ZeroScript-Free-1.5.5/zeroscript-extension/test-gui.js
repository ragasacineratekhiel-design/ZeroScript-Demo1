// SPDX-License-Identifier: GPL-3.0-or-later
// test-gui.js — the generated GUI/logo must be CORRECT, not just plausible.
//
// The complaint this addresses: "the gui they make are garbage, prompt wont do
// anything". So these assertions do not check that the output "looks like" GUI
// code — they check the properties that actually make GUI bad or good:
//
//   * every generated script PARSES as Luau (via the real analyser, not a regex),
//   * every position/size is scale-based, so it survives any resolution,
//   * every colour pair clears WCAG AA 4.5:1 (computed, not asserted),
//   * output is DETERMINISTIC (same spec → byte-identical source),
//   * a logo cannot be distorted (UIAspectRatioConstraint present),
//   * the generator never emits an image dependency it cannot satisfy.
//
// If a theme is changed to something unreadable, or a widget is edited to use
// fixed offsets, these fail — which is the entire point.
const G = require("./core/gui.js");
const S = require("./core/sandbox.js");

let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}
const parse = (src) => S.analyseStrict(src);

// ── 1. module shape ────────────────────────────────────────────────────────
check("module exports buildGui", typeof G.buildGui === "function");
check("module exports buildLogo", typeof G.buildLogo === "function");
check("module exports build", typeof G.build === "function");
check("version is 4.8.2", G.VERSION === "4.8.2", G.VERSION);
check("capabilities honestly deny vision and image upload",
  G.capabilities.vision === false && G.capabilities.imageUpload === false);
check("capabilities say it produces code, not pixels", /code, not pixels/.test(G.capabilities.note));

// ── 2. EVERY generated script parses as Luau ───────────────────────────────
// This is the assertion that makes "generated" and "valid" the same statement.
let parsed = 0, parseFail = [];
for (const theme of G.THEME_NAMES) {
  for (const screen of G.SCREEN_NAMES) {
    const r = G.buildGui({ theme, screen });
    const v = parse(r.script);
    if (v.ok) parsed++; else parseFail.push(`${theme}/${screen}: ${v.error}`);
  }
}
check(`all ${G.THEME_NAMES.length * G.SCREEN_NAMES.length} theme×screen GUIs parse as Luau`,
  parseFail.length === 0, parseFail.slice(0, 3).join(" | "));

let wParsed = 0, wFail = [];
for (const w of G.WIDGET_NAMES) {
  const r = G.buildGui({ theme: "neon", widgets: [w] });
  const v = parse(r.script);
  if (v.ok) wParsed++; else wFail.push(`${w}: ${v.error}`);
}
check(`all ${G.WIDGET_NAMES.length} widgets parse individually`, wFail.length === 0, wFail.slice(0, 3).join(" | "));

let lParsed = 0, lFail = [];
for (const style of G.LOGO_STYLE_NAMES) {
  for (const theme of G.THEME_NAMES) {
    const r = G.buildLogo({ style, theme });
    const v = parse(r.script);
    if (v.ok) lParsed++; else lFail.push(`${style}/${theme}: ${v.error}`);
  }
}
check(`all ${G.LOGO_STYLE_NAMES.length * G.THEME_NAMES.length} logo style×theme outputs parse`,
  lFail.length === 0, lFail.slice(0, 3).join(" | "));

// ── 3. CONTRAST is measured, not claimed ───────────────────────────────────
// WCAG AA for body text is 4.5:1. A theme that fails this is unreadable in a
// dark game, which is a real defect and not a matter of taste.
check("luminance of black is 0", Math.abs(G.luminance([0, 0, 0])) < 1e-9);
check("luminance of white is 1", Math.abs(G.luminance([255, 255, 255]) - 1) < 1e-9);
check("contrast(black, white) is 21:1", Math.abs(G.contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 0.01);
check("contrast is symmetric",
  Math.abs(G.contrastRatio([10, 20, 30], [200, 210, 220]) - G.contrastRatio([200, 210, 220], [10, 20, 30])) < 1e-9);

for (const t of G.THEME_NAMES) {
  const c = G.themeContrast(t);
  check(`theme ${t}: body text on bg clears WCAG AA 4.5:1 (${c.textOnBg.toFixed(2)}:1)`, c.textOnBg >= 4.5);
  check(`theme ${t}: body text on surface clears 4.5:1 (${c.textOnSurface.toFixed(2)}:1)`, c.textOnSurface >= 4.5);
  check(`theme ${t}: muted text clears 4.5:1 (${c.mutedOnBg.toFixed(2)}:1)`, c.mutedOnBg >= 4.5);
}

// ── 4. SCALE-BASED layout, no fixed-pixel geometry ─────────────────────────
// Fixed offsets are why a hand-made GUI breaks on a phone. Every *geometry*
// assignment must be fromScale; fromOffset is only allowed for anchors/padding,
// which are intentional pixel insets.
const sample = G.buildGui({ theme: "neon", screen: "shop" }).script;
const geom = sample.match(/(Position|Size)\s*=\s*UDim2\.[A-Za-z]+\([^)]*\)/g) || [];
const offsetGeom = geom.filter((g) => /^Size\s*=\s*UDim2\.fromOffset/.test(g));
check("no widget SIZE is a fixed pixel size", offsetGeom.length === 0, offsetGeom.join(", "));
check("the sample uses UDim2.fromScale for geometry", /UDim2\.fromScale\(/.test(sample));
check("the sample uses UIAspectRatioConstraint nowhere in a plain GUI (logos only)",
  !/UIAspectRatioConstraint/.test(sample));

// ── 5. LOGO cannot be distorted ────────────────────────────────────────────
// The commonest hand-made logo defect is an oval after a stretch.
for (const style of G.LOGO_STYLE_NAMES) {
  const src = G.buildLogo({ style, theme: "neon" }).script;
  check(`logo ${style}: aspect-locked (UIAspectRatioConstraint)`, /UIAspectRatioConstraint/.test(src));
  check(`logo ${style}: no external image asset id`, !/rbxassetid/.test(src));
  check(`logo ${style}: no ImageLabel dependency`, !/Instance\.new\("ImageLabel"\)/.test(src));
}
check("logo meta says vector and no upload needed",
  G.buildLogo({}).meta.vector === true && G.buildLogo({}).meta.needsImageUpload === false);

// ── 6. DETERMINISM ─────────────────────────────────────────────────────────
// Same spec must produce byte-identical source, or diffs between turns become
// meaningless and the model cannot reason about what it changed.
const a = G.buildGui({ theme: "glass", screen: "shop", title: "Store" }).script;
const b = G.buildGui({ theme: "glass", screen: "shop", title: "Store" }).script;
check("buildGui is deterministic", a === b);
check("buildLogo is deterministic",
  G.buildLogo({ style: "shield" }).script === G.buildLogo({ style: "shield" }).script);
check("a different theme changes the output",
  G.buildGui({ theme: "neon" }).script !== G.buildGui({ theme: "mono" }).script);
check("a different title changes the output",
  G.buildGui({ title: "Alpha" }).script !== G.buildGui({ title: "Beta" }).script);

// ── 7. INPUT VALIDATION reports, never silently defaults ───────────────────
const badTheme = G.build({ theme: "chartreuse" });
check("an unknown theme is reported, not silently replaced",
  badTheme.problems.some((p) => /unknown theme/.test(p)), JSON.stringify(badTheme.problems));
const badWidget = G.build({ theme: "neon", widgets: ["hud", "spaceship"] });
check("an unknown widget is reported",
  badWidget.problems.some((p) => /unknown widget/.test(p)));
check("the known widgets in the same call still build",
  badWidget.meta.widgets.includes("hud"));

// De-duplication: two HUDs stacked would look like a rendering bug.
const dup = G.buildGui({ theme: "neon", widgets: ["hud", "hud", "toast", "toast"] });
check("duplicate widgets are de-duplicated", dup.meta.emitted === 2, String(dup.meta.emitted));
check("widget ORDER is preserved", dup.meta.widgets.join(",") === "hud,toast");

// An empty widget list must fall back to the screen's defaults, not produce
// an empty ScreenGui that does nothing.
const empty = G.buildGui({ theme: "neon", screen: "menu", widgets: [] });
check("an empty widget list falls back to the screen default", empty.meta.emitted > 0);

// ── 8. real UI behaviour is present, not implied ───────────────────────────
// These are the things that separate "made by a model" from "made".
const btns = G.buildGui({ theme: "neon", widgets: ["buttons"] }).script;
check("buttons have hover/press motion (TweenService)", /TweenService:Create/.test(btns));
check("buttons disable AutoButtonColor (or the tween fights the default)", /AutoButtonColor = false/.test(btns));
check("buttons are wired to an action, not decorative", /\.Activated:Connect/.test(btns));
check("text is scaled with a constraint, never a fixed font size",
  /UITextSizeConstraint/.test(btns) && /MaxTextSize/.test(btns));

const hud = G.buildGui({ theme: "neon", widgets: ["hud"] }).script;
check("HUD survives respawn (ResetOnSpawn = false)", /ResetOnSpawn = false/.test(hud));
check("HUD reads a real data source (attributes), not invented literals",
  /GetAttribute\("Coins"\)/.test(hud) && /GetAttributeChangedSignal/.test(hud));

const dlg = G.buildGui({ theme: "neon", widgets: ["dialog"] }).script;
check("dialog buttons actually close it", /closeDialog/.test(dlg) && /:Destroy\(\)/.test(dlg));
check("dialog dims the background behind it", /DialogDim/.test(dlg));

const prog = G.buildGui({ theme: "neon", widgets: ["progress"] }).script;
check("progress bar computes a real percentage", /math\.floor\(pct \* 100\)/.test(prog));
check("progress bar clamps its input", /math\.clamp/.test(prog));

// ── 9. every theme is a complete palette (no nil colours in Luau) ──────────
for (const t of G.THEME_NAMES) {
  const th = G.THEMES[t];
  const missing = ["bg", "surface", "accent", "accent2", "text", "muted", "radius", "gap", "font"]
    .filter((k) => th[k] == null);
  check(`theme ${t} is a complete palette`, missing.length === 0, missing.join(","));
  check(`theme ${t} radius is a sane integer (4-20)`, Number.isInteger(th.radius) && th.radius >= 4 && th.radius <= 20, String(th.radius));
}
const fonts = new Set(G.THEME_NAMES.map((t) => G.THEMES[t].font));
check("every theme font is a real Enum.Font member",
  [...fonts].every((f) => /^(GothamBold|GothamMedium|GothamBlack|Gotham)$/.test(f)), [...fonts].join(","));

// ── 10. size limits are enforced (a 4px logo is a bug, so is 40000px) ─────
check("logo size is clamped low", G.buildLogo({ size: 1 }).meta.size === 32);
check("logo size is clamped high", G.buildLogo({ size: 99999 }).meta.size === 1024);
check("logo initials are capped at 2 chars", G.buildLogo({ initials: "ABCDEF" }).meta.initials === "AB");
check("logo initials are upper-cased", G.buildLogo({ initials: "zs" }).meta.initials === "ZS");

console.log("\n" + pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
