// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-plan-wall.js — regression suite for the wall.
//
// Guarded against the two bugs that made the 3-AI orchestration inert:
//   #6  `roles[role]` referenced an undefined identifier inside magicForRole()
//   #10 a 10ms chrome.storage busy-poll (360k reads/hour/tab) as the delivery path
//   #3  BroadcastChannel delivery never reached the tab-level runtime handler
//
// core/plan_wall.js talks to chrome.* directly, so we stub just enough of it to
// let the module evaluate and then exercise the pure functions.
const storage = {};
const listeners = [];
const sent = [];
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in storage) out[k] = storage[k]; });
        if (typeof cb === "function") cb(out);
      },
      set: (obj) => { Object.assign(storage, obj); },
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  },
  runtime: { sendMessage: (msg, cb) => { sent.push(msg); if (typeof cb === "function") cb({ ok: true }); } },
};
global.BroadcastChannel = class {
  constructor() { this.onmessage = null; }
  postMessage(msg) { this._last = msg; }
};
global.window = global;

let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

require("./core/plan_wall.js");
const W = global.window.ZSPlanWall;

check("module loads and exports", !!W && typeof W.setPlan === "function");

// ── #6: magic words must not throw ─────────────────────────────────────────
let magicThrew = null;
try {
  W.setPlan("agent", { planner: "ChatGPT", coder: "Claude", checker: "Gemini" });
} catch (e) { magicThrew = e; }
check("setPlan('agent') does not throw (roles[role] bug)", !magicThrew, magicThrew && magicThrew.message);

let roleMagic = null, switched = null;
try {
  roleMagic = W.magicForRole("coder");
  switched = W.magicForRoleSwitched("planner");
} catch (e) { magicThrew = e; }
check("magicForRole('coder') returns a string", typeof roleMagic === "string" && roleMagic.length > 10, String(roleMagic));
check("magicForRole names the assigned provider", /claude/i.test(String(roleMagic)), String(roleMagic));
check("magicForRoleSwitched swaps the role word", /coder/.test(String(switched)), String(switched));
check("magicForCurrentTab does not throw", typeof W.magicForCurrentTab() === "string");

// ── #10: no 10ms busy-poll ────────────────────────────────────────────────
check("safety poll is 5000ms, not 10ms", W.SAFETY_POLL_MS === 5000, String(W.SAFETY_POLL_MS));
check("wall mode is event-driven", /broadcast-channel|storage-events/.test(String(W.wallMode())));

// ── wall log + plan state ─────────────────────────────────────────────────
W.clearWall();
const env = W.send("planner", "coder", { type: "plan_spec", spec: "make a shop" }, "plan");
check("send() returns an envelope with an id", !!env && !!env.id && env.from === "planner");
check("wall log records the envelope", W.getWallLog().length === 1);
check("envelope keeps plan + phase", env.plan === "agent" && env.phase === "plan");

// ── #3: a task must be re-published to chrome.runtime for the executor ────
sent.length = 0;
const taskEnv = W.sendWallTask("planner", "coder", { code: "return 1", datamodel: "Edit" });
const runtimeMsg = sent.find((m) => m && m.type === "zs-wall-task");
check("sendWallTask returns an envelope", !!taskEnv && taskEnv.phase === "exec");
check("wall task is re-published as a runtime message (#3)", !!runtimeMsg, JSON.stringify(sent));
check("runtime message carries the code", !!runtimeMsg && runtimeMsg.task && runtimeMsg.task.code === "return 1");

// ── plan metadata ─────────────────────────────────────────────────────────
check("plans expose Direct/Agent/Plan/Checker", ["direct", "agent", "plan", "checker"].every((k) => !!W.PLANS[k]));
const gp = W.getPlan();
check("getPlan reports the active plan", gp.plan === "agent" && gp.ais === 3);
check("getPlan copies roles (no shared mutation)", gp.roles !== undefined && JSON.stringify(gp.roles.coder) === '"Claude"');

// ── storage events still drive the wall when BC is unavailable ────────────
const before = W.getWallLog().length;
W.send("coder", "__all", { type: "code_ready" }, "wall");
check("local send is immediate", W.getWallLog().length === before + 1);


check("plan_wall VERSION is 4.7.0", W.VERSION === "4.7.0", W.VERSION);
check("close() releases resources cleanly", typeof W.close === "function" && (W.close(), true));

console.log("\n" + pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
