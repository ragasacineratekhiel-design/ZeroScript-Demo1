// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-prompt.js — regression suite for core/config.js's
// system-prompt assembly (4.8.0).
//
// WHY THIS FILE EXISTS
// --------------------
// The startup prompt is the highest-leverage text in the product: it is prepended
// to every conversation and it is the only instruction set the model reliably
// sees. 4.7.x shipped 37,983 characters (~9,500 approx-tokens, 5,500 words) of
// sixteen accreted sections that contradicted each other and quoted numbers
// nobody measured. These assertions pin the properties that must never come back:
//
//   1. the whole thing fits a stated budget and the budget is enforced;
//   2. the load-bearing protocol survives ANY budget (it is never the part cut);
//   3. no protocol is stated twice (duplication is what made it unreadable);
//   4. no invented measurement sneaks back in;
//   5. the version in the prompt is the version that ships.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "core/config.js"), "utf8");
const ctx = { console, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(src + ";this.ZS = ZS;", ctx);
const ZS = ctx.ZS;
if (!ZS || !ZS.buildSystemPrompt) {
  console.error("FAIL  core/config.js did not expose buildSystemPrompt");
  process.exit(1);
}

let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}
const count = (hay, needle) => (hay.split(needle).length - 1);

// ── 1. size + budget ───────────────────────────────────────────────────────
const prompt = ZS.buildSystemPrompt({ siteName: "ChatGPT" });
check("default prompt is under the 12,000-char budget", prompt.length <= 12000, prompt.length + " chars");
check("default prompt is under 2,000 approx-tokens (length/4)", Math.round(prompt.length / 4) < 2000, Math.round(prompt.length / 4) + " tokens");
// The 4.7.x prompt was 37,983 chars. A regression to even half of that is a bug.
check("default prompt is at most a fifth of the 4.7.x prompt (37,983 chars)", prompt.length < 7597, prompt.length + " chars");
// 4.8.1: the floor moved 4,217 → 4,531 because T0 gained two rules that are worth
// more than the characters they cost (NO INVENTED CONNECTION, and YOUR ROLE/SOLO).
// T0 is NEVER truncated by design — dropping the command format to hit a number
// would be the exact failure this whole budget exists to prevent — so this asserts
// the measured floor, not a target. If it grows again, that is a deliberate
// decision and this number must be re-measured, not bumped blindly.
const t0Floor = ZS.buildSystemPrompt({ siteName: "X", budget: 4000 }).length;
check("a 4,000-char budget is bounded by the T0 floor (~4,600), never the budget", t0Floor <= 4600, t0Floor + " chars");
check("an impossibly small budget yields exactly the T0 floor (T0 is untruncatable)",
  ZS.buildSystemPrompt({ siteName: "X", budget: 500 }).length === t0Floor);
check("promptStats reports the same size it builds", ZS.promptStats({ siteName: "ChatGPT" }).chars === prompt.length);

// ── 2. the protocol survives every budget ──────────────────────────────────
// These strings are the ones whose absence directly causes a failed tool call.
const MUST_SURVIVE = {
  "execute_luau marker format": "###LUA###",
  "execute_luau closing marker": "###END_LUA###",
  "JSON command envelope": '{"command": "command_name", "params": {"key": "value"}}',
  "read-before-mutate": "READ BEFORE MUTATE",
  "copy-exactly": "COPY EXACTLY",
  "Play gate": "PLAY GATE",
  "self-heal": "SELF-HEAL",
  "return-not-print": "RETURN, NOT PRINT",
  "one command per reply": "ONE COMMAND PER REPLY",
  "unknown-outcome rule": "IF THE RESULT IS UNKNOWN, INSPECT FIRST",
  "evidence rule": "Never state a path, property, value or success you did not read back",
};
for (const budget of [4000, 6000, 12000]) {
  const p = ZS.buildSystemPrompt({ siteName: "X", budget });
  for (const [label, needle] of Object.entries(MUST_SURVIVE)) {
    check(`budget ${budget}: keeps ${label}`, p.includes(needle));
  }
}

// ── 3. no duplicated protocol ──────────────────────────────────────────────
// Duplication is not merely wasteful; two copies drift and then contradict.
const ONCE_ONLY = ["PLAY GATE", "SELF-HEAL", "RETURN, NOT PRINT", "ONE COMMAND PER REPLY",
  "READ BEFORE MUTATE", "COPY EXACTLY", "IF THE RESULT IS UNKNOWN"];
