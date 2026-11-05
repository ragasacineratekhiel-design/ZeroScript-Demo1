// SPDX-License-Identifier: GPL-3.0-or-later
// tools/fix-empty-catch.js — one-shot, auditable transformer.
//
// Replaces `catch {}` / `catch (e) {}` with `catch (e) { ZSSafe.seen("<site>", e); }`
// so that every previously-swallowed failure is at least COUNTED, and reports
// the ones a human still needs to turn into a real repair.
//
// Why not a regex: `}` inside a string, a template literal, a regex literal or
// a comment would desynchronise a naive scan and corrupt the file. This walks
// the source with a small lexer that understands all four.
//
// Usage:
//   node tools/fix-empty-catch.js --report        (list sites, change nothing)
//   node tools/fix-empty-catch.js --write         (apply)
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "zeroscript-extension-v2");

// Files that run in a browser/worker context where ZSSafe is loaded by manifest.
// (sandbox.js/parser.js are also require()d by tests — handled separately.)
const SKIP = new Set(["core/safe.js"]);

// ── minimal lexer: returns "code" masks so we only ever edit code ──────────
function codeMask(src) {
  const n = src.length;
  const mask = new Uint8Array(n).fill(1); // 1 = code, 0 = string/comment/regex
  let i = 0;
  let prevSignificant = ""; // last non-space code char, for regex detection
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") mask[i++] = 0;
      continue;
    }
    if (c === "/" && c2 === "*") {
      mask[i++] = 0; mask[i++] = 0;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) mask[i++] = 0;
      if (i < n) { mask[i++] = 0; mask[i++] = 0; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      mask[i++] = 0;
      while (i < n) {
        if (src[i] === "\\") { mask[i++] = 0; if (i < n) mask[i++] = 0; continue; }
        if (src[i] === q) { mask[i++] = 0; break; }
        // template literal interpolation: keep `${...}` as code so a } inside
        // an expression does not terminate the literal scan
        if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
          mask[i++] = 0; mask[i++] = 0;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            i++;
          }
          continue;
        }
        mask[i++] = 0;
      }
      prevSignificant = q;
      continue;
    }
    if (c === "/" && /[=(,:[!&|?{};+\-*%^~<>]|^$/.test(prevSignificant)) {
      // regex literal
      mask[i++] = 0;
      let inClass = false;
      while (i < n) {
        if (src[i] === "\\") { mask[i++] = 0; if (i < n) mask[i++] = 0; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { mask[i++] = 0; break; }
        else if (src[i] === "\n") break;
        mask[i++] = 0;
      }
      while (i < n && /[a-z]/i.test(src[i])) mask[i++] = 0; // flags
      prevSignificant = "/";
      continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return mask;
}

// ── find `catch (x?) { <nothing> }` spans in code ─────────────────────────
function findEmptyCatches(src, mask) {
  const out = [];
  const n = src.length;
  const re = /\bcatch\b/g;
  let m;
  while ((m = re.exec(src))) {
    if (!mask[m.index]) continue;
    let i = m.index + 5;
    const ws = () => { while (i < n && /\s/.test(src[i])) i++; };
    ws();
    let param = null;
    if (src[i] === "(") {
      const start = ++i;
      let depth = 1;
      while (i < n && depth > 0) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        if (depth > 0) i++;
      }
      param = src.slice(start, i).trim();
      i++; // past ')'
      ws();
    }
    if (src[i] !== "{") continue;
    const braceStart = i;
    // an empty body is only whitespace/comments between the braces
    let j = i + 1;
    let hasCode = false;
    while (j < n && src[j] !== "}") {
      if (mask[j] && !/\s/.test(src[j])) { hasCode = true; break; }
      j++;
    }
    if (hasCode) continue;
    // j points at '}' — confirm it is the matching one (no nesting possible in
    // an empty body, but the mask guarantees we skipped strings/comments)
    if (src[j] !== "}") continue;
    out.push({ at: m.index, braceStart, braceEnd: j, param });
    re.lastIndex = j;
  }
  return out;
}

// ── site naming: file + enclosing function, so stats are actually readable ─
function siteName(src, offset, file) {
  const before = src.slice(0, offset);
  // nearest enclosing top-level-ish function declaration or arrow assignment
  const fnRe = /(?:function\s+([A-Za-z0-9_$]+)\s*\(|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function|\())/g;
  const candidates = [];
  let mm;
  while ((mm = fnRe.exec(before))) candidates.push(mm[1] || mm[2]);
  // Walk outwards past throwaway names. `const P = …` / `A` / `w` are module
  // aliases, not functions — a site called "agent_stability.P" tells a user
  // nothing, so prefer the nearest MEANINGFUL enclosing name.
  const BAD = /^[A-Za-z_$]$|^(P|G|A|w|el|o|e|r|m|s|t|x)$/;
  let name = "";
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (!BAD.test(candidates[i])) { name = candidates[i]; break; }
  }
  // "providers/claude" reads better as "claude" in a short diagnostic
  const short = file.replace(/^\.\//, "").replace(/\.js$/, "")
    .replace(/^core\//, "").replace(/^providers\//, "");
  return short + (name ? "." + name : "");
}

function processFile(rel, write) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, "utf8");
  const mask = codeMask(src);
  const hits = findEmptyCatches(src, mask);
  if (!hits.length) return { rel, changed: 0, sites: [] };
  const sites = [];
  let out = "";
  let cursor = 0;
  for (const h of hits) {
    const site = siteName(src, h.at, rel);
    sites.push(site);
    // A `catch {}` has NO binding. Emitting seen(site, e) there would be a
    // ReferenceError in the exact place that used to be safe, so the whole
    // header is regenerated and a binding is therefore guaranteed to exist.
    const plain = h.param && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(h.param);
    const param = plain ? h.param : "_e";
    // globalThis.ZSSafe?.seen?.(...) is CRITICAL: a bare ZSSafe.x would make
    // every one of these catches THROW if the module were absent, turning
    // silent failures into page-wide breakage. Optional chaining on globalThis
    // can never throw.
    const body = "catch (" + param + ') { globalThis.ZSSafe?.seen?.("' + site + '", ' + param + "); }";
    out += src.slice(cursor, h.at) + body;
    cursor = h.braceEnd + 1;
  }
  out += src.slice(cursor);
  if (write && out !== src) fs.writeFileSync(abs, out);
  return { rel, changed: hits.length, sites };
}

module.exports = { codeMask, findEmptyCatches, siteName };

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

if (require.main !== module) return; // required as a library by tools/verify.js

// ── --rename: re-derive the site label on already-instrumented code ───────
// Lets the naming heuristic improve without re-running the whole transform
// (which would clobber hand-written repairs made after the first pass).
if (process.argv.includes("--rename")) {
  let changed = 0;
  for (const rel of walk(ROOT).map((p) => path.relative(ROOT, p)).filter((r) => !SKIP.has(r)).sort()) {
    const abs = path.join(ROOT, rel);
    const src = fs.readFileSync(abs, "utf8");
    const mask = codeMask(src);
    const re = /\?\.seen\?\.\("([^"]*)"/g;
    let out = "";
    let cursor = 0;
    let m;
    let touched = false;
    while ((m = re.exec(src))) {
      if (mask[m.index] === 0) continue;
      const want = siteName(src, m.index, rel);
      if (want !== m[1]) {
        out += src.slice(cursor, m.index) + '?.seen?.("' + want + '"';
        cursor = m.index + m[0].length;
        touched = true;
        changed++;
      }
    }
    out += src.slice(cursor);
    if (touched && out !== src) fs.writeFileSync(abs, out);
  }
  console.log(`renamed ${changed} diagnostic sites`);
  return;
}

const write = process.argv.includes("--write");
const files = walk(ROOT)
  .map((p) => path.relative(ROOT, p))
  .filter((r) => !SKIP.has(r))
  .sort();

let total = 0;
const perFile = [];
for (const rel of files) {
  const r = processFile(rel, write);
  if (r.changed) { total += r.changed; perFile.push(r); }
}
perFile.sort((a, b) => b.changed - a.changed);
for (const r of perFile) console.log(`${String(r.changed).padStart(4)}  ${r.rel}`);
console.log(`\n${write ? "replaced" : "would replace"} ${total} empty catch blocks in ${perFile.length} files`);
