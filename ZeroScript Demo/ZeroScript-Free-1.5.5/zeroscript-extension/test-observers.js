// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-observers.js — regression suite for observer
// lifecycle in providers/qwen.js.
//
// Two real defects this locks down:
//   #L1 the provider installed two document-wide MutationObservers and never
//        disconnected either. A content script outliving its navigation kept
//        both alive for the life of the tab.
//   #L2 the code observer re-scanned EVERY code block in the conversation on
//        EVERY mutation. Monaco mutates its DOM many times per streamed token,
//        so one reply produced hundreds of full-document querySelectorAll walks.
//        The provider's own trace comment suspected exactly this.
//
// The test drives the real provider source inside a VM realm with a stub DOM.
// It asserts behaviour, not source text: init() must observe, a burst of
// mutations must collapse into a single scan, and pagehide must disconnect.
// A run against the pre-fix file reported 200 scans and 0 disconnects.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = __dirname;
const SRC = fs.readFileSync(path.join(EXT, "providers", "qwen.js"), "utf8");

let pass = 0, failed = 0;
// In a test harness a throw from the code under test must be a FAILURE, not a
// swallowed catch. Every callback invocation below records here instead.
const callbackErrors = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// ── stub DOM ────────────────────────────────────────────────────────────────
const log = { observes: 0, disconnects: 0, domQueries: 0, pagehide: [] };
const live = [];

function stubEl() {
  const el = {
    nodeType: 1, dataset: {}, style: {}, hidden: false, children: [], textContent: "", innerHTML: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector: () => null,
    querySelectorAll: () => { log.domQueries++; return []; },
    getAttribute: () => null, setAttribute() {}, removeAttribute() {},
    append() {}, appendChild() {}, remove() {}, insertAdjacentHTML() {}, replaceChildren() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {}, dispatchEvent() {},
    matches: () => false, closest: () => null, contains: () => false,
    cloneNode() { return stubEl(); },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
  return el;
}

function StubObserver(cb) { this.cb = cb; this.live = false; }
StubObserver.prototype.observe = function () { this.live = true; log.observes++; live.push(this); };
StubObserver.prototype.disconnect = function () { if (this.live) log.disconnects++; this.live = false; };
StubObserver.prototype.takeRecords = function () { return []; };

const doc = stubEl();
doc.body = stubEl();
doc.documentElement = stubEl();
doc.hidden = false;
doc.readyState = "complete";
doc.getElementById = () => null;
doc.createElement = () => stubEl();
doc.createTextNode = (t) => ({ nodeType: 3, textContent: t });
// Real listener registry: the provider's catch-up path is a `visibilitychange`
// listener, so a no-op stub would make that behaviour untestable.
const docListeners = new Map();
doc.addEventListener = (ev, fn) => {
  if (!docListeners.has(ev)) docListeners.set(ev, []);
  docListeners.get(ev).push(fn);
};
doc.removeEventListener = (ev, fn) => {
  const arr = docListeners.get(ev);
  if (arr) { const i = arr.indexOf(fn); if (i !== -1) arr.splice(i, 1); }
};
const dispatchDoc = (ev) => { for (const fn of (docListeners.get(ev) || []).slice()) fn({ type: ev }); };
doc.getSelection = () => ({ removeAllRanges() {}, addRange() {}, toString: () => "" });
doc.createRange = () => stubEl();
doc.execCommand = () => true;

const timers = [];
const sandbox = {
  console, Date, Math, JSON, Promise, URL, URLSearchParams, TextDecoder,
  document: doc,
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1] = null; },
  setInterval: () => 0,
  clearInterval: () => {},
  MutationObserver: StubObserver,
  performance: { now: () => Date.now() },
  chrome: {
    runtime: {
      id: "test", getManifest: () => ({ version: "4.7.0" }),
      sendMessage: () => {}, onMessage: { addListener() {} },
    },
    storage: { local: { get: (k, cb) => cb && cb({}), set: (v, cb) => cb && cb() } },
  },
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  location: { href: "https://chat.qwen.ai/", hostname: "chat.qwen.ai" },
  navigator: { userAgent: "test", clipboard: { writeText: async () => {} } },
  history: { pushState() {}, replaceState() {} },
  innerWidth: 1200,
  requestAnimationFrame: () => 0,
  Event: function () {}, KeyboardEvent: function () {}, CustomEvent: function () {},
};
sandbox.window = sandbox;
sandbox.window.addEventListener = (ev, fn) => { if (ev === "pagehide") log.pagehide.push(fn); };
sandbox.window.removeEventListener = () => {};
sandbox.window.getComputedStyle = () => ({ getPropertyValue: () => "" });
sandbox.window.open = () => {};
for (const k of ["HTMLTextAreaElement", "HTMLInputElement", "HTMLElement", "Element", "Node", "EventTarget"]) {
  sandbox[k] = function () {};
  sandbox.window[k] = sandbox[k];
}
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let loaded = true;
try { vm.runInContext(SRC, sandbox, { filename: "qwen.js" }); }
catch (e) { loaded = false; console.log("load failed:", e.message); }

