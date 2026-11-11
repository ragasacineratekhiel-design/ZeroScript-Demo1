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

const ROOT = process.env.ZS_AUDIT_ROOT ? path.resolve(process.env.ZS_AUDIT_ROOT) : path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "zeroscript-extension-v2");
// Vendored acorn lives next to this tool, not next to the audited tree — a
// sandbox root must not need its own copy just to self-test the checker.
const TOOL_ROOT = path.resolve(__dirname, "..");
const ACORN = (() => {
  for (const c of [path.join(TOOL_ROOT, "tools", "vendor", "acorn", "acorn.js"), "acorn"]) {
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

// ── 4g. OBSERVER LEAKS: observe() with no way to disconnect() ─────────────
// A MutationObserver on document.documentElement with subtree:true keeps firing
// for the life of the page. If nothing can ever call disconnect(), the observer
// (and the detached nodes it references in bfcache) cannot be released.
for (const { file, src } of allFiles) {
  const observes = (src.match(/\.observe\(/g) || []).length;
  const disconnects = (src.match(/\.disconnect\(\)/g) || []).length;
  if (observes > disconnects) {
    add("observer-leak", "P1", file, 0,
      `${observes} observe() call(s) but only ${disconnects} disconnect() — at least one observer can never be released`,
      "hook pagehide → disconnect()");
  }
  // Scope matters. An observer bound to one composer element and disconnected
  // when that feature turns off (kimi's input lock) has a complete lifecycle and
  // needs no unload hook — the first version of this check flagged exactly that,
  // which was wrong. A DOCUMENT-WIDE observer (document.body / documentElement)
  // is the one that outlives its purpose: it keeps firing for the life of the
  // tab and is never released on navigation.
  const wholeDoc = /\.observe\(\s*document(\.body|\.documentElement)?\s*[,)]/.test(src);
  const hasUnloadHook = /(pagehide|beforeunload)/.test(src);
  if (wholeDoc && !hasUnloadHook) {
    add("observer-release", "P2", file, 0,
      "document-wide MutationObserver with no pagehide/beforeunload release path — " +
      "it keeps firing for the life of the tab and is never released on navigation",
      "register a pagehide → disconnect() hook");
  }
  // Observers that rescan the whole document on every mutation are the other
  // half of this class: that is what made one streamed reply cost hundreds of
  // full-document queries. The fix is coalescing, which shows up as a timer.
  const observeCalls = src.match(/\.observe\(/g) || [];
  if (observeCalls.length > 0) {
    const hasWholeDoc = /\{[^}]*subtree\s*:\s*true/.test(src);
    const hasCoalesce = /(clearTimeout|setTimeout\(\s*\(\)\s*=>)/.test(src);
    const observerCb = /new\s+MutationObserver\(\s*\(?[\w,\s]*\)?\s*=>/.test(src);
    if (hasWholeDoc && observerCb && !hasCoalesce) {
      add("observer-storm", "P2", file, 0,
        "subtree observer calls its scan directly from the callback with no coalescing — " +
        "a streamed reply turns every DOM mutation into a full-document scan",
        "batch through a 0ms timer and skip while document.hidden");
    }
  }
}

// ── 4g2. BroadcastChannel with no release path ────────────────────────────
// A BroadcastChannel holds a live port on the origin. If nothing closes it and
// nothing hooks pagehide, it survives every navigation that keeps the document
// alive. All three walls (agent_hub, plan_wall, peer_wall) had this: peer_wall
// even exposed a close() that no caller ever used.
for (const { file, src } of allFiles) {
  if (!/new\s+BroadcastChannel\s*\(/.test(src)) continue;
  // A service worker has no pagehide: it is torn down by the browser whenever it
  // goes idle, which closes the channel for it. Demanding an unload hook there
  // would be the wrong advice.
  const isServiceWorker = /["']service_worker["']\s*:/.test(
    (() => { try { return fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"); } catch { return ""; } })()
  ) && /chrome\.runtime\.onInstalled|chrome\.alarms/.test(src);
  if (isServiceWorker) continue;
  const hasHook = /(pagehide|beforeunload)/.test(src);
  const closes = /\.close\s*\?\.?\s*\(/.test(src) || /\.close\s*\(/.test(src);
  if (!hasHook) {
    add("channel-leak", "P2", file, 0,
      `opens a BroadcastChannel (${closes ? "a close() exists but no pagehide hook calls it" : "no close() at all"}) — ` +
      "the port outlives the document",
      "hook pagehide → channel.close()");
  }
}

// ── 4h. innerHTML fed by a NON-LITERAL value ──────────────────────────────
// Rules that keep this honest rather than noisy:
//   * a template literal whose first chunk starts with "<" is our own markup;
//   * a concatenation/literal is fine if every interpolated identifier resolves
//     to a same-file `const NAME = "<…"` literal (icon constants, SVG strings);
//   * a local function CALL is resolved one level: if its body only ever returns
//     literals/constants, it is safe.
// Anything else is a real injection surface, because content scripts run inside
// third-party pages and at least one path feeds provider text here.
// Declarations and assignments for the file under inspection. Rebuilt per file
// by setCurrentAst(); the name->node maps keep the literal check honest for
// multi-declarator statements and for names that are reassigned later.
let CUR_AST = null;
let DECL_MAP = null;
let ASSIGN_MAP = null;
let ALIAS_MAP = null;
function setCurrentAst(ast) {
  CUR_AST = ast;
  DECL_MAP = new Map();
  ASSIGN_MAP = new Map();
  ALIAS_MAP = new Map();
  if (!ast) return;
  walkNodes(ast, (n) => {
    if (n.type === "VariableDeclarator" && n.id && n.id.type === "Identifier") {
      if (!DECL_MAP.has(n.id.name)) DECL_MAP.set(n.id.name, n);
    }
    // `for (const meta of Object.entries(EXEC_META))`: the loop variable carries
    // the table's values, so the table decides whether it is safe.
    if ((n.type === "ForOfStatement" || n.type === "ForInStatement")) {
      const left = n.left;
      const decl = left && left.type === "VariableDeclaration" && left.declarations[0];
      const id = decl && decl.id;
      const srcName = forOfSourceName(n.right);
      if (id && id.type === "Identifier") {
        ALIAS_MAP.set(id.name, srcName);
      } else if (id && (id.type === "ArrayPattern" || id.type === "ObjectPattern")) {
        // `const [k, meta] of Object.entries(T)` — every bound name carries a
        // literal from the same table.
        const elems = id.type === "ArrayPattern" ? id.elements : id.properties.map((x) => x.value);
        for (const el of elems) if (el && el.type === "Identifier") ALIAS_MAP.set(el.name, srcName);
      }
    }
    if (n.type === "AssignmentExpression" && n.left && n.left.type === "Identifier") {
      if (!ASSIGN_MAP.has(n.left.name)) ASSIGN_MAP.set(n.left.name, []);
      ASSIGN_MAP.get(n.left.name).push(n.right);
    }
  });
}
function findDeclarator(name) {
  return DECL_MAP ? DECL_MAP.get(name) || null : null;
}
// Only `Object.entries(X)` / `Object.values(X)` / plain `X` yields a table whose
// elements we can reason about. Anything else returns null and stays suspicious.
function forOfSourceName(right) {
  if (!right) return null;
  if (right.type === "Identifier") return right.name;
  if (right.type === "CallExpression" && right.callee.type === "MemberExpression" &&
      right.callee.object.name === "Object" &&
      (right.callee.property.name === "entries" || right.callee.property.name === "values") &&
      right.arguments[0] && right.arguments[0].type === "Identifier") {
    return right.arguments[0].name;
  }
  return null;
}
function objectIsAllLiterals(name) {
  const d = findDeclarator(name);
  if (!d || !d.init || d.init.type !== "ObjectExpression") return false;
  return d.init.properties.every((prop) => {
    if (prop.type !== "Property") return false;
    const probe = (v) => {
      if (!v) return true;
      if (v.type === "Literal") return typeof v.value === "string" || typeof v.value === "number";
      if (v.type === "ObjectExpression") return v.properties.every((q) => q.type === "Property" && probe(q.value));
      if (v.type === "MemberExpression") return true; // ICONS.x style
      return false;
    };
    return probe(prop.value);
  });
}
function findAssignments(name) {
  return ASSIGN_MAP ? ASSIGN_MAP.get(name) || [] : [];
}
function isLiteralish(node, src, depth = 0) {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "string") return true;
  if (node.type === "TemplateLiteral") {
    // The quasi text is written by us, so it is markup we own. Every
    // interpolation, however, is data — and provider text can reach it.
    // Leading-"<" is NOT a safety signal: `<b onclick="${P.text()}">` starts
    // with "<" and is still an injection.
    return node.expressions.every((e) => isLiteralish(e, src, depth));
  }
  if (node.type === "BinaryExpression") return isLiteralish(node.left, src, depth) && isLiteralish(node.right, src, depth);
  if (node.type === "Identifier") {
    if (depth > 3) return false; // the chain must terminate
    // Prefer a real declarator walk: `let a = "", b = `x`, c = 1` has more than
    // one declarator per statement, and a first-match regex sees only the first.
    const aliasSrc = ALIAS_MAP ? ALIAS_MAP.get(node.name) : null;
    if (aliasSrc) {
      // `Object.entries(EXEC_META)` destructured into `meta`: safe iff the table
      // is all literals. `entries()` gives [k, v] pairs, so both are literals.
      return objectIsAllLiterals(aliasSrc);
    }
    const decl = findDeclarator(node.name);
    if (decl) {
      if (decl.init && isLiteralish(decl.init, src, depth + 1)) return true;
      // No initialiser: safe only if every later assignment is itself literal-ish.
      const assigns = findAssignments(node.name);
      if (!assigns.length) return false;
      return assigns.every((a) => isLiteralish(a, src, depth + 1));
    }
    // NOTE: "\\b" in the source, NOT "\\\\b". A double-escaped word
    // boundary silently matches a literal backslash and the check cries wolf.
    const pat = "\\b(?:const|let|var)\\s+" + node.name + "\\s*=\\s*(\\S[^\\n;]*)";
    const m = new RegExp(pat).exec(src);
    if (!m) return false;
    const init = m[1].trim();
    // Hoisted constant: `const A = "https://…"` / `const A = `…`` — our own string.
    if (/^[`\"\']/.test(init)) return true;
    // Aliased constant: `const videoBtn = VIDEO_URL ? `…` : ""` — follow the name
    // so a ternary over constants still resolves instead of crying wolf.
    const alias = /^([A-Za-z_$][\w$]*)\s*(?:[?:.\[]|$)/.exec(init);
    if (alias && alias[1] !== node.name) {
      return isLiteralish({ type: "Identifier", name: alias[1] }, src, depth + 1);
    }
    return false;
  }
  if (node.type === "MemberExpression" && node.object.type === "Identifier") {
    // `meta.label` where `meta` came from `Object.entries(EXEC_META)`
    const owner = ALIAS_MAP ? ALIAS_MAP.get(node.object.name) : null;
    if (owner) return objectIsAllLiterals(owner);
    // ICONS.check / SPIN style constant tables: accept when the object is a
    // same-file const object of string literals
    return new RegExp("\\b(?:const|let|var)\\s+" + node.object.name + "\\s*=\\s*\\{").test(src);
  }
  // `hasBody ? "<div>" : ""` — a ternary of our own literals is still our markup.
  if (node.type === "ConditionalExpression") {
    return isLiteralish(node.consequent, src, depth) && isLiteralish(node.alternate, src, depth);
  }
  if (node.type === "LogicalExpression") {
    return isLiteralish(node.left, src, depth) && isLiteralish(node.right, src, depth);
  }
  if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "SVG") return true;
  if (node.type === "CallExpression" && node.callee.type === "Identifier") {
    // A sanitizer is a function whose BODY escapes & and < before returning.
    // Proven from the code, not from its name — an allowlist of "safe" names is
    // the same blindness this tool exists to catch.
    const sanName = node.callee.name;
    const defIdx = src.search(new RegExp("(?:const|let|var|function)\\s+" + sanName + "\\b"));
    if (defIdx !== -1) {
      const braceIdx = src.indexOf("{", defIdx);
      if (braceIdx !== -1 && braceIdx - defIdx < 120) {
        let depthB = 0, end = -1;
        for (let i = braceIdx; i < src.length; i++) {
          if (src[i] === "{") depthB++;
          else if (src[i] === "}") { depthB--; if (depthB === 0) { end = i; break; } }
        }
        if (end > braceIdx) {
          const body = src.slice(braceIdx, end);
          // Plain string probes: a regex literal containing "</" is a
          // quoting hazard, and this check does not need regex at all.
          const escAmp = body.indexOf("&amp;") !== -1;
          const escLt = body.indexOf("&lt;") !== -1;
          const doesReplace = body.indexOf(".replace(") !== -1;
          if (doesReplace && escAmp && escLt) return true;
          if (escAmp && escLt) return true;
        }
      }
    }
  }
  if (node.type === "CallExpression" && node.callee.type === "Identifier") {
    // resolve one level: does the function body only return literals?
    const name = node.callee.name;
    const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]{0,1200}?)\\n  \\}`);
    const m = re.exec(src);
    if (m) {
      const body = m[1];
      const returns = [...body.matchAll(/return\s+([^;]+);/g)].map((x) => x[1].trim());
      if (returns.length && returns.length <= 12) {
        // Every returned expression must be a literal or a constant-table lookup.
        // `ICONS[category] || ICONS.tool` counts: both sides are table reads.
        return returns.every((r) => r.split("||").every((part) => {
          const t = part.trim();
          return /^[`'"]/.test(t) || /^ICONS\./.test(t) || /^[A-Z_]+$/.test(t) ||
                 /^SVG\(/.test(t) || /^ICONS\[/.test(t);
        }));
      }
    }
  }
  return false;
}
for (const { file, ast, src } of allFiles) {
  setCurrentAst(ast); // declarator/assignment maps are per-file
  walkNodes(ast, (n) => {
    if (n.type !== "AssignmentExpression" || n.operator !== "=") return;
    const L = n.left;
    if (!L || L.type !== "MemberExpression") return;
    if (L.property.type !== "Identifier" || L.property.name !== "innerHTML") return;
    if (isLiteralish(n.right, src)) return;
    add("dom-injection", "P1", file, n.loc.start.line,
      "innerHTML assigned from a value that is not provably our own literal — provider/DOM text can inject markup into the host page",
      src.slice(n.start, Math.min(n.end, n.start + 70)).replace(/\s+/g, " "));
  });
}

// ---- 4i. try/catch around an async call with no await (cannot catch) ----
// `try { someAsyncFn(); } catch {}` catches nothing: the rejection happens after
// the try block has already exited. This shipped twice in this repo.
for (const { file, ast, src } of allFiles) {
  const asyncNames = new Set();
  walkNodes(ast, (n) => {
    if (n.type === "FunctionDeclaration" && n.id && n.async) asyncNames.add(n.id.name);
    if (n.type === "VariableDeclarator" && n.id && n.init && n.init.async) asyncNames.add(n.id.name);
  });
  walkNodes(ast, (n) => {
    if (n.type !== "TryStatement") return;
    for (const stmt of (n.block.body || [])) {
      if (stmt.type !== "ExpressionStatement" || stmt.expression.type !== "CallExpression") continue;
      const c = stmt.expression.callee;
      const name = c.type === "Identifier" ? c.name : null;
      if (name && asyncNames.has(name)) {
        add("try-async-trap", "P1", file, stmt.loc.start.line,
          `try { ${name}(); } catch — \`${name}\` is async, so the catch can never see its rejection`,
          src.slice(stmt.start, Math.min(stmt.end, stmt.start + 60)).replace(/\s+/g, " "));
      }
    }
  });
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
    // A module-level binding with a leading uppercase name is a cross-file global:
    // parser.js declares `const ZSParse = (…)()` and main.js reads it directly,
    // which is the whole point of the classic-script load order. Counting
    // references inside this file only would flag every one of them.
    const isModuleScope = span.start === 0;
    if (isModuleScope && /^[A-Z]/.test(name)) {
      const everywhere = (globalSrc.match(new RegExp("\\b" + name + "\\b", "g")) || []).length;
      if (everywhere > 1) return;   // some other file reads it
    }
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
    // An exported provider method is part of a uniform async interface: callers
    // `await P.ensureComposerReady(...)` for every provider, and one provider
    // legitimately answers synchronously. Reporting that as "makes callers wait
    // for nothing" is true of one microtask and useless as a defect.
    if (isExportedProperty(ast, label) && !containsAwait(body)) return;
    if (!containsAwait(body)) {
      add("async-no-await", "P3", file, n.loc.start.line,
        `"${label}" is async but contains no await`, "makes callers wait for nothing");
    }
  });
}

// Is the code at `offset` inside a `try` block that actually has a catch or
// finally handler? Derived from the AST — a character scan desynchronises on
// regex literals (parser.js has `/[["}\]]/`) and reports nonsense.
let TRY_RANGES = []; // [blockStart, blockEnd] of guarded try blocks, per file
function collectGuardedTries(ast) {
  TRY_RANGES = [];
  walkNodes(ast, (n) => {
    if (n.type === "TryStatement" && (n.handler || n.finalizer) && n.block) {
      TRY_RANGES.push([n.block.start, n.block.end]);
    }
  });
}
function hasGuardingTry(src, offset) {
  return TRY_RANGES.some(([a, b]) => offset >= a && offset < b);
}

// Is `name` returned as a property of an object literal (`return { …, name, … }`)?
function isExportedProperty(ast, name) {
  let found = false;
  walkNodes(ast, (n) => {
    if (found || n.type !== "ReturnStatement" || !n.argument) return;
    if (n.argument.type !== "ObjectExpression") return;
    for (const prop of n.argument.properties) {
      if (prop.type !== "Property") continue;
      const k = prop.key;
      const keyName = k.type === "Identifier" ? k.name : k.type === "Literal" ? String(k.value) : null;
      if (keyName === name) { found = true; return; }
    }
  });
  return found;
}
// ── 8. UNGUARDED JSON.parse ──────────────────────────────────────────────
// JSON.parse throws on malformed input. Inside a catch-less path on a page that
// must never die, that is a hard failure.
for (const { file, ast, src } of allFiles) {
  collectGuardedTries(ast);
  walkNodes(ast, (n) => {
    if (n.type !== "CallExpression") return;
    const c = n.callee;
    if (c.type !== "MemberExpression" || c.object.type !== "Identifier" || c.object.name !== "JSON") return;
    if (c.property.type !== "Identifier" || c.property.name !== "parse") return;
    // Actually look for a guarding try/catch. The previous version just said
    // "find whether any ancestor is a TryStatement block" and then reported
    // every JSON.parse unconditionally — advice in a comment, no code behind it.
    if (hasGuardingTry(src, n.start)) return;
    add("unguarded-json", "P3", file, n.loc.start.line, "JSON.parse without a local try/catch",
      src.slice(n.start, Math.min(n.end, n.start + 60)).replace(/\s+/g, " "));
  });
}

// ── 9. BYTE-IDENTICAL HELPER BODIES ACROSS PROVIDER FILES ────────────────
// Providers here are deliberately self-contained: manifest.json tells the reader
// to delete a provider file to disable that site, so a shared common.js would
// re-couple them. Byte-identical copies of a small pure DOM helper are therefore
// expected, and the honest report is ONE aggregated P3 line, not seven.
//
// Tried and rejected: reporting "same function name, different body" as drift.
// It produced 34 findings — every provider's typeAndSend/readAssistant differs
// because each site's DOM differs. That is the interface, not a defect. A check
// that fires on all 10 providers carries no information, so it is not shipped.
const identicalGroups = new Map(); // hash -> { text, sites: [{file,line,rel}] }
for (const { file, ast, src } of allFiles) {
  walkNodes(ast, (n) => {
    let body = null, name = null;
    if (n.type === "FunctionDeclaration" && n.id) { body = n.body; name = n.id.name; }
    if (n.type === "VariableDeclarator" && n.id && n.id.type === "Identifier" && n.init && n.init.body) {
      body = n.init.body; name = n.id.name;
    }
    if (!body || !name) return;
    const text = src.slice(body.start, body.end).replace(/\s+/g, " ");
    if (text.length < 200) return;
    const h = hash(text);
    if (!identicalGroups.has(h)) identicalGroups.set(h, { text, name, sites: [] });
    identicalGroups.get(h).sites.push({ file, line: n.loc.start.line, rel: path.relative(EXT, file) });
  });
}
const dupes = [];
for (const [, v] of identicalGroups) {
  const filesInvolved = new Set(v.sites.map((x) => x.file));
  if (filesInvolved.size >= 2) dupes.push({ ...v, n: filesInvolved.size });
}
if (dupes.length) {
  const first = dupes[0].sites[0];
  dupes.sort((a, b) => b.n - a.n);
  add("duplicate-logic", "P3", first.file, first.line,
    `${dupes.length} helper(s) byte-identical across provider files (expected for ` +
    `self-contained providers): ` +
    dupes.slice(0, 6).map((d) => `${d.name}×${d.n}`).join(", ") +
    (dupes.length > 6 ? `, +${dupes.length - 6} more` : ""),
    "keep them identical; divergence is what would hurt");
}

// ── 10. PROMPT TEXT THAT PROMISES SOMETHING THE CODE CANNOT DO ───────────
// The model reads these strings and plans around them. A false capability claim
// is not a cosmetic wart: it changes model behaviour and hides the real gap.
// Each entry below is a claim that was live in this tree, with the reason it is
// false. The check is deliberately narrow — it looks for the specific promise,
// not for prose that merely mentions a sandbox.
const FALSE_PROMISES = [
  {
    re: /(executes?|execute|runs?)\s+(?:it\s+)?(?:against|in)\s+(?:a\s+)?mock\s+Roblox/i,
    why: "there is no Luau VM in the extension; core/sandbox.js is static analysis",
  },
  {
    re: /runtime\s+TypeErrors?\s+are\s+intercepted/i,
    why: "nothing intercepts runtime errors; they surface in Studio",
  },
  {
    re: /(returns?|feeds?)\s+(?:the\s+)?(?:precise\s+)?stack/i,
    why: "a stack requires execution, which never happens here",
  },
  {
    re: /(\d{2})\s*%\s+of\s+(?:nil|TypeError|Type errors?)/i,
    why: "a hit rate for runtime errors cannot be measured without running code",
  },
];
const stripComments = (str) => str.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
for (const { file, src } of allFiles) {
  // Comments are where this project records what it USED to claim. Matching them
  // would flag the honesty notes themselves — sandbox.js says 'the old version
  // claimed to "run against a mock Roblox env", which it never did'. Only live
  // prompt text and user-facing strings can mislead a model.
  const live = stripComments(src);
  for (const p of FALSE_PROMISES) {
    const m = p.re.exec(live);
    if (!m) continue;
    const line = live.slice(0, m.index).split("\n").length;
    add("false-claim", "P2", file, line,
      `prompt/docs promise a capability the code lacks: "${m[0]}" — ${p.why}`,
      "state what the code actually does");
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
