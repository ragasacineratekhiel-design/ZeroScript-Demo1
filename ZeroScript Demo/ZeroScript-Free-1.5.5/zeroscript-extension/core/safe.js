// SPDX-License-Identifier: GPL-3.0-or-later
// core/safe.js — ZeroScript 4.3.0 SAFE-ERROR CORE
//
// WHY THIS FILE EXISTS (audit #27, and the "392 empty catches" follow-up)
// -----------------------------------------------------------------------
// The 4.2.0/4.3.0 code had 392 `catch {}` blocks with nothing in them. On its
// own an empty catch is not a bug — DOM probing on 20 third-party sites throws
// constantly and retrying is correct. The bug was that ALL of them looked the
// same, so the ones that mattered were indistinguishable from the ones that
// did not. Real failures that were provably swallowed this way:
//
//   * bridge.py `/api/agent_temp` 404'd into an empty catch — every temp-agent
//     write silently vanished (fixed, but nothing would have noticed a relapse);
//   * `chrome.storage` quota errors vanished, so settings looked saved and were
//     not;
//   * a provider that threw on every poll looked identical to a provider that
//     worked, because both produced "no state change".
//
// THE MODEL
// ---------
// Every failure is now one of three things, decided by the CALLER, not guessed:
//
//   expected()  — a probe that is SUPPOSED to fail sometimes (element not
//                 found, site not ready, storage in a sandbox). Counted in a
//                 cheap rolling counter. No log spam, no behaviour change.
//                 After a suspicious run of failures it escalates once.
//   wrap()      — a call that should succeed and whose failure the user must be
//                 told about. Recorded as a real fault and surfaced.
//   guard()     — sugar for "try, and on failure return this default".
//
// Faults are bounded (a ring buffer), deduplicated by site, and reachable from
// the diagnostic surface, so "nothing happened" can be told apart from
// "everything is silently broken".
//
// This module deliberately has ZERO dependencies and never throws: a failure
// reporter that can throw is worse than no reporter at all.
(() => {
  "use strict";
  const VERSION = "4.8.0";

  const MAX_FAULTS = 40;        // ring size; bounded on purpose
  const MAX_SITES = 512;        // distinct expected() sites we track (392 call sites today)
  const ESCALATE_AFTER = 25;    // consecutive expected() failures before 1 report
  const CLOCK_WINDOW_MS = 1500; // a fault repeated in this window is one fault
  const REPORT_COALESCE_MS = 8000;

  /** @type {Array<{at:number,site:string,message:string,level:string,count:number}>} */
  const faults = [];
  /** @type {Map<string,{n:number,last:number,reported:number}>} */
  const expectedSites = new Map();
  let lastReportAt = 0;
  let reportCount = 0;

  const now = () => {
    try { return Date.now(); } catch { return 0; }
  };

  // ── error → short, de-identified message ────────────────────────────────
  // Never leaks a token, a full URL query, or a stack trace into a log the
  // user may paste into an issue. Keeps the message, strips the noise.
  const describe = (e) => {
    try {
      if (e == null) return "unknown error";
      let msg;
      if (typeof e === "string") msg = e;
      else if (typeof e.message === "string" && e.message) msg = e.message;
      else if (e.name === "TimeoutError" || e.name === "AbortError") msg = e.name;
      else {
        try { msg = String(e); } catch { msg = "unprintable error"; }
      }
      return String(msg)
        .replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>")  // tokens / ids
        .replace(/([?&](?:token|key|auth|sig)=)[^&\s]*/gi, "$1<redacted>")
        .replace(/\s+/g, " ")
        .slice(0, 240);
    } catch {
      return "unrepresentable error";
    }
  };

  // ── the real fault recorder ─────────────────────────────────────────────
  const record = (site, e, level) => {
    try {
      const at = now();
      const message = describe(e);
      const key = String(site || "?");
      // collapse a burst of identical faults into one row with a count
      for (let i = faults.length - 1; i >= 0 && i >= faults.length - 6; i--) {
        const f = faults[i];
        if (f.site === key && f.message === message && at - f.at < CLOCK_WINDOW_MS) {
          f.count++;
          f.at = at;
          return f;
        }
      }
      const row = { at, site: key, message, level: level || "error", count: 1 };
      faults.push(row);
      // bounded ring — drop from the front, never grow without limit
      while (faults.length > MAX_FAULTS) faults.shift();
      return row;
    } catch {
      return null; // reporting must never be the thing that breaks the page
    }
  };

  // ── surface to the user (extension context), throttled ──────────────────
  // Content scripts have no chrome.runtime access on some hosts, and tests have
  // no chrome at all, so every path here is optional.
  const report = (fault) => {
    try {
      const at = now();
      if (at - lastReportAt < REPORT_COALESCE_MS) return;
      lastReportAt = at;
      reportCount++;
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[zs:safe]", fault ? `${fault.site}: ${fault.message}` : "fault");
      }
      // Tell the background worker only when a real channel exists.
      if (typeof chrome !== "undefined" && chrome && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({ type: "zs_fault", site: fault.site, message: fault.message, level: fault.level },
            () => { void (chrome.runtime && chrome.runtime.lastError); }); // read lastError, or Chrome logs an unchecked error
        } catch { /* worker asleep or no channel — the ring still holds it */ }
      }
    } catch { /* never throw from reporting */ }
  };

  // ── expected(): a probe that is allowed to fail ─────────────────────────
  // Returns false on failure. Counts silently; escalates exactly once per
  // ESCALATE_AFTER consecutive failures so a permanently-broken probe becomes
  // visible instead of being invisible forever.
  const expected = (site, fn, onFail) => {
    try {
      const v = typeof fn === "function" ? fn() : fn;
      if (v !== false && v !== undefined) {
        // success resets the streak so unrelated successes are not punished
        try {
          const s = expectedSites.get(String(site));
          if (s) { s.n = 0; s.horizon = ESCALATE_AFTER; }
        } catch { /* ignore */ }
        return true;
      }
      return seenFail(site, onFail);
    } catch (e) {
      return seenFail(site, onFail, e);
    }
  };

  const seenFail = (site, onFail, e) => {
    try {
      const key = String(site || "?");
      let s = expectedSites.get(key);
      if (!s) {
        if (expectedSites.size >= MAX_SITES) {
          // bounded: drop the oldest insertion rather than grow forever
          try { expectedSites.delete(expectedSites.keys().next().value); } catch { /* ignore */ }
        }
        s = { n: 0, last: 0, horizon: ESCALATE_AFTER };
        expectedSites.set(key, s);
      }
      s.n++;
      s.last = now();
      if (onFail) { try { onFail(e); } catch { /* a caller's onFail must not break us */ } }
      // Report at 25, then 50, 100, 200… — a doubling horizon. A permanently
      // broken probe therefore stays visible forever without logging every call.
      if (s.n >= s.horizon) {
        s.horizon = s.n * 2;
        const f = record(key, e || new Error(`repeated failure x${s.n}`), "warn");
        if (f) report(f);
      }
      return false;
    } catch {
      return false;
    }
  };

  // ── seen(): the drop-in body for a `catch` that used to be empty ────────
  // Semantically identical to `catch {}` — nothing is rethrown, nothing is
  // returned — but the failure is now counted per call site. Cheap enough to
  // sit inside DOM polling on 20 sites: one Map lookup and two integer writes.
  const seen = (site, e) => seenFail(site, null, e);

  // ── retry(): the one thing an empty catch should never have replaced ────
  // Jittered exponential backoff for bridge HTTP / extension messaging, where
  // the FIRST attempt failing is normal (service worker asleep) and giving up
  // immediately was the bug. Only the FINAL failure is reported.
  const retry = async (site, fn, opts) => {
    const tries = Math.max(1, Math.min(5, (opts && opts.tries) || 3));
    const baseMs = Math.max(10, (opts && opts.baseMs) || 120);
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn(i);
      } catch (e) {
        last = e;
        if (i === tries - 1) break;
        const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * baseMs);
        await new Promise((r) => {
          try { setTimeout(r, wait); } catch { r(); }
        });
      }
    }
    const f = record(site, last, "error");
    if (f) report(f);
    if (opts && typeof opts.onFail === "function") {
      try { opts.onFail(last); } catch { /* ignore */ }
    }
    return undefined;
  };

  // ── wrap(): a call that should work; failure is a real fault ────────────
  const wrap = (site, fn, onFail) => {
    try {
      return fn();
    } catch (e) {
      const f = record(site, e, "error");
      if (f) report(f);
      if (typeof onFail === "function") { try { onFail(e); } catch { /* ignore */ } }
      return undefined;
    }
  };

  const wrapAsync = async (site, fn, onFail) => {
    try {
      return await fn();
    } catch (e) {
      const f = record(site, e, "error");
      if (f) report(f);
      if (typeof onFail === "function") { try { onFail(e); } catch { /* ignore */ } }
      return undefined;
    }
  };

  // ── guard(): try, and on failure return a default (type-safe) ───────────
  // guard("site", () => el.value, "")  → always returns a string
  const guard = (site, fn, fallback) => {
    try { return fn(); } catch (e) { seenFail(site, null, e); return fallback; }
  };

  // ── diagnostics ────────────────────────────────────────────────────────
  const stats = () => {
    try {
      let total = 0;
      const worst = [];
      for (const [site, s] of expectedSites) {
        total += s.n;
        if (s.n > 0) worst.push({ site, failures: s.n, last: s.last });
      }
      worst.sort((a, b) => b.failures - a.failures);
      return {
        version: VERSION,
        faults: faults.length,
        faultReports: reportCount,
        expectedSites: expectedSites.size,
        expectedFailures: total,
        worst: worst.slice(0, 5),
        recent: faults.slice(-8).map((f) => ({ site: f.site, message: f.message, level: f.level, count: f.count })),
      };
    } catch {
      return { version: VERSION, faults: 0, expectedSites: 0, expectedFailures: 0, worst: [], recent: [] };
    }
  };

  const clear = () => {
    try { faults.length = 0; expectedSites.clear(); } catch { /* ignore */ }
  };

  const safe = {
    version: VERSION,
    expected, wrap, wrapAsync, guard, seen, retry,
    record, describe, report, stats, clear,
    // A probe that must never change behaviour: run it, ignore the outcome.
    probe: (site, fn) => { expected(site, fn); },
  };

  // ── attach everywhere this script can run ──────────────────────────────
  try { if (typeof window !== "undefined") window.ZSSafe = safe; } catch { /* no window */ }
  try { if (typeof self !== "undefined") self.ZSSafe = safe; } catch { /* no self */ }
  try { if (typeof globalThis !== "undefined") globalThis.ZSSafe = safe; } catch { /* no globalThis */ }
  try { if (typeof module !== "undefined" && module.exports) module.exports = safe; } catch { /* no CJS */ }
})();
