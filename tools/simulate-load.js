#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// tools/simulate-load.js — loads the extension's modules in a stubbed browser
// environment, in manifest order, for one provider, and reports anything that
// throws. Static checks cannot prove that the wiring works; this at least proves
// that every module initialises, that the globals the next module needs exist,
// and that the public APIs are callable.
//
// It is NOT a substitute for running the extension in Chrome against a live
// Roblox Studio — it cannot render a chat page. It is the cheapest possible
// smoke test for "does the thing boot at all".
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(path.resolve(__dirname, ".."), "zeroscript-extension-v2");
const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

// Pick a site block that loads main.js (chatgpt has the most moving parts).
const blocks = (mf.content_scripts || []).filter((cs) => (cs.js || []).some((f) => /main\.js$/.test(f)));
if (!blocks.length) { console.log("no content-script block loads main.js"); process.exit(1); }

const log = [];
const errors = [];
let LAST_BLOCK_CTX = null;
function stubEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(), nodeType: 1, id: "", className: "", textContent: "", innerText: "",
    innerHTML: "", hidden: false, style: {}, dataset: {}, children: [], childNodes: [], offsetParent: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true; }, click() {}, focus() {}, blur() {},
    querySelector(sel) { return stubEl('div'); }, querySelectorAll() { return []; }, closest() { return null; },
    contains() { return false; }, matches() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 300, height: 40, bottom: 40, right: 300 }; },
    cloneNode() { return stubEl(tag); },
  };
  return el;
}

