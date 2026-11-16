// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-exec-modes.js — Single / Continuous / Loop.
//
// WHY THIS FILE EXISTS
// There were ZERO tests for exec modes, and the mode logic broke twice:
//   4.6.0 returned every tool result to the model, so "make the part red"
//         became get_studio_state → inspect_instance → search_game_tree → …
//         an unbounded read-only spinner. (token burn)
//   4.7.0 broke out of the loop after the FIRST successful tool. The first tool
//         a model picks is nearly always a read, so Single ran one inspection
//         and died with the game unchanged — and the audit chart called that a
//         fix. (no-op)
// Both are regressions a single assertion would have caught, so they are
// asserted here against the real decision function extracted from main.js.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// ── load the pure decision function straight out of main.js ───────────────
// Extracted rather than imported because main.js is a content script that
// expects a live DOM; the decision itself is deliberately side-effect free.
const SRC = fs.readFileSync(path.join(__dirname, "core", "main.js"), "utf8");
const fnMatch = SRC.match(/function singleToolDecision\(\{[\s\S]*?\n  \}\n/);
const constMatch = SRC.match(/const SINGLE_MAX_READS = (\d+);/);
check("main.js still defines singleToolDecision", !!fnMatch);
check("main.js still defines SINGLE_MAX_READS", !!constMatch);
if (!fnMatch || !constMatch) { console.log("\n" + pass + " passed, " + failed + " failed"); process.exit(1); }

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fnMatch[0] + "\n" + constMatch[0] +
  "\nglobalThis.dec = singleToolDecision; globalThis.MAX = SINGLE_MAX_READS;", ctx);
const dec = ctx.dec, MAX = ctx.MAX;

// ── the mutation classifier the decision depends on ───────────────────────
// core/config.js is a plain content script (`const ZS = (…)()`), not a CommonJS
// module, so it is evaluated in a VM and read back off the global it installs.
{
  const cfgCtx = {};
  vm.createContext(cfgCtx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "core", "config.js"), "utf8"), cfgCtx);
  check("config.js installs ZS with isMutatingTool", typeof cfgCtx.ZS?.isMutatingTool === "function");
  ctx.ZSisMut = cfgCtx.ZS.isMutatingTool;
}
const isMut = (n) => ctx.ZSisMut(n);
check("isMutatingTool: execute_luau mutates", isMut("execute_luau") === true);
check("isMutatingTool: multi_edit mutates", isMut("multi_edit") === true);
check("isMutatingTool: set_property mutates", isMut("set_property") === true);
check("isMutatingTool: get_studio_state is a read", isMut("get_studio_state") === false);
check("isMutatingTool: inspect_instance is a read", isMut("inspect_instance") === false);
check("isMutatingTool: search_game_tree is a read", isMut("search_game_tree") === false);
check("isMutatingTool: namespaced call still classifies", isMut("roblox/execute_luau") === true);

// ── run a whole Single-mode turn the way the loop does ────────────────────
// Mirrors the loop: count reads, ask for a verdict, stop when told to.
function runSeq(tools, { maxReads = MAX } = {}) {
  let reads = 0;
  const executed = [];
  for (const tool of tools) {
    const mutating = isMut(tool);
    if (!mutating) reads++;
    executed.push(tool);
    const v = dec({ isMutating: mutating, isError: false, readCount: reads, maxReads });
    if (v.action === "stop") return { executed, reads, stoppedBy: v.reason };
  }
  return { executed, reads, stoppedBy: null };
}

// THE BUG THE USER HIT: reads then the edit must still happen.
{
  const r = runSeq(["get_studio_state", "inspect_instance", "execute_luau"]);
  check("reads do not end the turn — the edit still runs",
    r.executed.includes("execute_luau"),
    "ran: " + r.executed.join(" → ") + " [4.7.0 stopped after the 1st read]");
  check("a mutation ends the turn", r.stoppedBy === "mutation", String(r.stoppedBy));
  check("the run stopped immediately after the mutation",
    r.executed[r.executed.length - 1] === "execute_luau");
}

// THE OTHER BUG: inspection-only must terminate.
{
  const r = runSeq(Array(200).fill("inspect_instance"));
  check("inspection-only model is capped, not unbounded",
    r.executed.length === MAX && r.stoppedBy === "read-cap",
    r.executed.length + " calls, stopped by " + r.stoppedBy);
  check("the cap is small enough not to burn tokens", MAX > 1 && MAX <= 10, "MAX=" + MAX);
}

// a mutation on the very first call stops at once (Single = one change)
{
  const r = runSeq(["execute_luau"]);
  check("mutation as the first call stops immediately",
    r.executed.length === 1 && r.stoppedBy === "mutation");
}

// an error must always be retryable — even with the read budget exhausted
{
  const v = dec({ isMutating: false, isError: true, readCount: MAX, maxReads: MAX });
  check("an error at the read cap is still retried", v.action === "continue", v.reason);
}

// the decision must not depend on hidden state: same input, same answer
{
  const a = JSON.stringify(dec({ isMutating: false, isError: false, readCount: 2, maxReads: MAX }));
  const b = JSON.stringify(dec({ isMutating: false, isError: false, readCount: 2, maxReads: MAX }));
  check("singleToolDecision is pure (no hidden state)", a === b, a + " vs " + b);
}

// ── the read→act nudge must actually be wired into the loop ──────────────
check("Single mode nudges the model to act after a read",
  /\[SINGLE MODE\] That was a read\. Now ACT/.test(SRC));
check("the nudge escalates as the read budget runs out",
  /\[SINGLE MODE\] You have/.test(SRC));
check("a mutation is NOT nudged (it is the end of the turn)",
  /loopMode === "single" && !isTeamMember && !isErr && !mutatesNow/.test(SRC));
check("the read cap surfaces a banner instead of dying silently",
  /Single mode stopped after reads/.test(SRC));

// ── the mode selector must not lie for team runs ─────────────────────────
// execMode() returns "single" for every team member, so team mode is exempt
// from the single-mode break; otherwise a planner stops after its first read
// and never sees the ROLE VIOLATION feedback the gate sends back.
check("team members are exempt from the single-mode break",
  /if \(loopMode === "single" && !isTeamMember\)/.test(SRC));

// ── dead config must not come back ───────────────────────────────────────
check("EXEC_MAX_TURNS no longer carries a dead `single` entry",
  !/EXEC_MAX_TURNS = \{[^}]*single:/.test(SRC));

console.log("\n" + pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
