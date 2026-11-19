// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-dom-watch.js — regression suite for core/dom_watch.js.
//
// WHY: main.js used to resolve EVERY DOM waiter on EVERY document mutation. On a
// streaming chat site (React re-render per token) that meant hundreds of promise
// resolutions a second, each re-entering the response watcher, including waiters
// watching a completely different element. These tests pin the three fixes:
// batched dispatch, region filtering, and O(1) waiter removal.
const { JSDOM } = require("jsdom");
const path = require("path");

const dom = new JSDOM(
  `<!doctype html><html><body><div id="a"></div><div id="b"></div></body></html>`,
  { url: "https://example.com", pretendToBeVisual: true }
);
const w = dom.window;
global.window = w;
global.document = w.document;

let pass = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

require(path.join(__dirname, "core", "dom_watch.js"));
const DW = w.ZSDomWatch;

(async () => {
  check("exports the documented API",
    !!DW && ["waitForDOMChange", "waitFor", "onDomChange", "stats"].every((k) => typeof DW[k] === "function"));
  check("version is 4.8.2", DW.version === "4.8.2", DW.version);

  // ── region filtering ─────────────────────────────────────────────────────
  const all = DW.waitForDOMChange(400);
  const scopedA = DW.waitForDOMChange(400, "#a");
  const elScoped = DW.waitForDOMChange(400, w.document.getElementById("b"));
  w.document.getElementById("b").appendChild(w.document.createElement("span"));
  await wait(25);
  check("an unscoped waiter wakes on any mutation", await all === true);
  check("a selector-scoped waiter ignores an unrelated region",
    await Promise.race([scopedA, wait(60).then(() => "still-waiting")]) === "still-waiting");
  check("an element-scoped waiter wakes for its own region", await elScoped === true);
  w.document.getElementById("a").appendChild(w.document.createElement("p"));
  check("the unrelated-scope waiter still wakes when ITS region changes", await scopedA === true);

  // ── batching ─────────────────────────────────────────────────────────────
  let rounds = 0;
  const off = DW.onDomChange(() => rounds++);
  const target = w.document.getElementById("b");
  const burst = DW.waitForDOMChange(600);
  for (let i = 0; i < 200; i++) target.appendChild(w.document.createElement("i"));
  await burst;
  await wait(40);
  check("a 200-mutation burst produces ONE notification round", rounds === 1, "rounds=" + rounds);
  off();

  // ── timeout, and no waiter leaks ─────────────────────────────────────────
  const before = DW.stats().waiters;
  const t0 = Date.now();
  const timedOut = await DW.waitForDOMChange(60);
  const took = Date.now() - t0;
  check("timeout resolves false", timedOut === false);
  check("timeout honours its deadline", took >= 55 && took < 400, took + "ms");
  check("a timed-out waiter is removed, not leaked", DW.stats().waiters === before, `${before}→${DW.stats().waiters}`);

  // ── waitFor is change-driven, not a 5ms poll ─────────────────────────────
  let calls = 0;
  const flag = { v: false };
  const pending = DW.waitFor(() => { calls++; return flag.v; }, 1000);
  await wait(30);
  const callsBefore = calls;
  flag.v = true;
  w.document.getElementById("a").appendChild(w.document.createElement("b"));
  check("waitFor returns true once the predicate flips", await pending === true);
  check("waitFor does not busy-poll (<= 6 predicate calls in 30ms)", callsBefore <= 6, "calls=" + callsBefore);

  // ── a predicate that throws must not reject the caller ───────────────────
  let threw = false;
  const r = await DW.waitFor(() => { if (!threw) { threw = true; throw new Error("boom"); } return true; }, 300);
  check("a throwing predicate is absorbed and retried", r === true);

  // ── selector that does not exist degrades to "any mutation" ──────────────
  const missing = DW.waitForDOMChange(300, "#does-not-exist");
  w.document.body.appendChild(w.document.createElement("div"));
  check("a missing selector does not hang or throw", await missing === true);

  // ── unsubscribe ──────────────────────────────────────────────────────────
  let n = 0;
  const un = DW.onDomChange(() => n++);
  w.document.body.appendChild(w.document.createElement("section"));
  await wait(30);
  un();
  const seenBefore = n;
  w.document.body.appendChild(w.document.createElement("section"));
  await wait(30);
  check("unsubscribing stops notifications", n === seenBefore, `${seenBefore}→${n}`);

  check("stats() reports no leaked waiters", DW.stats().waiters === 0, JSON.stringify(DW.stats()));

  console.log("\n" + pass + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
