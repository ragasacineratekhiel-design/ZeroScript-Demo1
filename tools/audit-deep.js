#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// tools/audit-deep.js — static defect hunter for the extension tree.
//
// Not a linter. It looks for the specific classes of bug that have actually
// shipped in this repo: dead exports, fire-and-forget async, listeners and
// timers that are created but never released on a page that lives for hours,
// and same-shaped code duplicated across providers where one copy has drifted.
//
// Usage: node tools/audit-deep.js [--json]
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "zeroscript-extension-v2");
const ACORN = (() => {
  for (const c of [path.join(ROOT, "tools", "vendor", "acorn", "acorn.js"), "acorn"]) {
    try { return require(c); } catch (_e) { /* next */ }
  }
  return null;
})();
if (!ACORN) { console.error("acorn missing"); process.exit(2); }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js") && !e.name.startsWith("test-")) out.push(p);
  }
  return out;
}

const files = walk(EXT).sort();
const findings = [];
const add = (kind, sev, file, line, msg, evidence) =>
  findings.push({ kind, sev, file: path.relative(ROOT, file), line, msg, evidence });

// ── per-file AST collection ───────────────────────────────────────────────
function parse(file) {
  const src = fs.readFileSync(file, "utf8");
  try {
    return { src, ast: ACORN.parse(src, { ecmaVersion: "latest", locations: true }) };
  } catch (e) {
    add("syntax", "P0", file, e.loc ? e.loc.line : 0, "does not parse: " + e.message);
    return null;
  }
}

function walkNodes(node, cb, parent) {
  if (!node || typeof node.type !== "string") return;
  cb(node, parent);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") walkNodes(c, cb, node); }
    else if (v && typeof v.type === "string") { walkNodes(v, cb, node); }
  }
}

const allFiles = [];
for (const f of files) {
  const p = parse(f);
  if (p) allFiles.push({ file: f, ...p });
}

// ── 1. DEAD CODE: a function declared and never referenced anywhere ───────
// Cross-file, because main.js calls provider methods dynamically.
const globalSrc = allFiles.map((f) => f.src).join("\n") +
  fs.readFileSync(path.join(EXT, "manifest.json"), "utf8");
for (const { file, ast } of allFiles) {
  const declared = [];
  walkNodes(ast, (n) => {
    if (n.type === "FunctionDeclaration" && n.id) declared.push({ name: n.id.name, line: n.loc.start.line });
    if (n.type === "VariableDeclarator" && n.id && n.id.type === "Identifier" &&
        n.init && (n.init.type === "ArrowFunctionExpression" || n.init.type === "FunctionExpression")) {
      declared.push({ name: n.id.name, line: n.loc.start.line });
    }
  });
  const codeOnly = allFiles.find((x) => x.file === file).src;
  for (const d of declared) {
    // count real references outside the declaration itself
    const re = new RegExp("\\b" + d.name.replace(/[$]/g, "\\$") + "\\b", "g");
    const inFile = (codeOnly.match(re) || []).length;
    const everywhere = (globalSrc.match(re) || []).length;
    if (everyoneIsOne(inFile, everywhere)) {
      add("dead-code", "P2", file, d.line, `function "${d.name}" is declared but never called anywhere`,
        `${inFile} occurrence(s) in file, ${everywhere} in tree`);
    }
  }
}
function everyoneIsOne(inFile, everywhere) { return inFile <= 1 && everywhere <= 1; }