const storage = {};
const sandbox = {
  console: {
    log: (...a) => log.push(["log", ...a.map(String)]),
    warn: (...a) => log.push(["warn", ...a.map(String)]),
    error: (...a) => log.push(["error", ...a.map(String)]),
    info: () => {}, debug: () => {},
  },
  setTimeout: (fn, ms) => setTimeout(() => { try { fn(); } catch (e) { errors.push("timeout: " + e.message); } }, Math.min(ms || 0, 5)),
  clearTimeout, setInterval: () => 0, clearInterval, queueMicrotask,
  requestAnimationFrame: (fn) => setTimeout(() => { try { fn(performance.now()); } catch (e) { errors.push("raf: " + e.message); } }, 1),
  cancelAnimationFrame() {},
  performance: { now: () => Date.now() },
  location: { hostname: "chatgpt.com", pathname: "/c/123", search: "", href: "https://chatgpt.com/c/123", origin: "https://chatgpt.com", protocol: "https:" },
  navigator: { userAgent: "Mozilla/5.0 (sim)", language: "en-US", clipboard: { writeText: async () => {} } },
  document: {
    documentElement: stubEl("html"), body: stubEl("body"), head: stubEl("head"),
    hidden: false, visibilityState: "visible", title: "ChatGPT",
    contains: () => false, hasFocus: () => true,
    readyState: "complete",
    createElement: (t) => stubEl(t),
    createTextNode: (t) => ({ nodeType: 3, nodeValue: t }),
    createRange: () => ({ selectNodeContents() {}, setStart() {}, setEnd() {}, collapse() {}, cloneContents: () => stubEl() }),
    createTreeWalker: () => ({ nextNode: () => null, currentNode: null, filter: null }),
    querySelector: () => stubEl('div'), querySelectorAll: () => [],
    getElementById: () => stubEl('div'),
    getSelection: () => ({ removeAllRanges() {}, addRange() {}, rangeCount: 0, toString: () => "" }),
    addEventListener() {}, removeEventListener() {},
    execCommand: () => true,
    elementFromPoint: () => null,
    activeElement: null,
    fonts: { ready: Promise.resolve() },
  },
  MutationObserver: class { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } },
  BroadcastChannel: class { constructor(n) { this.name = n; this.onmessage = null; } postMessage() {} close() {} },
  WebSocket: class { constructor() { this.readyState = 0; } send() {} close() {} addEventListener() {} },
  EventSource: class { constructor() { this.readyState = 0; } close() {} addEventListener() {} },
  AbortController: class { constructor() { this.signal = { aborted: false, addEventListener() {} }; } abort() {} },
  TextDecoder: class { decode(v) { return String(v || ""); } },
  TextEncoder: class { encode(v) { return Buffer.from(String(v)); } },
  URL, URLSearchParams,
  fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => "", body: null }),
  chrome: {
    runtime: {
      id: "sim-extension-id",
      lastError: null,
      getManifest: () => mf,
      sendMessage: (msg, cb) => { if (typeof cb === "function") setTimeout(() => cb({ ok: false, error: "sim: no worker" }), 0); },
      onMessage: { addListener() {}, removeListener() {} },
      onConnect: { addListener() {} },
      getURL: (p) => "chrome-extension://sim/" + p,
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : (keys ? Object.keys(keys) : Object.keys(storage));
          for (const k of list) if (k in storage) out[k] = storage[k];
          if (typeof cb === "function") setTimeout(() => cb(out), 0);
          return Promise.resolve(out);
        },
        set: (obj, cb) => { Object.assign(storage, obj); if (typeof cb === "function") setTimeout(cb, 0); return Promise.resolve(); },
        remove: (k, cb) => { delete storage[k]; if (typeof cb === "function") setTimeout(cb, 0); return Promise.resolve(); },
        clear: () => { for (const k of Object.keys(storage)) delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
      sync: { get: (k, cb) => { if (typeof cb === "function") setTimeout(() => cb({}), 0); return Promise.resolve({}); }, set: () => Promise.resolve() },
    },
    tabs: { query: (q, cb) => { if (typeof cb === "function") setTimeout(() => cb([]), 0); return Promise.resolve([]); }, sendMessage: () => Promise.resolve(), update: () => Promise.resolve(), create: () => Promise.resolve() },
    alarms: { create() {}, onAlarm: { addListener() {} }, clear: () => Promise.resolve() },
    action: { setBadgeText() {}, setIcon() {}, onClicked: { addListener() {} } },
  },
  HTMLTextAreaElement: class {}, HTMLInputElement: class {}, HTMLDivElement: class {},
  DOMRect: class {}, Event: class { constructor(t) { this.type = t; } },
  InputEvent: class { constructor(t) { this.type = t; } },
  KeyboardEvent: class { constructor(t) { this.type = t; } },
  ClipboardEvent: class { constructor(t) { this.type = t; } },
  CustomEvent: class { constructor(t) { this.type = t; this.detail = null; } },
  DataTransfer: class { constructor() { this.items = { add() {} }; } },
  File: class { constructor() {} },
  Blob: class {}, FormData: class {},
  atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
  btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
  Image: class {},
  WebAssembly: {},
  WeakMap, WeakSet, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean,
  RegExp, Error, TypeError, Symbol, Reflect, Proxy, Intl, BigInt,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, escape, unescape,
  structuredClone: (o) => JSON.parse(JSON.stringify(o)),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  history: { pushState() {}, replaceState() {}, state: null },
  screen: { width: 1920, height: 1080 },
  innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {}, postMessage() {},
  open: () => null, close() {}, focus() {}, scrollTo() {},
  crypto: { randomUUID: () => "uuid-" + Math.random().toString(16).slice(2) },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  module: undefined,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
function freshContext() {
  const clone = Object.create(null);
  for (const k of Object.keys(sandbox)) clone[k] = sandbox[k];
  clone.window = clone;
  clone.self = clone;
  clone.globalThis = clone;
  return vm.createContext(clone);
}
const ctx = freshContext(); // used by the API assertions below

