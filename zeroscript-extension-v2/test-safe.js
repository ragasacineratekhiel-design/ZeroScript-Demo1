// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-safe.js — regression suite for core/safe.js.
//
// These assertions exist because the extension shipped 392 `catch {}` blocks.
// The danger of "fixing" them is making things WORSE in one of three ways:
//   1. a missing global turns 392 silent catches into 392 throwing ones;
//   2. a probe that legitimately fails 400x/second floods the console;
//   3. the reporter itself throws and breaks the page it was meant to protect.
// Each of those is asserted against below.
const S = require("./core/safe.js");
let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// silence the intentional console.warn output of escalation tests
const realWarn = console.warn;
let warned = 0;
console.warn = () => { warned++; };

// ── the drop-in body must never throw, even with the module absent ─────────
check("seen() accepts a normal Error", (() => { S.seen("t", new Error("x")); return true; })());
check("seen() accepts undefined", (() => { S.seen("t", undefined); return true; })());
check("seen() accepts a string", (() => { S.seen("t", "boom"); return true; })());
check("seen() accepts null", (() => { S.seen("t", null); return true; })());
check("seen() survives an object whose toString throws", (() => {
  const o = { toString() { throw new Error("nope"); } };
  S.seen("t", o);
  return true;
})());
check("seen() survives a Proxy that throws on get", (() => {
  S.seen("t", new Proxy({}, { get() { throw new Error("trap"); } }));
  return true;
})());
check("seen() without a site still works", (() => { S.seen(); return true; })());

// ── expected(): silent until a suspicious streak, then escalates ONCE ─────
S.clear();
for (let i = 0; i < 24; i++) S.expected("probe.a", () => false);
check("expected() is silent for the first 24 failures (no log spam)", S.stats().faults === 0);
const before = warned;
S.expected("probe.a", () => false);
check("expected() escalates exactly once at 25", S.stats().faults === 1 && warned === before + 1);
for (let i = 0; i < 200; i++) S.expected("probe.a", () => false);
check("expected() does not spam past the threshold (doubling horizon)", S.stats().faults <= 5, "faults=" + S.stats().faults);

// ── a success resets the streak, so transient sites are not punished ─────
S.clear();
for (let i = 0; i < 20; i++) S.expected("probe.b", () => false);
S.expected("probe.b", () => true);
for (let i = 0; i < 20; i++) S.expected("probe.b", () => false);
check("success resets the failure streak", S.stats().faults === 0);

// ── expected() returns the truth so callers can branch on it ─────────────
check("expected() returns true on success", S.expected("p", () => 1) === true);
check("expected() returns false when fn returns false", S.expected("p", () => false) === false);
check("expected() returns false when fn throws", S.expected("p", () => { throw new Error("x"); }) === false);
check("expected() calls onFail", (() => {
  let hit = 0;
  S.expected("p", () => { throw new Error("x"); }, () => hit++);
  return hit === 1;
})());

// ── wrap(): a real fault, recorded and surfaced ──────────────────────────
S.clear();
const r = S.wrap("storage.set", () => { throw new Error("QUOTA_BYTES exceeded"); });
check("wrap() returns undefined instead of throwing", r === undefined);
check("wrap() records a real fault", S.stats().faults === 1);
check("wrap() passes the value through on success", S.wrap("ok", () => 42) === 42);
check("wrap() calls onFail with the error", (() => {
  let seenErr = null;
  S.wrap("x", () => { throw new Error("kaput"); }, (e) => { seenErr = e; });
  return seenErr && seenErr.message === "kaput";
})());

// ── secrets must never reach the diagnostic surface ──────────────────────
S.clear();
S.wrap("auth", () => { throw new Error("bad token abcdefghijklmnopqrstuvwxyz0123456789"); });
S.wrap("auth2", () => { throw new Error("GET /x?token=SECRETVALUE123 failed"); });
const recent = S.stats().recent.map((f) => f.message).join(" ");
check("long tokens are redacted", !/abcdefghijklmnopqrstuvwxyz0123456789/.test(recent), recent);
check("query-string tokens are redacted", !/SECRETVALUE123/.test(recent), recent);
check("the useful part of the message survives", /bad token/.test(recent));

// ── bursts collapse so one broken button is one row ──────────────────────
S.clear();
for (let i = 0; i < 6; i++) S.wrap("click", () => { throw new Error("same failure"); });
check("a burst collapses into one fault with a count", S.stats().faults === 1 && S.stats().recent[0].count === 6, JSON.stringify(S.stats().recent[0]));

// ── bounded memory: this runs forever on a live page ─────────────────────
S.clear();
for (let i = 0; i < 500; i++) S.wrap("ring" + i, () => { throw new Error("e" + i); });
check("the fault ring is bounded at 40", S.stats().faults === 40, "faults=" + S.stats().faults);
S.clear();
for (let i = 0; i < 900; i++) S.expected("site" + i, () => false);
check("the site table is bounded (does not leak per-DOM-node keys)", S.stats().expectedSites <= 512, "sites=" + S.stats().expectedSites);

// ── guard(): the type-safe probe ─────────────────────────────────────────
check("guard() returns the fallback on throw", S.guard("g", () => { throw new Error("x"); }, "") === "");
check("guard() defaults to undefined", S.guard("g", () => { throw new Error("x"); }) === undefined);
check("guard() returns the value on success", S.guard("g", () => "v", "") === "v");

// ── describe(): always a string, never a stack trace ─────────────────────
for (const v of [null, undefined, "s", 42, {}, [], new Error("m"), Symbol("y"), 10n]) {
  const d = S.describe(v);
  if (typeof d !== "string" || d.length > 240) { check("describe(" + String(typeof v) + ") is a short string", false, JSON.stringify(d)); break; }
}
check("describe() is always a short string", true);
check("describe() never leaks a stack frame", !/at \w+ \(/.test(S.describe(new Error("boom"))));

// ── retry(): the thing an empty catch should never have replaced ─────────
(async () => {
  let n = 0;
  const ok = await S.retry("net", async () => { n++; if (n < 3) throw new Error("worker asleep"); return "done"; }, { tries: 3, baseMs: 5 });
  check("retry() succeeds after transient failures", ok === "done" && n === 3, "n=" + n);
  const bad = await S.retry("net.hard", async () => { throw new Error("down"); }, { tries: 2, baseMs: 5 });
  check("retry() gives up and records one fault", bad === undefined && S.stats().faults >= 1);
  let attempts = 0;
  await S.retry("none", async () => { attempts++; return 1; }, { tries: 3, baseMs: 1 });
  check("retry() does not retry a success", attempts === 1);

  // ── the module must survive being loaded with no browser at all ───────
  check("stats() is always a well-formed object", (() => {
    const s = S.stats();
    return typeof s.faults === "number" && Array.isArray(s.recent) && Array.isArray(s.worst);
  })());
  // read the manifest instead of hardcoding: a hardcoded string silently rots
  const mfVer = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "manifest.json"), "utf8")).version;
  check("version agrees with the manifest", require("./core/safe.js").version === mfVer, `${require("./core/safe.js").version} != ${mfVer}`);

  console.warn = realWarn;
  const total = pass + failed;
  console.log("\n" + pass + "/" + total + " passed" + (failed ? ", " + failed + " FAILED" : ""));
  process.exit(failed ? 1 : 0);
})();
