// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-enhancer.js — regression suite for
// core/prompt_enhancer.js (4.8.0).
//
// WHY THIS FILE EXISTS
// --------------------
// The enhancer rewrites the user's message before it is typed into the AI site.
// When that rewrite is wrong it does not fail loudly — the model simply receives
// a different request. 4.7.x had three concrete defects, all reproduced here:
//
//   1. EVERY short message was classified "vague", so "thanks", "ok", "yes" and
//      "2+2?" received ~5,400 characters of simulator spec and a reasoning
//      protocol. The user asked for nothing and the model was told to build a
//      game. That is the "external prompts make results worse" complaint, and it
//      is the single most damaging bug in this file.
//   2. "thanks" could never even be classified: the greeting regex
//      `/^(hi|thanks)[.!?]*$/` backtracks into its own alternatives.
//   3. isInternalPrompt()'s prefix check was anchored inside one `^\s*(?: … )`
//      group, so feedback that began with a newline was rewritten as if the user
//      had typed it — the extension enhanced its OWN tool results.
//
// Plus the honesty defect: "helps Flash act ~35-40% closer to Pro" and the /smart
// "~30%" were printed to the model although this repo has no eval harness, no
// dataset and no recorded run that measures anything.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = __dirname;
const ctx = { console, setTimeout, clearTimeout };
vm.createContext(ctx);
ctx.window = ctx;
vm.runInContext(fs.readFileSync(path.join(root, "core/config.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(root, "core/prompt_enhancer.js"), "utf8"), ctx);
const E = ctx.ZSPromptEnhancer;
if (!E) { console.error("FAIL  core/prompt_enhancer.js did not expose ZSPromptEnhancer"); process.exit(1); }

let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// ── 1. conversation glue is never rewritten ────────────────────────────────
const NOISE = ["thanks", "Thanks!", "thank you", "thx", "ty", "ok", "okay!", "k", "yes",
  "yes please", "no", "nope", "sure", "hi", "hey", "hello", "yo", "test", "great",
  "nice", "perfect", "lgtm", "continue", "go on", "got it", "sounds good", "lets go",
  "awesome", "done", "wow", "hmm", "maybe", "surprise me", "do something"];
for (const t of NOISE) {
  const r = E.enhance(t);
  check("noise is left byte-identical: " + JSON.stringify(t),
    r.changed === false && r.enhanced === t, r.mode + " (+" + (r.enhanced.length - t.length) + ")");
}

// ── 2. short but CLEAR instructions are not "vague" ────────────────────────
const CLEAR = ["fix the Shop bug", "what is 2+2", "add a coin counter to the HUD",
  "how do I use DataStore?", "build a pet simulator with 5 eggs",
  "make the lighting brighter", "rename Part to Coin", "why is my script erroring?",
  "use UDim2.fromScale for the button", "total rewrite please",
  // 4.8.0: one-word questions are UNDEFINED-BUT-NOT-A-BUILD-ASK. 4.7 answered
  // "why" with a 5,397-char simulator blueprint because isBadPrompt() was the
  // only gate on the spec path. They must pass through untouched.
  "bug", "error", "why", "what", "game", "script", "fix", "help me", "it broke",
  "fix it", "add jump", "how?", "explain"];
for (const t of CLEAR) {
  const r = E.enhance(t);
  check("a clear short request is not rewritten: " + JSON.stringify(t), r.changed === false, r.mode);
}

// ── 3. the ONE case the auto-spec exists for ───────────────────────────────
const VAGUE = ["make me a simulator game", "make a game", "build me a tycoon", "create an obby"];
for (const t of VAGUE) {
  const r = E.enhance(t);
  check("a bare build request gets the full spec: " + JSON.stringify(t), r.changed && /AUTO-SPEC|FACT-CHECKED/.test(r.enhanced), r.mode);
  check("…and the spec carries a real folder tree: " + JSON.stringify(t), r.enhanced.includes("ServerScriptService/ZeroSim"));
}

// ── 4. the enhancer must not rewrite the extension's own traffic ───────────
const INTERNAL = [
  "Output of 'execute_luau':\n  ok=true",
  "\nOutput of 'script_read':\n1  local x = 1",
  "ERROR: the local ZeroScript bridge is unreachable",
  "(System note: your previous reply was cut off)",
  "⟦ZS-SYS⟧\nCONTEXT: …",
  "[PEER MESSAGE FROM coder]: building now",
  "# ZeroScript memory",
];
for (const t of INTERNAL) {
  const r = E.enhance(t);
  check("feedback/internal traffic is not enhanced: " + JSON.stringify(t.slice(0, 26)),
    !r.changed || r.enhanced === t, r.mode);
  check("isInternalPrompt() recognises it: " + JSON.stringify(t.slice(0, 26)), E.isInternalPrompt(t) === true);
}
check("isInternalPrompt() does not fire on a normal request", E.isInternalPrompt("make me a simulator") === false);

// ── 4b. needsSpec() is the ONLY gate on the auto-spec ─────────────────────
// Split from isBadPrompt() because "not well formed" and "needs a full game plan"
// are different remedies; conflating them is what put a game spec on the word "why".
for (const t of ["make me a simulator game", "make a game", "build me a tycoon", "create an obby"]) {
  check("needsSpec() is true for a bare build ask: " + JSON.stringify(t), E.needsSpec(t) === true);
}
for (const t of ["thanks", "ok", "why", "bug", "fix it", "fix the Shop bug",
  "build a pet simulator with 5 eggs", "add a coin counter to the HUD", "help me"]) {
  check("needsSpec() is false for " + JSON.stringify(t), E.needsSpec(t) === false);
}

// ── 5. no fabricated quality percentages anywhere ─────────────────────────
const shipped = fs.readFileSync(path.join(root, "core/prompt_enhancer.js"), "utf8")
  // the explanatory comments describe the numbers that were REMOVED; test the code
  .replace(/^\s*\/\/.*$/gm, "");
for (const bad of ["~35-40%", "~30%", "~10-15%", "~20-35%", "Pro proximity", "measurably smarter"]) {
  check("no fabricated claim in shipped strings: " + JSON.stringify(bad), !shipped.includes(bad));
}
check("PRO_BOOST_LIGHT makes no quality claim", !/%/.test(E.PRO_BOOST_LIGHT), E.PRO_BOOST_LIGHT.slice(0, 90));
check("PRO_REASONING_FULL states the limit honestly", /Weights are fixed/i.test(E.PRO_REASONING_FULL));
check("PRO_REASONING_FULL claims no percentage", !/\d+\s?%/.test(E.PRO_REASONING_FULL));

// ── 6. slash commands still work, and are combinable ──────────────────────
const slashed = E.enhance("/truth is my shop working");
check("/truth produces the evidence-mode block", slashed.mode === "truth" && /EVIDENCE MODE/.test(slashed.enhanced));
const combined = E.enhance("/truth /code build a tycoon");
check("combinable slash commands stack", combined.mode === "truth+code" && /EVIDENCE MODE/.test(combined.enhanced) && /\/code/.test(combined.enhanced));
const aliased = E.parseSlash("/brutal-honest /0%-lies check this");
check("honesty aliases resolve to /truth", aliased && aliased.cmds.every((c) => c === "truth"), JSON.stringify(aliased && aliased.cmds));
check("a slash body is preserved", E.parseSlash("/code build a shop").body === "build a shop");
check("no slash returns null (fast path)", E.parseSlash("just a normal prompt") === null);

// ── 7. themes are still detected ──────────────────────────────────────────
for (const [t, want] of [["make a pet simulator", "Pet Simulator"], ["build a tycoon", "Tycoon"],
  ["an obby with stages", "Obby Simulator"], ["a horror game", "Horror Experience"]]) {
  check("theme detected for " + JSON.stringify(t), E.detectTheme(t).name === want, E.detectTheme(t).name);
}

// ── 8. the wrapper skips internal text end-to-end ─────────────────────────
(async () => {
  let sent = null;
  const provider = { typeAndSend: async (text) => { sent = text; return "ok"; } };
  const wrapped = E.wrapTypeAndSend(provider);
  await wrapped.typeAndSend("Output of 'execute_luau':\n  ok", []);
  check("wrapTypeAndSend sends internal text unchanged", sent === "Output of 'execute_luau':\n  ok", String(sent).slice(0, 40));
  await wrapped.typeAndSend("thanks", []);
  check("wrapTypeAndSend sends noise unchanged", sent === "thanks", String(sent).slice(0, 40));
  await wrapped.typeAndSend("make me a simulator game", []);
  check("wrapTypeAndSend expands a bare build request", typeof sent === "string" && sent.length > 1000);

  console.log("\n" + pass + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