console.log("ZeroScript module load simulation");
console.log("blocks that load main.js:", blocks.length);
for (const block of blocks) {
  const host = block.matches[0];
  // a real page gets exactly ONE site block, so each block runs in a fresh realm
  const blockCtx = freshContext();
  let lastCtx = blockCtx;
  console.log(`\n[${host}] ${block.js.length} files`);
  for (const rel of block.js) {
    const file = path.join(EXT, rel);
    const src = fs.readFileSync(file, "utf8");
    try {
      vm.runInContext(src, blockCtx, { filename: `${host}:${rel}` });
    } catch (e) {
      console.log(`  THROW ${rel}: ${e.message}`);
      const where = String(e.stack || "").split("\n").slice(0, 3).join("\n        ");
      console.log("        " + where);
      errors.push(`${host} ${rel}: ${e.message}`);
    }
  }
  console.log("  (loaded)");
  LAST_BLOCK_CTX = blockCtx;
}

// Give the deferred timers (storage loads, loadWall, tryPatch…) a chance to run.
(async () => {
  await new Promise((r) => setTimeout(r, 120));
  console.log("\nAPIs the loop depends on:");
  const need = {
    ZS: ["buildSystemPrompt", "FEEDBACK", "PLANS", "APP_VERSION"],
    ZSParse: ["parseToolCalls", "toolNameFromText", "extractJson", "salvageCutOff"],
    ZSSandbox: ["analyseLuau"],
    ZSMemoryWall: ["buildTrimmedContext", "buildContext", "remember", "stats"],
    ZSPlanWall: ["send", "sendWallTask", "getWallLog", "setPlan", "magicForCurrentTab"],
    ZSAgentHub: ["write", "read", "pushTemp", "getTemp"],
    ZSPromptEnhancer: ["wrapTypeAndSend"],
    ZSAgentStability: ["tryPatch"],
    ZSProvider: ["getEditor", "typeAndSend", "allItems", "readAssistant", "barMount"],
  };
  for (const [name, members] of Object.entries(need)) {
    let obj;
    try { obj = vm.runInContext(`typeof ${name} !== "undefined" ? ${name} : undefined`, LAST_BLOCK_CTX || ctx); } catch { obj = undefined; }
    if (!obj) { errors.push(`${name} missing after load`); console.log(`  MISSING  ${name}`); continue; }
    const missing = members.filter((m) => typeof obj[m] !== "function" && obj[m] === undefined);
    if (missing.length) { errors.push(`${name} missing ${missing.join(",")}`); console.log(`  BROKEN   ${name}: missing ${missing.join(", ")}`); }
    else console.log(`  ok       ${name} (${members.length} members)`);
  }

  // provider identity must not have been mutated by loading order
  const prov = vm.runInContext('typeof ZSProvider !== "undefined" ? ZSProvider : null', LAST_BLOCK_CTX || ctx);
  if (prov && prov.displayName) console.log(`\nlast provider identity: ${prov.id} / ${prov.displayName}`);
  if (prov && (prov.id === "generic" || /undefined/.test(String(prov.id)))) errors.push(`provider identity collapsed to "${prov.id}" — shared metadata bug is back`);

  // the session state must be readable by the loop
  const execMode = (LAST_BLOCK_CTX || ctx).window.__zsExecMode;
  console.log("window.__zsExecMode:", execMode === undefined ? "(unset until storage callback)" : execMode);
  if (execMode !== undefined && !["single", "continuous", "loop"].includes(execMode)) errors.push(`bad exec mode "${execMode}"`);

  // memory wall must actually report content
  const MW = vm.runInContext('typeof ZSMemoryWall !== "undefined" ? ZSMemoryWall : null', LAST_BLOCK_CTX || ctx);
  if (MW) {
    const st = MW.stats();
    console.log("memory wall stats:", JSON.stringify(st));
    if (!st || typeof st.wallLen !== "number") errors.push("memory wall stats() did not report wallLen");
  }

  console.log("\nconsole output during load (" + log.length + " lines):");
  for (const line of log.slice(0, 12)) console.log("   ", line.join(" ").slice(0, 150));

  console.log("\n======================");
  if (errors.length) {
    console.log(`${errors.length} PROBLEM(S):`);
    for (const e of errors.slice(0, 25)) console.log("  ✗ " + e);
    process.exit(1);
  }
  console.log("SMOKE TEST PASSED — all modules boot against a stubbed browser");
  process.exit(0);
})();