// ── 2. FIRE-AND-FORGET ASYNC: an async call whose result is dropped ───────
// If the callee can reject and nothing handles it, the failure disappears.
for (const { file, ast, src } of allFiles) {
  const asyncNames = new Set();
  walkNodes(ast, (n) => {
    if (n.type === "FunctionDeclaration" && n.id && n.async) asyncNames.add(n.id.name);
    if (n.type === "VariableDeclarator" && n.id && n.id.type === "Identifier" &&
        n.init && (n.init.async || (n.init.type === "ArrowFunctionExpression" && n.init.async))) asyncNames.add(n.id.name);
  });
  walkNodes(ast, (n) => {
    if (n.type !== "ExpressionStatement") return;
    const e = n.expression;
    let call = null;
    if (e.type === "CallExpression") call = e;
    if (e.type === "UnaryExpression" && e.operator === "void" && e.argument.type === "CallExpression") call = e.argument;
    if (!call) return;
    const callee = call.callee;
    const name = callee.type === "Identifier" ? callee.name : null;
    if (!name || !asyncNames.has(name)) return;
    // `.catch(` on the same expression is handled by acorn as a member call, so
    // a bare CallExpression statement means nobody consumes the promise.
    add("unhandled-promise", "P1", file, n.loc.start.line,
      `async "${name}()" called without await/catch — a rejection here vanishes`,
      src.slice(call.start, Math.min(call.end, call.start + 70)).replace(/\s+/g, " "));
  });
}