check("providers/qwen.js evaluates in a stub DOM realm", loaded,
  "every assertion below depends on the module actually loading");
if (!loaded) { console.log(`\n${pass} passed, ${failed} failed`); process.exit(1); }

// `const ZSProvider = (() => …)()` is a LEXICAL binding — it is not a property
// of the global object, so it must be read by evaluating in the same realm.
const P = vm.runInContext("typeof ZSProvider !== 'undefined' ? ZSProvider : null", sandbox);
check("exports a provider with init() v4.7.0", !!(P && typeof P.init === "function" && P.version === "4.7.0"));

// ── init installs both observers ────────────────────────────────────────────
P.init({});
check("init() starts both document observers", log.observes === 2, `observed ${log.observes}`);
check("no pagehide handler existed before the fix would be a leak", log.disconnects === 0);

// ── a mutation burst must collapse into ONE scan ────────────────────────────
log.domQueries = 0;
for (let i = 0; i < 200; i++) {
  for (const o of live) {
    if (!o.live) continue;
    try { o.cb([{ addedNodes: [], type: "characterData", target: {} }]); }
    catch (e) { callbackErrors.push("mutation: " + e.message); }
  }
}
// flush coalesced work (the 0ms task)
for (const t of timers.slice()) {
  if (typeof t !== "function") continue;
  try { t(); } catch (e) { callbackErrors.push("timer: " + e.message); }
}
const perBurst = log.domQueries;
check("200 mutations collapse into a single full-DOM scan", perBurst === 1,
  `ran ${perBurst} scans; the pre-fix provider ran one per mutation`);

// ── pagehide releases both ──────────────────────────────────────────────────
check("pagehide handler is registered", log.pagehide.length === 1);
log.pagehide.forEach((fn) => {
  try { fn(); } catch (e) { callbackErrors.push("pagehide release: " + e.message); }
});
check("pagehide disconnects both observers", log.disconnects === 2, `disconnected ${log.disconnects}`);
check("no observer is still live after release", live.every((o) => !o.live));

// ── a hidden tab must not scan on mutation ─────────────────────────────────
// Re-init after release installs fresh observers. Its seed pass is intentional
// and happens once, so the counter is reset AFTER init: what is under test is
// only whether a mutation burst scans while the tab is hidden.
doc.hidden = true;
P.init({ isRepeat: true });
const liveNow = live.filter((o) => o.live);
const beforeHidden = log.domQueries;
for (let i = 0; i < 50; i++) {
  for (const o of liveNow) { try { o.cb([{ addedNodes: [], type: "childList" }]); }
    catch (e) { callbackErrors.push("mutation: " + e.message); } }
}
for (const t of timers.slice()) {
  if (typeof t !== "function") continue;
  try { t(); } catch (e) { callbackErrors.push("timer: " + e.message); }
}
check("a hidden tab does not scan on mutation", log.domQueries === beforeHidden,
  `ran ${log.domQueries - beforeHidden} scan(s) while document.hidden was true`);

// Becoming visible again must run exactly one catch-up pass, so nothing that
// changed while hidden is left un-cached.
doc.hidden = false;
const beforeVisible = log.domQueries;
dispatchDoc("visibilitychange");
const catchUp = log.domQueries - beforeVisible;
check("returning to a visible tab runs a catch-up scan", catchUp >= 1,
  `ran ${catchUp} scan(s); a 0 here would mean code blocks written while hidden stay un-cached`);

// ── init must be idempotent ────────────────────────────────────────────────
// main.js may re-init on SPA navigation. If each call added another pair of
// observers, the "fix" would trade a leak on unload for a leak per navigation.
const before3 = log.observes;
P.init({ isRepeat: true });
P.init({ isRepeat: true });
check("repeated init() does not stack observers", log.observes === before3,
  `${log.observes - before3} extra observe() call(s) from two more init() calls`);
check("exactly two observers are live after re-init",
  live.filter((o) => o.live).length === 2, `${live.filter((o) => o.live).length} live`);

// nothing the provider did may have thrown
check("no observer callback or release path threw", callbackErrors.length === 0,
  callbackErrors.slice(0, 3).join(" | "));

console.log(`\n${pass} passed, ${failed} failed`);
if (failed) process.exit(1);