for (const needle of ONCE_ONLY) {
  check(`"${needle}" is stated exactly once`, count(prompt, needle) === 1, count(prompt, needle) + "x");
}

// ── 4. no invented measurements or stale versions ──────────────────────────
// Each of these strings was a real claim in 4.7.x that no harness in this repo
// supports. They must not come back.
const BANNED = [
  "Pro proximity", "-28%", "-34%", "completion +22%", "~45%", "~50%",
  "10ms ULTRA", "40ms (was 100)", "Ready — ZeroScript MAX 4.3.0",
  "~20s budget", "upgraded 10×", "UPGRADED 10×",
];
for (const bad of BANNED) {
  check(`no unmeasured/stale claim: ${JSON.stringify(bad)}`, !prompt.includes(bad));
}
check("no bare '10ms' latency claim without a correction", !/\b10ms\b/.test(prompt), (prompt.match(/.{0,30}10ms.{0,30}/) || [""])[0]);
check("the prompt states its own version, and it is the shipped one", prompt.includes(ZS.PROMPT_VERSION) && ZS.PROMPT_VERSION === ZS.APP_VERSION, ZS.PROMPT_VERSION + " vs " + ZS.APP_VERSION);
check("the honest capability statement is present", /syntax only/i.test(prompt) || /cannot call these as site tools/i.test(prompt));

// ── 5. tiering actually drops the lowest tier first ────────────────────────
const full = ZS.buildSystemPrompt({ siteName: "X" });
const tight = ZS.buildSystemPrompt({ siteName: "X", budget: 4200 });
check("a tight budget drops the simulator blueprint", !tight.includes("SIMULATOR BLUEPRINT"));
check("a tight budget drops the build bar", !tight.includes("BUILD BAR"));
check("a tight budget still explains the command format", tight.includes("###LUA###") && tight.includes('"command"'));
// `full` already fits the default budget, so verbose can only differ when the
// budget is the thing squeezing it: compare verbose-100 against budget-100.
check("verbose:true survives a 100-char budget while the normal build obeys it",
  ZS.buildSystemPrompt({ siteName: "X", budget: 100 }).length < ZS.buildSystemPrompt({ siteName: "X", budget: 100, verbose: true }).length);
check("verbose:true renders every tier", ["BUILD BAR", "SIMULATOR BLUEPRINT", "IF THE MODEL VANISHES"]
  .every((k) => ZS.buildSystemPrompt({ siteName: "X", verbose: true }).includes(k)));

// ── 6. the user's custom prompt and the site rules are not silently lost ───
const CUSTOM = "CUSTOM-RULE-MARKER: always use PascalCase for instance names.";
const withCustom = ZS.buildSystemPrompt({ siteName: "X", customPrompt: CUSTOM });
check("a custom prompt is injected verbatim when it fits", withCustom.includes(CUSTOM));
const tiny = ZS.buildSystemPrompt({ siteName: "X", budget: 4300, customPrompt: CUSTOM });
check("a custom prompt is truncated, not dropped, under a tight budget", tiny.includes("CUSTOM-RULE-MARKER"), tiny.length + " chars");
const notes = ZS.buildSystemPrompt({ siteName: "X", providerNotes: "SITE-RULE-MARKER", verbose: true });
check("provider notes are injected", notes.includes("SITE-RULE-MARKER"));

// ── 7. memory digest is bounded and labelled ───────────────────────────────
const mem = ZS.buildSystemPrompt({ siteName: "X", memoryDigest: "M".repeat(9000), verbose: true });
// count only the digest BODY between the section header and its END marker
const memBody = (() => {
  const i = mem.indexOf("PROJECT MEMORY (this place");
  if (i < 0) return "";
  const afterHeader = mem.indexOf("\n", mem.indexOf("━━━", i + 10));
  const end = mem.indexOf("━━━ END PROJECT MEMORY", afterHeader);
  return mem.slice(afterHeader, end);
})();
check("a long memory digest is capped at 1,800 chars", count(memBody, "M") <= 1800 && count(memBody, "M") > 1700, count(memBody, "M") + " chars");
check("memory digest is labelled as project memory", mem.includes("PROJECT MEMORY"));
check("an empty memory digest injects no empty section", !ZS.buildSystemPrompt({ siteName: "X" }).includes("PROJECT MEMORY (this place"));