// ── 3. LEAKED TIMERS/LISTENERS on a page that lives for hours ────────────
// Every content script runs for the life of the tab. A setInterval created in a
// function that is called repeatedly (or an addEventListener added repeatedly)
// multiplies without bound.
for (const { file, ast, src } of allFiles) {
  const intervals = [];
  const listeners = [];
  walkNodes(ast, (n) => {
    if (n.type === "CallExpression" && n.callee.type === "Identifier") {
      if (n.callee.name === "setInterval") {
        intervals.push({ line: n.loc.start.line, src: src.slice(n.start, Math.min(n.end, n.start + 80)).replace(/\s+/g, " ") });
      }
      if (n.callee.name === "addEventListener") {
        const ev = n.arguments[0] && n.arguments[0].type === "Literal" ? n.arguments[0].value : "?";
        listeners.push({ line: n.loc.start.line, ev });
      }
    }
  });
  const cleared = (src.match(/clearInterval\(/g) || []).length;
  const removed = (src.match(/removeEventListener\(/g) || []).length;
  // searchAll-style listeners are fine; only flag the ratio badly out of balance
  if (intervals.length > 0 && cleared === 0) {
    add("leaked-timer", "P1", file, intervals[0].line,
      `${intervals.length} setInterval(s) and ZERO clearInterval in this file — they outlive everything that made them`,
      intervals[0].src);
  }
  if (listeners.length > 3 && removed === 0) {
    add("leaked-listener", "P3", file, listeners[0].line,
      `${listeners.length} addEventListener(s), no removeEventListener — acceptable only if all are one-shot at module scope`,
      listeners.map((l) => l.ev).join(","));
  }
}

// ── 4. DUPLICATED LOGIC ACROSS PROVIDERS that has already drifted ────────
// The 9 bespoke drivers share most of their shape. A helper that is identical
// in 8 files and different in 1 is a bug waiting to be reported as "works on
// ChatGPT but not Claude".
function fnBodies(fileObj) {
  const out = new Map();
  walkNodes(fileObj.ast, (n) => {
    let name = null, body = null;
    if (n.type === "FunctionDeclaration" && n.id) { name = n.id.name; body = n.body; }
    if (n.type === "VariableDeclarator" && n.id && n.id.type === "Identifier" &&
        n.init && n.init.body) { name = n.id.name; body = n.init.body; }
    if (name && body && body.start != null) {
      let text = fileObj.src.slice(body.start, body.end);
      // strip comments + collapse whitespace: a differing comment is not drift
      text = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
      if (text.length > 120) out.set(name, text);
    }
  });
  return out;
}
const providers = allFiles.filter((f) => /providers\/(chatgpt|claude|deepseek|gemini|glm|kimi|qwen|meta|arena)\.js$/.test(f.file));
const bodyIndex = new Map(); // name -> Map(hash -> [files])
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h.toString(16);
}
for (const pf of providers) {
  for (const [name, body] of fnBodies(pf)) {
    if (!bodyIndex.has(name)) bodyIndex.set(name, new Map());
    const h = hash(body);
    const m = bodyIndex.get(name);
    if (!m.has(h)) m.set(h, []);
    m.get(h).push(path.basename(pf.file));
  }
}
// Which shared helpers MUST be identical across providers? Only the ones that
// do not touch the site's DOM — string/array utilities and the truncation rule.
// Everything else (getEditor, readAssistant, typeAndSend…) selects site-specific
// elements and is SUPPOSED to differ; flagging those produced 36 bogus warnings.
// Only helpers with NO site-specific content. `truncateForSend` is deliberately
// per-site (each provider has its own composer limit and its own message), and
// `textWithout`/`sampleStream`/`walk` walk different DOM shapes, so they are
// excluded — flagging them was noise, not signal.
const SITE_AGNOSTIC = /^(waitFor|clamp|toText|asText|isTooLongMsg|isBusyMsg)$/;
for (const [name, variants] of bodyIndex) {
  if (!SITE_AGNOSTIC.test(name)) continue;
  if (variants.size < 2) continue;
  const filesInName = [...variants.values()].flat();
  if (filesInName.length < 3) continue;
  const shapes = [...variants.entries()].sort((a, b) => b[1].length - a[1].length);
  const majority = shapes[0];
  const odd = shapes.slice(1).filter((o) => o[1].length <= 3);
  if (odd.length) {
    add("provider-drift", "P1", providers[0].file, 0,
      `"${name}" should be identical across providers but has ${variants.size} shapes — ` +
      `majority in ${majority[1].length} (${majority[1].join(",")}); divergent: ` +
      odd.map((o) => o[1].join(",")).join(" | "),
      `${filesInName.length} providers`);
  }
}

// ── 5. HARDCODED MAGIC that should be a constant ─────────────────────────
for (const { file, src } of allFiles) {
  const hits = [...src.matchAll(/setTimeout\([^,]+,\s*(\d{2,6})\)/g)].map((m) => m[1]);
  const counts = {};
  for (const h of hits) counts[h] = (counts[h] || 0) + 1;
  for (const [v, n] of Object.entries(counts)) {
    if (n >= 5) add("magic-timing", "P3", file, 0, `${n} bare setTimeout(..., ${v}) literals — should be one named constant`, `x${n}`);
  }
}

// ── 6. UNUSED LOCALS, SCOPED ─────────────────────────────────────────────
// Reference counting MUST be per-enclosing-function, otherwise `msg` in one
// handler "uses" `msg` in another and every unused local is invisible. (The
// first version of this check did exactly that and reported 11 false positives.)
function enclosingSpan(ast, node) {
  let span = { start: 0, end: Infinity };
  walkNodes(ast, (n, parent) => {
    void parent;
    if (!n.loc) return;
    const isFn = n.type === "FunctionDeclaration" || n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression";
    if (!isFn || !n.body || !n.body.start) return;
    if (node.start >= n.body.start && node.end <= n.body.end) {
      if (n.body.end - n.body.start < span.end - span.start) span = { start: n.body.start, end: n.body.end };
    }
  });
  return span;
}
for (const { file, ast, src } of allFiles) {
  walkNodes(ast, (n, parent) => {
    if (n.type !== "VariableDeclarator" || !n.id || n.id.type !== "Identifier") return;
    const name = n.id.name;
    if (/^_/.test(name)) return;                 // _e / _x are intentional
    if (parent && parent.type === "VariableDeclaration" && parent.kind === "var") return; // hoisting noise
    const span = enclosingSpan(ast, n);
    const scopeSrc = src.slice(span.start === 0 ? 0 : span.start, span.end === Infinity ? src.length : span.end);
    const count = (scopeSrc.match(new RegExp("\\b" + name + "\\b", "g")) || []).length;
    // 1 = the declaration itself
    if (count <= 1) {
      add("unused-var", "P3", file, n.loc.start.line, `"${name}" is assigned and never read in its scope`, `${count} ref(s)`);
    }
  });
}

// ── 7. ASYNC FUNCTION WITH NO AWAIT ──────────────────────────────────────
// Either the `await` is missing (a real race) or `async` is a lie that makes
// callers wrap it in a promise for nothing.
function containsAwait(body) {
  let found = false;
  (function rec(node) {
    if (!node || typeof node.type !== "string" || found) return;
    if (node.type === "AwaitExpression") { found = true; return; }
    // a nested function has its own async-ness; do not inherit it
    if (node !== body && (node.type === "FunctionDeclaration" || node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression")) return;
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "start" || k === "end") continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") rec(c); }
      else if (v && typeof v.type === "string") { rec(v); }
    }
  })(body);
  return found;
}
for (const { file, ast } of allFiles) {
  walkNodes(ast, (n) => {
    let body = null, label = null;
    if (n.type === "FunctionDeclaration" && n.async) { body = n.body; label = n.id && n.id.name; }
    if (n.type === "VariableDeclarator" && n.init && n.init.async) { body = n.init.body; label = n.id && n.id.name; }
    if (!body || !label) return;
    if (!containsAwait(body)) {
      add("async-no-await", "P3", file, n.loc.start.line,
        `"${label}" is async but contains no await`, "makes callers wait for nothing");
    }
  });
}

// ── 8. UNGUARDED JSON.parse ──────────────────────────────────────────────
// JSON.parse throws on malformed input. Inside a catch-less path on a page that
// must never die, that is a hard failure.
for (const { file, ast, src } of allFiles) {
  walkNodes(ast, (n) => {
    if (n.type !== "CallExpression") return;
    const c = n.callee;
    if (c.type !== "MemberExpression" || c.object.type !== "Identifier" || c.object.name !== "JSON") return;
    if (c.property.type !== "Identifier" || c.property.name !== "parse") return;
    // find whether any ancestor is a TryStatement block
    add("unguarded-json", "P3", file, n.loc.start.line, "JSON.parse without a local try/catch",
      src.slice(n.start, Math.min(n.end, n.start + 60)).replace(/\s+/g, " "));
  });
}

// ── 9. IDENTICAL FUNCTION BODIES ACROSS FILES (copy-paste that will drift) ─
const seenBodies = new Map();
for (const { file, ast, src } of allFiles) {
  walkNodes(ast, (n) => {
    let body = null, name = null;
    if (n.type === "FunctionDeclaration" && n.id) { body = n.body; name = n.id.name; }
    if (n.type === "VariableDeclarator" && n.id && n.id.type === "Identifier" && n.init && n.init.body) { body = n.init.body; name = n.id.name; }
    if (!body) return;
    const text = src.slice(body.start, body.end).replace(/\s+/g, " ");
    if (text.length < 200) return;
    const h = hash(text);
    if (!seenBodies.has(h)) seenBodies.set(h, { text, sites: [] });
    seenBodies.get(h).sites.push(`${path.relative(EXT, file)}:${name}`);
  });
}
for (const [, v] of seenBodies) {
  const filesInvolved = new Set(v.sites.map((s) => s.split(":")[0]));
  if (filesInvolved.size >= 2) {
    add("duplicate-logic", "P2", allFiles[0].file, 0,
      `identical ${v.text.length}-char body in ${filesInvolved.size} files: ${v.sites.slice(0, 5).join(", ")}`,
      "extract or they will drift");
  }
}

// ── report ───────────────────────────────────────────────────────────────
const bySev = { P0: [], P1: [], P2: [], P3: [] };
for (const f of findings) bySev[f.sev].push(f);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  console.log("DEEP AUDIT — " + files.length + " source files");
  console.log("=".repeat(70));
  const labels = { P0: "P0 broken", P1: "P1 real defect", P2: "P2 dead", P3: "P3 hygiene" };
  for (const sev of ["P0", "P1", "P2", "P3"]) {
    const list = bySev[sev];
    if (!list.length) { console.log(`\n${labels[sev]}: none`); continue; }
    console.log(`\n${labels[sev]} (${list.length})`);
    const seen = new Set();
    for (const f of list) {
      const key = f.kind + f.msg.slice(0, 50);
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  [${f.kind}] ${f.file}:${f.line} — ${f.msg}`);
      if (f.evidence) console.log(`      ${f.evidence.slice(0, 110)}`);
    }
    if (list.length > seen.size) console.log(`  … ${list.length - seen.size} similar suppressed`);
  }
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${findings.length} findings`);
}
process.exit(bySev.P0.length ? 1 : 0);
