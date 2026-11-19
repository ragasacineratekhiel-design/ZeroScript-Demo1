// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/core/dom_watch.js — shared DOM-change wakeups.
//
// WHY THIS FILE EXISTS (4.7.0): the 4.6.0 helper inside main.js ran EVERY
// registered waiter on EVERY mutation of the whole document. While a chat site
// streams, React re-renders per token — hundreds of mutations a second — so each
// token resolved every waiter, re-entered the response watcher, and woke waiters
// that were watching a completely different element. It was also untestable:
// closed over by a 5 600-line IIFE, so any test had to slice source text.
//
// This module owns exactly one document-wide MutationObserver and provides:
//   • waitForDOMChange(timeout, scope) — batch-coalesced, region-filtered
//   • waitFor(pred, timeout)           — predicate poll that wakes on change
//   • onDomChange(fn)                  — cheap subscription for other modules
//
// It never throws into a caller: a broken observer degrades to plain polling.
(function () {
  "use strict";

  // A reporter that itself fails must not throw into the observer, but it must
  // not vanish either — verify.js (rightly) rejects empty catch blocks, so the
  // failure is counted here and exposed through stats().
  let reportFailures = 0;
  const seen = (tag, e) => {
    try {
      if (globalThis.ZSSafe && typeof globalThis.ZSSafe.seen === "function") { globalThis.ZSSafe.seen(tag, e); return; }
      reportFailures++;
    } catch (_e) { reportFailures++; }
  };

  let observer = null;
  let scheduled = false;
  let records = [];
  const waiters = new Set();
  const subscribers = new Set();

  // Resolve the constructor explicitly. In a content script `MutationObserver` is
  // a page global, but this module is also loadable in a test harness (and any
  // future MAIN-world block) where the global is not on the bare scope — the
  // 4.7.0 draft threw "MutationObserver is not defined" and silently degraded
  // every wait to a timeout. Resolved per call so a polyfill installed later wins.
  function moCtor() {
    try {
      if (typeof MutationObserver === "function") return MutationObserver;
      if (typeof window !== "undefined" && typeof window.MutationObserver === "function") return window.MutationObserver;
      if (typeof globalThis !== "undefined" && typeof globalThis.MutationObserver === "function") return globalThis.MutationObserver;
    } catch (_e) { seen("domwatch.moCtor", _e); }
    return null;
  }

  function ensureObserver() {
    if (observer) return observer;
    const MO = moCtor();
    if (!MO) return null;              // no observer: waitForDOMChange falls back to its timer
    try {
      observer = new MO((batch) => {
        if (typeof document === "undefined" || !document || document.hidden) return;
        // Keep the batch so region-scoped waiters can decide, then coalesce the
        // whole burst into one microtask round.
        if (records.length < 2000) for (const r of batch) records.push(r);
        if (scheduled) return;
        scheduled = true;
        (typeof queueMicrotask === "function" ? queueMicrotask : (f) => Promise.resolve().then(f))(flush);
      });
      observer.observe(document.documentElement || document.body, {
        childList: true, subtree: true, characterData: true,
      });
      try {
        window.addEventListener("pagehide", () => {
          try { observer && observer.disconnect(); } catch (_e) { seen("domwatch.release", _e); }
          observer = null;
          waiters.clear();
          subscribers.clear();
        }, { once: true });
      } catch (_e) { seen("domwatch.release", _e); }
    } catch (_e) { seen("domwatch.observe", _e); }
    return observer;
  }

  function touched(scope, batch) {
    if (!scope) return true;
    for (const r of batch) {
      const t = r.target;
      if (!t) continue;
      try {
        if (t === scope) return true;
        if (t.nodeType === 1 && t.contains && t.contains(scope)) return true;
        if (scope.contains && scope.contains(t)) return true;
      } catch (_e) { return true; }   // unknown topology: wake rather than starve
    }
    return false;
  }

  function flush() {
    scheduled = false;
    const batch = records;
    records = [];
    // Collect first, then run: a waiter that re-registers cannot be starved.
    const ready = [];
    for (const w of waiters) {
      if (w.done) continue;
      if (w.scope && !touched(w.scope, batch)) continue;
      ready.push(w);
    }
    for (const w of ready) {
      w.done = true;
      waiters.delete(w);
      try { w.resolve(true); } catch (_e) { seen("domwatch.resolve", _e); }
    }
    for (const fn of [...subscribers]) {
      try { fn(batch); } catch (_e) { seen("domwatch.subscriber", _e); }
    }
  }

  /** Subscribe to coalesced DOM-change rounds. Returns an unsubscribe function. */
  function onDomChange(fn) {
    if (typeof fn !== "function") return () => {};
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  /**
   * Resolve true on the next DOM change — optionally only within `scope`
   * (an Element or a CSS selector). Resolves false on timeout.
   */
  function waitForDOMChange(timeout = 250, scope) {
    ensureObserver();
    return new Promise((resolve) => {
      let el = null;
      if (scope) {
        try { el = typeof scope === "string" ? document.querySelector(scope) : scope; } catch (_e) { el = null; }
      }
      const waiter = { resolve, scope: el, done: false };
      const timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        waiters.delete(waiter);
        resolve(false);
      }, timeout);
      const real = waiter.resolve;
      waiter.resolve = (v) => { clearTimeout(timer); real(v); };
      waiters.add(waiter);
    });
  }

  /**
   * Wait for `pred` to become truthy, waking on DOM change instead of on a clock.
   * The 4.6.0 version slept 5 ms in a loop: a 20 s wait burned ~4 000 timer
   * wakeups, each interrupting the response watcher. A 50 ms floor is kept so a
   * predicate that depends on something OTHER than the DOM (a network flag, a
   * timer) still gets polled.
   */
  async function waitFor(pred, timeout) {
    const deadline = Date.now() + Math.max(0, timeout);
    while (Date.now() < deadline) {
      try { if (pred()) return true; } catch (_e) { seen("domwatch.predicate", _e); }
      const left = deadline - Date.now();
      if (left <= 0) break;
      const slice = Math.min(50, left);
      await Promise.race([waitForDOMChange(slice), sleep(slice)]);
    }
    try { return !!pred(); } catch (_e) { return false; }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Diagnostics: how many waiters/subscribers are registered right now. */
  function stats() { return { waiters: waiters.size, subscribers: subscribers.size, observing: !!observer, reportFailures }; }

  const api = { version: "4.8.2", waitForDOMChange, waitFor, onDomChange, stats, ensureObserver };
  window.ZSDomWatch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
