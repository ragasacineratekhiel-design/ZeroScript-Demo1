// SPDX-License-Identifier: GPL-3.0-or-later
// test-coalescing.js — duplicate in-flight calls must be shared, and only while
// they are actually in flight.
//
// core/main.js coalesces bg() calls with a Map keyed by the message signature.
// The original evicted with `setTimeout(() => delete(key), 5)` while its comment
// claimed 120ms. Both are guesses at "how long is a call", and the measurement
// below shows the direction that mattered: a call still running after 5ms was
// evicted, so a second identical call was issued AGAIN to the bridge. Two
// call_tool messages for one intent means the tool runs twice.
//
// The fix is not a better constant — it is evicting when the promise settles.
// This suite pins both halves: merging while in flight, and re-sending after.
//
// It tests the lifecycle pattern, not main.js's internals, because the internals
// are a closure inside a content script and pulling them out would mean testing
// a copy. The pattern is reproduced exactly as written in main.js.
function makeCoalescer(strategy, latencyMs) {
  const inflight = new Map();
  const state = { sends: 0 };
  const transport = () => { state.sends++; return new Promise((r) => setTimeout(() => r({ ok: true }), latencyMs)); };
  return {
    state,
    size: () => inflight.size,
    call(key) {
      if (inflight.has(key)) return inflight.get(key);
      const p = transport();
      inflight.set(key, p);
      if (strategy === "settle") {
        const clear = () => { if (inflight.get(key) === p) inflight.delete(key); };
        p.then(clear, clear);
      } else {
        setTimeout(() => inflight.delete(key), strategy);
      }
      return p;
    },
  };
}

let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

(async () => {
  // 1. a same-tick burst shares one transport call, under both strategies
  for (const [label, strat] of [["timer", 5], ["settle", "settle"]]) {
    const c = makeCoalescer(strat, 100);
    await Promise.all([c.call("list_tools"), c.call("list_tools"), c.call("list_tools"), c.call("list_tools")]);
    check(`${label}: 4 concurrent identical calls produce 1 send`, c.state.sends === 1,
      c.state.sends + " sends");
  }

  // 2. THE DEFECT: a second identical call 150ms into a 400ms call.
  //    The timer strategy has already forgotten the first one.
  {
    const c = makeCoalescer(5, 400);
    const first = c.call("call_tool");
    await new Promise((r) => setTimeout(r, 150));
    c.call("call_tool");
    check("the pre-fix 5ms timer re-sends a still-running call (this is the bug)",
      c.state.sends === 2, c.state.sends + " sends");
    await first;
  }
  {
    const c = makeCoalescer("settle", 400);
    const first = c.call("call_tool");
    await new Promise((r) => setTimeout(r, 150));
    c.call("call_tool");
    check("settle-based eviction shares a still-running call instead of re-sending",
      c.state.sends === 1, c.state.sends + " sends");
    await first;
  }

  // 3. correctness the other way: a settled call must NOT be reused
  {
    const c = makeCoalescer("settle", 20);
    await c.call("t");
    const before = c.state.sends;
    await c.call("t");
    check("a call after the previous one settled is sent again", c.state.sends === before + 1,
      `${before} -> ${c.state.sends}`);
    check("nothing is left in the map when idle", c.size() === 0, c.size() + " entries");
  }

  // 4. a rejecting call must also be evicted, or the rejection poisons the key
  {
    const inflight = new Map();
    let sends = 0;
    const call = (key) => {
      if (inflight.has(key)) return inflight.get(key);
      sends++;
      const p = Promise.reject(new Error("bridge down"));
      inflight.set(key, p);
      const clear = () => { if (inflight.get(key) === p) inflight.delete(key); };
      p.then(clear, clear);
      return p;
    };
    await call("x").catch(() => {});
    await call("x").catch(() => {});
    check("a failed call does not poison the key", sends === 2, sends + " sends");
    check("a failed call leaves no entry behind", inflight.size === 0, inflight.size + " entries");
  }


  // 5. Real core/transport.js (4.6.0): coalesces status/listTools, never replays callTool/verifyFact
  {
    const fs = require("fs"), path = require("path"), vm = require("vm");
    let wireSends = 0;
    const ctx = {
      console, Date, Math, JSON, Promise, Map, Set, String,
      setTimeout, clearTimeout,
      chrome: {
        runtime: {
          lastError: null,
          sendMessage: (msg, cb) => {
            wireSends++;
            setTimeout(() => cb({ ok: true, connected: true, type: msg.type }), 25);
          },
        },
      },
    };
    ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "core/transport.js"), "utf8"), ctx);
    const T = ctx.ZS_Transport;
    check("ZS_Transport 4.8.0 loads", T && T.VERSION === "4.8.0");
    wireSends = 0;
    await Promise.all([T.status(), T.status(), T.status()]);
    check("ZS_Transport coalesces concurrent status() reads", wireSends === 1, wireSends + " sends");
    T.invalidate("status");
    await T.status();
    check("ZS_Transport.invalidate('status') evicts cached status", wireSends === 2, wireSends + " sends");
  }

  console.log("\n" + pass + " passed, " + failed + " failed");
  if (failed) process.exit(1);
})();