// ── 8. plan modes render without throwing ─────────────────────────────────
for (const plan of ["direct", "agent", "plan", "checker"]) {
  let rendered = null, threw = null;
  try {
    vm.runInContext("window.__zsPlan = " + JSON.stringify(plan), Object.assign(ctx.window || (ctx.window = ctx), {}));
    ctx.window.__zsPlan = plan;
    rendered = ZS.buildSystemPrompt({ siteName: "X" });
  } catch (e) { threw = e; }
  check("plan '" + plan + "' renders without throwing", !threw && rendered.includes("SWITCH PLAN"), threw ? threw.message : "");
}

// ── 9. the repair addendum is opt-in, never default ───────────────────────
check("the default prompt does NOT promise auto-repair",
  !/auto-?repair/i.test(prompt));
check("sandboxAddendum(false) describes the static check honestly",
  /syntax only/i.test(ZS.sandboxAddendum(false)));
check("sandboxAddendum(true) tells the model a repair happened",
  /auto-closed/i.test(ZS.sandboxAddendum(true)));


// ── 9. 4.8.1: declared role + connection honesty in the prompt ─────────────
// A solo tab that believes it has teammates hands work to nobody and waits.
// Observed live: "I'm connected to another agent" from a single Gemini tab.
const soloPrompt = ZS.buildSystemPrompt({ siteName: "Gemini", role: "coder", solo: true });
check("solo prompt declares CODER as the role", /YOUR ROLE:.*CODER/i.test(soloPrompt), "no role declaration");
check("solo prompt states there is exactly one AI", /SOLO/i.test(soloPrompt));
check("solo prompt forbids handing work to a teammate",
  /no planner, no checker, no other agent is connected/i.test(soloPrompt));
check("solo prompt carries the no-invented-connection rule",
  /NO INVENTED CONNECTION/i.test(soloPrompt));
check("solo prompt never claims a peer connection",
  !/im connected to other agent/i.test(soloPrompt));

const teamPrompt = ZS.buildSystemPrompt({ siteName: "Claude", role: "planner", solo: false });
check("team prompt declares PLANNER", /YOUR ROLE:.*PLANNER/i.test(teamPrompt));
check("team prompt does not call the tab solo", !/Your role: .*SOLO|YOU ARE SOLO/i.test(teamPrompt));
check("planner is told it may not mutate", /may NOT mutate Studio/i.test(teamPrompt));

// The role line must survive the tightest budget: it is the cheapest defence
// against the most expensive hallucination.
check("the role line survives an impossible budget",
  /YOUR ROLE:/i.test(ZS.buildSystemPrompt({ siteName: "X", budget: 100, role: "coder", solo: true })));

// ── 10. 4.8.1: the user's custom prompt can never be silently dropped ──────
// Regression for a real bug: `room() > 200` was false whenever T0 alone exceeded
// the budget, so a custom prompt was discarded with no trace on small-budget
// providers. It must be present at EVERY budget, including one below the floor.
for (const b of [100, 500, 4300, 6000, 20000]) {
  const t = ZS.buildSystemPrompt({ siteName: "X", budget: b, customPrompt: "CUSTOM-RULE-MARKER" });
  check(`custom prompt survives budget ${b}`, t.includes("CUSTOM-RULE-MARKER"));
}

// ── 11. 4.8.1: NO EDIT CAP replaces the fake "24 edits" limit ──────────────
// The old prompt said "MAX: batch up to 24 edits per call" and NOTHING enforced
// it. A model that believed it split work it could have done in one turn.
check("TOOL_NOTES no longer claims a 24-edit cap", !/MAX: batch up to 24 edits/.test(ZS.TOOL_NOTES.multi_edit));
check("TOOL_NOTES tells the model there is no edit cap", /NO EDIT CAP/i.test(ZS.TOOL_NOTES.multi_edit));
check("TOOL_NOTES says an unparseable edit rejects the whole batch",
  /WHOLE batch is rejected/i.test(ZS.TOOL_NOTES.multi_edit));

console.log("\n" + pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
