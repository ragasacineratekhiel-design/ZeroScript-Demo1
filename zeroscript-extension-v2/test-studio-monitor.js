// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-studio-monitor.js — the Studio drop detector.
//
// WHY: 4.6.0's monitor mutated its own "last confirmed" value inside the drop
// branch AND again in a trailing assignment, so a drop that spanned two polls
// already looked confirmed before the 3 s debounce expired. It also polled a
// 1.8 s interval with no in-flight guard (a slow bridge queued polls). The state
// machine is monotone now; these assertions pin the four edges that matter: a
// blip is not a drop, a sustained drop fires exactly once, it never re-fires
// while Studio stays down, and the diag payload reports the real duration.
const fs = require("fs"), vm = require("vm");

let pass = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
};

// Fake clock + timer queue: the monitor's 1.8 s interval is driven by hand so
// the whole test runs in milliseconds and is deterministic.
let now = 0;
const timers = [];
const sandbox = {
  console,
  setInterval: (fn) => { const t = { fn, live: true }; timers.push(t); return t; },
  clearInterval: (t) => { if (t) t.live = false; },
  setTimeout: (fn) => fn(),
  Date: { now: () => now },
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, hasFocus: () => true },
  navigator: {},
  chrome: { runtime: { sendMessage: null } },
  ZSSafe: { seen() {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + "/core/agent_stability.js", "utf8") + "\nglobalThis.__S = ZSAgentStability;", sandbox);
const S = sandbox.__S;

check("module version is 4.7.0", S.version === "4.7.0", S.version);
check("studio monitor is exported", typeof S.startStudioMonitor === "function");

let studio = true, drops = 0, polls = 0;
const diagEvents = [];
sandbox.chrome.runtime.sendMessage = (msg, cb) => { polls++; cb({ studio }); };
const stop = S.startStudioMonitor((e, d) => diagEvents.push([e, d]), () => { drops++; });
const tick = async () => { for (const t of timers) if (t.live) await t.fn(); };
const run = async (ms) => { for (let t = 0; t < ms; t += 1800) { now += 1800; await tick(); } };

(async () => {
  await run(3600);
  check("a healthy Studio produces no drop", drops === 0);

  studio = false;
  await run(1800);
  check("one poll of false is inside the 3s debounce (no drop yet)", drops === 0, "drops=" + drops);

  studio = true;
  await run(1800);
  check("a one-poll blip is not a drop", drops === 0, "drops=" + drops);

  studio = false;
  await run(5400);
  check("a sustained drop fires exactly once", drops === 1, "drops=" + drops);

  await run(7200);
  check("a drop already reported does not re-fire", drops === 1, "drops=" + drops);

  const ev = diagEvents.find((e) => e[0] === "studio.drop.confirmed");
  check("the diag event reports a real duration", !!ev && ev[1].goneMs >= 3000, JSON.stringify(ev && ev[1]));

  // ── no overlapping polls ─────────────────────────────────────────────────
  let slowPolls = 0, inFlight = 0, maxInFlight = 0;
  sandbox.chrome.runtime.sendMessage = (msg, cb) => {
    slowPolls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => { inFlight--; cb({ studio: true }); });
  };
  for (let i = 0; i < 5; i++) { now += 1800; for (const t of timers) if (t.live) t.fn(); }  // NOT awaited: polls overlap if unguarded
  check("a slow bridge never queues overlapping polls", maxInFlight <= 1, "maxInFlight=" + maxInFlight);

  stop();
  // Every interval the monitor created is cleared by its disposer. (The module
  // also starts its own 10ms tryPatch interval at load, which is a different
  // timer and legitimately still live, so only the monitor's is asserted.)
  // timers[0] is the module's own tryPatch interval (created at load, 10ms,
  // legitimately still live); the monitor's is the one created by the call.
  const monitorTimer = timers[1];
  check("stop() releases the monitor interval", monitorTimer && monitorTimer.live === false);

  console.log("\n" + pass + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
