// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-enhancer.js — regression suite for core/prompt_enhancer.js
//
// Three things are guarded here, all of them things the 4.7.0 tree got wrong:
//   1. HONESTY — no prompt surface may quote a quality/proximity percentage.
//      The old PRO_BOOST_LIGHT claimed "helps Flash act ~35-40% closer to Pro"
//      and /smart claimed "~30% Pro-like quality". Nothing in this repo can
//      measure either, so a test now fails the build if one comes back.
//   2. GROUNDEDNESS — the acceptance checklist must be derived from the user's
//      own words. Generic coaching that ignores the request is what made the
//      "amplifier" useless; these assertions prove specific triggers fire.
//   3. COST — the default path must stay lean. The 4.7.0 default appended
//      ~3.3KB of identical boilerplate to every prompt.
const path = require("path");

// the enhancer publishes itself on `window`, so provide the smallest shim
global.window = global.window || {};
global.self = global.window;
require("./core/prompt_enhancer.js");
const E = global.window.ZSPromptEnhancer;

let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

check("enhancer version is 4.8.0", E.version === "4.8.0", E.version);

// ══ 1. HONESTY: no unmeasurable percentage anywhere the model can read ══════
// Every string the enhancer can append to a user prompt.
const SURFACES = {
  PRO_BOOST_LIGHT: E.PRO_BOOST_LIGHT,
  PRO_REASONING_FULL: E.PRO_REASONING_FULL,
  SCAFFOLD_BRIEF: E.SCAFFOLD_BRIEF,
};
for (const [k, v] of Object.entries(E.SLASH_DEFS || {})) {
  SURFACES["SLASH:" + k] = String((v.desc || "") + " " + (typeof v.template === "function"
    ? v.template("build a thing", { name: "Generic", systems: [] }, "", "") : ""));
}
// A percentage that reads like a MEASUREMENT is a claim: "~30%", "-28%",
// "+40-50%", "22% fewer". Intensifiers ("100% real", "the 0.1% senior
// engineer") and plain counts are not, so they must not trip the gate.
const CLAIM = /(?:~\s*)?\d+\s*%\s*(?:closer|pro|proximity|quality|better|smarter|gain|boost|improvement)/i;
const VAGUE_PCT = /(?:~|-|\+)\s*\d+(?:\.\d+)?\s*%|\d+\s*%\s*(?:fewer|less|more|reduction|improvement|gain|boost|faster|smarter|closer)/i;
for (const [name, text] of Object.entries(SURFACES)) {
  check("honest: no quality percentage in " + name, !CLAIM.test(String(text)),
    (String(text).match(CLAIM) || [])[0]);
  check("honest: no bare percentage in " + name, !VAGUE_PCT.test(String(text)),
    (String(text).match(VAGUE_PCT) || [])[0]);
}
check("honest: TRUTH note survives in the full protocol",
  /does NOT change your weights/i.test(E.PRO_REASONING_FULL));
check("honest: the parse gate is stated as parsing, not execution",
  /NO Luau VM/i.test(E.PRO_REASONING_FULL) && /parses, it does not run/i.test(E.PRO_REASONING_FULL));

// ══ 2. GROUNDEDNESS: the checklist comes from the user's own words ══════════
const cl = (s) => E.buildAcceptanceChecklist(s);

check("checklist: captures an explicit count", /asked for 3 pets/.test(cl("build 3 pets")), cl("build 3 pets"));
check("checklist: ignores an interval, not a deliverable",
  !/asked for 5 seconds/.test(cl("update every 5 seconds")), cl("update every 5 seconds"));
check("checklist: still counts real deliverables next to an interval",
  /asked for 10 players/.test(cl("top 10 players, update every 5 seconds")), cl("top 10 players, update every 5 seconds"));
check("checklist: DataStore triggers a pcall rule", /pcall/.test(cl("save player data with DataStore")), cl("save player data with DataStore"));
check("checklist: mobile triggers fromScale", /UDim2\.fromScale/.test(cl("make it work on mobile")), cl("make it work on mobile"));
check("checklist: anti-exploit triggers server authority", /SERVER/i.test(cl("add anti-cheat")), cl("add anti-cheat"));
check("checklist: rebirth triggers leaderstat survival", /survive the rebirth/.test(cl("add a rebirth system")), cl("add a rebirth system"));
check("checklist: an exclusion becomes a prohibition",
  /do not implement it/.test(cl("pet simulator but no trading")) && /trading/i.test(cl("pet simulator but no trading")),
  cl("pet simulator but no trading"));
check("checklist: empty when nothing is detectable", cl("hello") === "", JSON.stringify(cl("hello")));
check("checklist: bounded to 8 rules",
  cl("mobile ui sound tween particle save rebirth shop pet economy performance gamepad anti-cheat rebirth 3 pets 4 eggs 2 worlds").split("\n").filter((l) => l.startsWith("•")).length <= 8);

// ══ 3. COST: the default path is lean and carries real constraints ══════════
const detailed = "Please create a leaderboard GUI showing the top 10 players, saved with DataStore, that works on mobile";
const r = E.enhance(detailed);
const added = r.enhanced.length - detailed.length;
check("cost: default path adds under 2KB (was ~3.3KB of boilerplate)", added < 2000, added + " chars");
check("cost: default path still carries the checklist",
  /ACCEPTANCE CHECKLIST/.test(r.enhanced) && /asked for 10 players/.test(r.enhanced));
check("cost: default path no longer dumps the 3KB generic protocol",
  !/REASON STEP-BY-STEP/.test(r.enhanced));
check("cost: simple prompt produces no empty checklist block", !/END CHECKLIST/.test(E.enhance("hello there").enhanced));

// ══ 4. the vague path must not contradict the user's exclusion ═════════════
const vague = E.enhance("build a pet simulator with 3 pets and no trading");
check("vague: checklist rides along with the auto-spec", /END CHECKLIST/.test(vague.enhanced));
check("vague: the user's exclusion is carried through",
  /do not implement it/.test(vague.enhanced) && /trading/i.test(vague.enhanced));

console.log("\n" + pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
