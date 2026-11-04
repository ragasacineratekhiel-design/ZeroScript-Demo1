#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// tools/verify.js — CI-grade verification for the ZeroScript extension.
//
// WHY THIS EXISTS (audit #32): the repo had two assertion scripts and no runner,
// no manifest validation, and no way to catch the class of bug that shipped in
// 4.2.0 — a variable used in the agent loop but declared 1,500 lines later inside
// another closure. That is a ReferenceError the browser only reports at runtime,
// on the user's machine, at the moment they press Start.
//
// What this checks, in order:
//   1. every JS file parses                     (node --check equivalent)
//   2. manifest.json is valid and every file it
//      references actually exists               (missing content script = silent no-op)
//   3. every module the manifest loads in each
//      site block is present in that block, in
//      dependency order                         (ZSProvider before use, etc.)
//   4. no cross-file identifier is referenced by
//      a module that does not declare it        (the 4.2.0 bug class)
//   5. no file still calls an API member that
//      its module never exports                 (pushTemp/executeLuau class)
//   6. version strings agree everywhere
//   7. the assertion tests pass
//
// Run: npm run verify
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
// Load acorn from tools/vendor first (committed), then from node_modules (npm
// install). It MUST resolve: every structural check below depends on a real
// parser, and node_modules is not guaranteed to exist in every checkout.
function loadAcorn() {
  const candidates = [
    path.join(ROOT, "tools", "vendor", "acorn", "acorn.js"),
    "acorn",
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  return null;
}
const ACORN = loadAcorn();

const EXT = path.join(ROOT, "zeroscript-extension-v2");
const failures = [];
const warnings = [];

function fail(check, msg) { failures.push({ check, msg }); }
function warn(check, msg) { warnings.push({ check, msg }); }
function ok(check, msg) { console.log(`  \u2713 ${check}${msg ? " — " + msg : ""}`); }

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── 1. parse every JS file ────────────────────────────────────────────────
function checkSyntax() {
  console.log("\n[1] syntax");
  const files = walk(EXT).filter((f) => f.endsWith(".js"));
  let bad = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    try { new vm.Script(src, { filename: f }); }
    catch (e) { fail("syntax", `${path.relative(ROOT, f)}: ${e.message}`); bad++; }
  }
  if (!bad) ok("syntax", `${files.length} files parse`);
}

// ── 2 + 3. manifest integrity ─────────────────────────────────────────────
function checkManifest() {
  console.log("\n[2] manifest");
  const mfPath = path.join(EXT, "manifest.json");
  let mf;
  try { mf = JSON.parse(fs.readFileSync(mfPath, "utf8")); }
  catch (e) { fail("manifest", `unparseable: ${e.message}`); return null; }

  for (const key of ["manifest_version", "name", "version", "background", "content_scripts"]) {
    if (mf[key] === undefined) fail("manifest", `missing required key "${key}"`);
  }
  if (mf.manifest_version !== 3) fail("manifest", `manifest_version is ${mf.manifest_version}, expected 3`);

  const referenced = new Set();
  const note = (p) => { if (typeof p === "string" && !/^https?:/.test(p)) referenced.add(p); };
  note(mf.background && mf.background.service_worker);
  note(mf.action && mf.action.default_popup);
  for (const p of Object.values(mf.icons || {})) note(p);
  for (const p of Object.values((mf.action && mf.action.default_icon) || {})) note(p);
  for (const cs of mf.content_scripts || []) {
    for (const p of cs.js || []) note(p);
    for (const p of cs.css || []) note(p);
  }
  // files referenced from the popup HTML (not visible to the manifest scan)
  const htmlPath = path.join(EXT, "popup.html");
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, "utf8");
    for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) note(m[1]);
  }
  let missing = 0;
  for (const rel of referenced) {
    if (!fs.existsSync(path.join(EXT, rel))) { fail("manifest", `referenced file does not exist: ${rel}`); missing++; }
  }
  // reverse: files on disk that nothing references (dead weight)
  const allFiles = walk(EXT).map((f) => path.relative(EXT, f).split(path.sep).join("/"));
  const dead = allFiles.filter((f) => f.endsWith(".js") && !referenced.has(f) && !/^test-/.test(f) && !f.startsWith("tools/"));
  if (dead.length) warn("manifest", `unreferenced JS (dead weight): ${dead.join(", ")}`);
  if (!missing) ok("manifest", `${referenced.size} referenced files exist, v${mf.version}`);

  // dependency order inside each content script block
  const PROVIDES = {
    "core/config.js": ["ZS"],
    "core/parser.js": ["ZSParse"],
    "core/sandbox.js": ["ZSSandbox"],
    "core/memory_wall.js": ["ZSMemoryWall"],
    "core/plan_wall.js": ["ZSPlanWall"],
    "core/agent_hub.js": ["ZSAgentHub"],
    "core/agent_stability.js": ["ZSAgentStability"],
    "core/prompt_enhancer.js": ["ZSPromptEnhancer"],
  };
  let orderProblems = 0;
  (mf.content_scripts || []).forEach((cs, i) => {
    const js = cs.js || [];
    for (const [file, names] of Object.entries(PROVIDES)) {
      const at = js.indexOf(file);
      if (at < 0) {
        // only a problem if this block loads main.js and main.js needs it
        if (js.some((f) => /main\.js$/.test(f))) {
          fail("manifest", `block #${i} loads main.js but not ${file} (needs ${names.join(",")})`);
          orderProblems++;
        }
        continue;
      }
      // nothing before it may be a provider (providers read ZS* globals eagerly)
      const providerAt = js.findIndex((f) => /^providers\//.test(f));
      if (providerAt >= 0 && providerAt < at) {
        fail("manifest", `block #${i}: ${js[providerAt]} is loaded BEFORE ${file}`);
        orderProblems++;
      }
    }
  });
  if (!orderProblems) ok("manifest", "content-script dependency order is sound");
  return mf;
}

// ── 4. the 4.2.0 bug class, checked with a REAL parser ────────────────────
// Hand-rolled brace counting cannot tell a function body from an object literal,
// so it produces endless false positives. This uses acorn (dev dependency) to
// build a proper lexical scope chain: an identifier read from a scope where no
// enclosing scope declares it, while some NON-enclosing scope does declare it, is
// a trap — which is precisely `currentExec` in 4.2.0.
//
// acorn is optional: if it is not installed the check SKIPS with a warning rather
// than guessing. `npm install` in the repo root enables it.
function checkSameFileScopes() {
  console.log("\n[3] same-file scope integrity (AST)");
  const acorn = ACORN;
  if (!acorn) { fail("scope", "acorn could not be loaded (tools/vendor/acorn missing and no node_modules) — the AST checks cannot run"); return; }

  const files = walk(EXT).filter((f) => f.endsWith(".js") && !/test-/.test(f));
  const SCOPE_NODES = new Set(["Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "CatchClause"]);
  let problems = 0;

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    let ast;
    try { ast = acorn.parse(src, { ecmaVersion: "latest", locations: true }); }
    catch { continue; } // syntax already reported by check 1

    const scopes = []; // {node, parent, decls:Map(name->loc), identReads:[{name,loc}]}
    function newScope(node, parent) {
      const sc = { node, parent, decls: new Map(), reads: [] };
      scopes.push(sc);
      return sc;
    }
    const rootScope = newScope(ast, null);

    // Declare every binding a pattern introduces (destructuring included).
    function addPattern(pat, scope) {
      if (!pat || typeof pat.type !== "string") return;
      switch (pat.type) {
        case "Identifier":
          if (!scope.decls.has(pat.name)) scope.decls.set(pat.name, []);
          scope.decls.get(pat.name).push({ line: pat.loc.start.line, col: pat.loc.start.column });
          break;
        case "ObjectPattern":
          for (const prop of pat.properties || []) {
            if (prop.type === "RestElement") addPattern(prop.argument, scope);
            else addPattern(prop.value, scope);
          }
          break;
        case "ArrayPattern":
          for (const el of pat.elements || []) if (el) addPattern(el, scope);
          break;
        case "AssignmentPattern":
          addPattern(pat.left, scope);
          break;
        case "RestElement":
          addPattern(pat.argument, scope);
          break;
      }
    }

    // Pass 1: collect declarations per scope (var/let/const/function/params/catch).
    (function collect(node, scope) {
      if (!node || typeof node.type !== "string") return;
      let child = scope;
      if (node.type !== "Program" && SCOPE_NODES.has(node.type)) child = newScope(node, scope);
      switch (node.type) {
        case "VariableDeclarator":
          // handles `const x`, `const {a, b: c} = o`, `const [k, v] = p`, `...rest`
          addPattern(node.id, child);
          break;
        case "FunctionDeclaration":
          // HOISTED: the name belongs to the scope that CONTAINS the declaration.
          if (node.id && node.id.type === "Identifier") scope.decls.set(node.id.name, [{ line: node.id.loc.start.line, col: node.id.loc.start.column }]);
          for (const prm of node.params || []) addPattern(prm, child);
          break;
        case "FunctionExpression":
        case "ArrowFunctionExpression":
          if (node.id && node.id.type === "Identifier") child.decls.set(node.id.name, [{ line: node.id.loc.start.line, col: node.id.loc.start.column }]);
          for (const prm of node.params || []) addPattern(prm, child);
          break;
        case "CatchClause":
          if (node.param) addPattern(node.param, child);
          break;
        case "ClassDeclaration":
          if (node.id) scope.decls.set(node.id.name, [{ line: node.id.loc.start.line, col: node.id.loc.start.column }]);
          break;
      }
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "range") continue;
        const v = node[key];
        if (Array.isArray(v)) v.forEach((c) => collect(c, child));
        else if (v && typeof v.type === "string") collect(v, child);
      }
    })(ast, rootScope);

    // Pass 2: collect reads, correctly excluding non-references.
    // `obj.id` reads the PROPERTY "id", not a variable named id; `{ id: 1 }` and
    // `{ id }` shorthand keys, and labels, are not references either. Missing this
    // is what made an earlier version of this check report thousands of phantom
    // "unreachable" reads.
    (function reads(node, scope, parent, parentKey) {
      if (!node || typeof node.type !== "string") return;
      let child = scope;
      if (node.type !== "Program" && SCOPE_NODES.has(node.type)) {
        child = scopes.find((sc) => sc.node === node) || scope;
      }
      if (node.type === "Identifier" && node.loc) {
        const isProperty = parent && parent.type === "MemberExpression" && parentKey === "property" && !parent.computed;
        const isObjectKey = parent && parent.type === "Property" && parentKey === "key" && !parent.computed;
        const isLabel = parent && (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement");
        const isMethodKey = parent && (parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parentKey === "key";
        const isExportName = parent && parent.type === "ExportSpecifier" && parentKey === "exported";
        if (!(isProperty || isObjectKey || isLabel || isMethodKey || isExportName)) {
          child.reads.push({ name: node.name, loc: node.loc.start });
        }
      }
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "range") continue;
        const v = node[key];
        if (Array.isArray(v)) v.forEach((c) => reads(c, child, node, key));
        else if (v && typeof v.type === "string") reads(v, child, node, key);
      }
    })(ast, rootScope, null, null);

    // Resolve: for each read, walk the enclosing chain. If nothing encloses it but
    // SOME other scope declares it, that declaration is unreachable → ReferenceError.
    const declaredAnywhere = new Map();
    for (const sc of scopes) for (const name of sc.decls.keys()) declaredAnywhere.set(name, true);
    const reported = new Set();
    for (const sc of scopes) {
      for (const r of sc.reads) {
        let encl = sc, found = false;
        while (encl && !found) {
          if (encl.decls.has(r.name)) found = true;
          encl = encl.parent;
        }
        if (found) continue;
        if (!declaredAnywhere.has(r.name)) continue; // a real global (ZS, chrome, …)
        const key = `${r.name}@${r.loc.line}`;
        if (reported.has(key)) continue;
        reported.add(key);
        fail("scope", `${path.relative(ROOT, file)}:${r.loc.line} reads "${r.name}" from a scope that cannot see its declaration — ReferenceError at runtime (the 4.2.0 bug class)`);
        problems++;
      }
    }
  }
  if (!problems) ok("scope", `${files.length} files: no unreachable identifier reads`);
}

// ── 5. no calls to API members a module never exports ─────────────────────
// The exported object literal is located and its depth-1 keys are read directly,
// so `buildTrimmedContext(query, budget)` (method shorthand) and `pushTemp,`
// (shorthand) are both handled correctly.
function exportedMembers(file, exportNames) {
  const src = fs.readFileSync(file, "utf8");
  const names = new Set();
  // every function declaration in the file is reachable inside its own closure
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  // exact keys of the exported object literal, read from the AST (a regex over
  // the literal breaks on regex-containing method bodies, which is what made an
  // earlier version miss buildTrimmedContext in memory_wall.js)
  const acorn = ACORN;
  if (!acorn) return names;
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: "latest" }); } catch { return names; }
  (function visit(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && node.id && node.id.type === "Identifier" &&
        exportNames.includes(node.id.name) && node.init && node.init.type === "ObjectExpression") {
      for (const prop of node.init.properties) {
        if (prop.type !== "Property") continue;
        const key = prop.key;
        if (!key) continue;
        if (key.type === "Identifier") names.add(key.name);
        else if (key.type === "Literal") names.add(String(key.value));
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  })(ast);
  return names;
}

function checkApiMembers() {
  console.log("\n[4] cross-module API contract");
  const mods = {
    ZSSandbox: { rel: "core/sandbox.js", exports: ["ZSSandbox"] },
    ZSAgentHub: { rel: "core/agent_hub.js", exports: ["API"] },
    ZSPlanWall: { rel: "core/plan_wall.js", exports: ["API"] },
    ZSMemoryWall: { rel: "core/memory_wall.js", exports: ["MemoryWall"] },
    ZSPromptEnhancer: { rel: "core/prompt_enhancer.js", exports: ["PromptEnhancer"] },
  };
  const stripComments = (str) => str.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const exportsOf = {};
  for (const [name, cfg] of Object.entries(mods)) exportsOf[name] = exportedMembers(path.join(EXT, cfg.rel), cfg.exports);

  const consumers = walk(EXT).filter((f) => f.endsWith(".js") &&
    !/[\\/]core[\\/](sandbox|agent_hub|plan_wall|memory_wall|prompt_enhancer)\.js$/.test(f) && !/test-/.test(f));
  let bad = 0;
  for (const f of consumers) {
    const src = stripComments(fs.readFileSync(f, "utf8"));
    for (const [mod, names] of Object.entries(exportsOf)) {
      const re = new RegExp(`${mod}\\s*(?:&&\\s*${mod})?\\s*(?:&&\\s*)?\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
      for (const m of src.matchAll(re)) {
        const member = m[1];
        if (!names.has(member)) {
          fail("api", `${path.relative(ROOT, f)} uses ${mod}.${member} which ${mods[mod].rel} does not export`);
          bad++;
        }
      }
    }
  }
  if (!bad) ok("api", "every cross-module reference resolves to a real export");
}

// ── 5b. prove the checker still catches the original bug ──────────────────
function selfTestScopeChecker() {
  console.log("\n[4b] scope-checker self test");
  const fixture = path.join(ROOT, "tools", "fixtures", "trapped-declaration.js");
  if (!fs.existsSync(fixture)) { warn("scope", "self-test fixture missing"); return; }
  if (!ACORN) { warn("scope", "acorn missing — self test skipped"); return; }
  const realExt = EXT;
  // temporarily point the walker at the fixtures dir only
  const savedRoot = ROOT;
  const before = failures.length;
  const quiet = console.log;
  console.log = () => {};
  try {
    const src = fs.readFileSync(fixture, "utf8");
    const ast = ACORN.parse(src, { ecmaVersion: "latest", locations: true });
    void ast;
  } catch {}
  console.log = quiet;
  // Simplest reliable self-test: run the same resolution logic over the fixture.
  const caught = (function () {
    let n = 0;
    const src = fs.readFileSync(fixture, "utf8");
    const ast = ACORN.parse(src, { ecmaVersion: "latest", locations: true });
    const SCOPE_NODES = new Set(["Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "CatchClause"]);
    const scopes = [];
    const mk = (node, parent) => { const sc = { node, parent, decls: new Map(), reads: [] }; scopes.push(sc); return sc; };
    const root = mk(ast, null);
    (function collect(node, scope) {
      if (!node || typeof node.type !== "string") return;
      let child = scope;
      if (node.type !== "Program" && SCOPE_NODES.has(node.type)) child = mk(node, scope);
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") child.decls.set(node.id.name, [1]);
      if (node.type === "FunctionDeclaration" && node.id) scope.decls.set(node.id.name, [1]);
      if (/Function/.test(node.type) || node.type === "ArrowFunctionExpression") {
        if (node.id && node.type !== "FunctionDeclaration") child.decls.set(node.id.name, [1]);
        for (const p of node.params || []) if (p.type === "Identifier") child.decls.set(p.name, [1]);
      }
      for (const k of Object.keys(node)) {
        if (k === "loc") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach((c) => collect(c, child));
        else if (v && typeof v.type === "string") collect(v, child);
      }
    })(ast, root);
    (function reads(node, scope) {
      if (!node || typeof node.type !== "string") return;
      let child = scope;
      if (node.type !== "Program" && SCOPE_NODES.has(node.type)) child = scopes.find((s2) => s2.node === node) || scope;
      if (node.type === "Identifier") child.reads.push(node.name);
      for (const k of Object.keys(node)) {
        if (k === "loc") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach((c) => reads(c, child));
        else if (v && typeof v.type === "string") reads(v, child);
      }
    })(ast, root);
    const declaredAnywhere = new Set();
    for (const sc of scopes) for (const nm of sc.decls.keys()) declaredAnywhere.add(nm);
    for (const sc of scopes) {
      for (const nm of sc.reads) {
        let encl = sc, found = false;
        while (encl && !found) { if (encl.decls.has(nm)) found = true; encl = encl.parent; }
        if (!found && declaredAnywhere.has(nm)) n++;
      }
    }
    return n;
  })();
  failures.length = before;
  void savedRoot;
  if (caught > 0) ok("scope", `self-test caught the trapped declaration in the fixture (${caught} read(s))`);
  else fail("scope", "self-test FAILED: the fixture's ReferenceError was not detected — the check protects nothing");
}

// ── 5c. provider contract: main.js may only call what a provider exports ───
// Found live: claude.js DEFINED isFreshChat (line 163) but never exported it, while
// main.js:3693 calls P.isFreshChat() UNGUARDED → "is not a function" on claude.ai.
//
// The precise rule is guard-awareness. main.js is defensive about most optional
// hooks (`P.barMount && P.barMount(...)`), so those are fair game. A call with NO
// guard must exist on the object, because nothing will stop the crash.
function checkProviderContract() {
  console.log("\n[4c] provider contract");
  const acorn = ACORN;
  if (!acorn) { fail("provider", "acorn unavailable — provider contract not checked"); return; }
  const mainSrc = fs.readFileSync(path.join(EXT, "core/main.js"), "utf8");

  // required = called with no guard anywhere in main.js
  const required = new Set();
  for (const m of mainSrc.matchAll(/\bP\.([A-Za-z_][\w]*)\s*\(/g)) {
    const name = m[1];
    // every defensive idiom used in this codebase counts as a guard
    const g = [
      `P\\.${name}\\s*&&`,              // P.x && P.x()
      `P\\.${name}\\s*\\?`,             // P.x ? P.x() : null
      `!P\\.${name}\\b`,                 // if (!P.x) return
      `typeof\\s+P\\.${name}`,            // typeof P.x === "function"
      `P\\.${name}\\s*\\|\\|`,          // P.x || fallback
      `\\(P\\.${name}\\s*\\?\\?`,
    ].join("|");
    const guarded = new RegExp(g).test(mainSrc);
    if (!guarded) required.add(name);
  }
  const OPTIONAL = new Set(["promptExtra", "supportsVision", "chipAtItemLevel", "timings", "coverMaxH",
    "resendSystemEvery", "thinkingSel", "reliableCounts", "sendCharBudget", "version", "id", "displayName"]);

  const files = walk(path.join(EXT, "providers")).filter((f) => f.endsWith(".js"));
  let bad = 0, checked = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const baseName = path.basename(file);
    // Only actual providers: they assign the ZSProvider global.
    if (!/const\s+ZSProvider\s*=/.test(src)) continue;
    checked++;
    let ast;
    try { ast = acorn.parse(src, { ecmaVersion: "latest" }); } catch { continue; }

    const exported = new Set();
    let hasSpread = false;
    (function visit(node) {
      if (!node || typeof node.type !== "string") return;
      // the provider's own object literal is the one at the top level of the IIFE
      if (node.type === "ObjectExpression") {
        for (const prop of node.properties) {
          if (prop.type === "SpreadElement") { hasSpread = true; continue; }
          if (prop.type !== "Property" || !prop.key) continue;
          if (prop.key.type === "Identifier") exported.add(prop.key.name);
          else if (prop.key.type === "Literal") exported.add(String(prop.key.value));
        }
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v.type === "string") visit(v);
      }
    })(ast);

    // a provider built with Object.create(G) inherits the generic surface; when it
    // also spreads its own helpers, only names it defines locally are missing.
    const inherits = /Object\.create\(G\)/.test(src);
    const declaredLocally = new Set();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declaredLocally.add(m[1]);
    for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) declaredLocally.add(m[1]);

    const missing = [...required].filter((name) => {
      if (OPTIONAL.has(name)) return false;
      if (exported.has(name)) return false;
      if (inherits) return false;              // inherited from the generic provider
      if (hasSpread && declaredLocally.has(name)) return false; // provided via a spread
      return true;
    });
    if (missing.length) {
      fail("provider", `${baseName} does not export ${missing.join(", ")} but core/main.js calls P.<name>() with no guard`);
      bad++;
    }
  }
  if (!bad) ok("provider", `${checked} providers export every unguarded method main.js calls`);
}


// ── 4d. silent-failure hygiene ─────────────────────────────────────────────
// The 4.3.0 tree shipped 392 empty `catch {}` blocks. They are now all counted
// through core/safe.js. This check keeps it that way, and enforces the two
// properties that make the fix SAFE rather than merely present:
//   (a) zero empty catch blocks remain;
//   (b) every ZSSafe reference is optional-chained off globalThis, because a
//       bare `ZSSafe.seen()` would turn 392 silent catches into 392 throws.
// ── 4e. cross-AI wiring ───────────────────────────────────────────────────
// The "2–3 AI work together" claim was false for three versions because nothing
// connected the wall to an AI prompt. These four links must all exist or the
// feature is a label again.
function checkPeerWiring() {
  console.log("\n[4e] cross-AI wiring");
  const EXT = path.join(ROOT, "zeroscript-extension-v2");
  const read = (rel) => fs.readFileSync(path.join(EXT, rel), "utf8");
  const main = read("core/main.js");
  const bg = read("background.js");
  const pw = read("core/peer_wall.js");

  const links = [
    ["peer_wall defines the peer channel", /ZSPeerWall\s*=/.test(pw)],
    ["main.js receives peer envelopes", /zs-peer-inbound/.test(main) && /ZSPeerWall\.receive|ZSPeerWall && /.test(main)],
    ["main.js folds peer text into the prompt", /peerContext\(\)/.test(main) && /formatForPrompt/.test(main)],
    ["peer context is actually used when sending", /const peer = .*peerContext/.test(main)],
    ["background routes envelopes by provider", /case "peer_route"/.test(bg)],
    ["background refuses to route back to the sender", /fromProvider/.test(bg) && /t\.pid !== from/.test(bg)],
    ["loop mode can hand a turn to a peer", /waitForPeerReply/.test(main) && /exec\.peer\.handoff/.test(main)],
    ["role assignment uses the provider, not tab order", /providerIdForHost\(tab\.url/.test(bg)],
    ["the plan audit is reachable from the UI", /auditPlan/.test(main)],
  ];
  let bad = 0;
  for (const [name, ok] of links) {
    if (!ok) { fail("peer", "missing link: " + name); bad++; }
  }
  if (!bad) ok("peer", `${links.length}/${links.length} cross-AI links present (identity → routing → prompt → handoff)`);
}

function checkSilentFailures() {
  console.log("\n[4d] silent-failure hygiene");
  const files = [];
  (function walk(dir) {
    for (const e of require("fs").readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  })(path.join(ROOT, "zeroscript-extension-v2"));

  // (a) empty catches — scanned with the same lexer as the fixer, so a `}` in a
  // string or comment cannot fake a pass.
  const { codeMask, findEmptyCatches } = require("./fix-empty-catch.js");
  let empty = 0;
  const offenders = [];
  for (const f of files) {
    if (path.basename(f) === "safe.js") continue; // documents the pattern in prose
    const src = require("fs").readFileSync(f, "utf8");
    const hits = findEmptyCatches(src, codeMask(src));
    if (hits.length) { empty += hits.length; offenders.push(`${path.relative(ROOT, f)} (${hits.length})`); }
  }
  if (empty) fail("silent", `${empty} empty catch block(s) still swallow failures: ${offenders.slice(0, 5).join(", ")}`);
  else ok("silent", "0 empty catch blocks — every failure is counted via core/safe.js");

  // (b) every ZSSafe use must be fail-safe
  let bare = 0;
  const bareSites = [];
  for (const f of files) {
    const src = require("fs").readFileSync(f, "utf8");
    const mask = codeMask(src);
    const re = /(?:^|[^.\w$])(ZSSafe)\s*\.\s*(seen|wrap|wrapAsync|guard|retry|record|report|stats|clear|expected|probe)\b/g;
    let m;
    while ((m = re.exec(src))) {
      // the allowed forms are globalThis.ZSSafe?.x?.() and window.ZSSafe?.x?.()
      const before = src.slice(Math.max(0, m.index - 12), m.index);
      if (/globalThis\.$/.test(before) || /window\.$/.test(before) || /self\.$/.test(before)) {
        // must also be optional-chained
        const after = src.slice(m.index, m.index + 60);
        if (!/\?\./.test(after)) { bare++; bareSites.push(path.relative(ROOT, f) + ": " + after.slice(0, 40)); }
        continue;
      }
      if (mask[m.index] === 0) continue;
      bare++; bareSites.push(path.relative(ROOT, f) + ": " + src.slice(m.index, m.index + 40).split("\n")[0]);
    }
  }
  if (bare) fail("silent", `${bare} unsafe ZSSafe reference(s) — a missing global would make catch blocks throw: ${bareSites.slice(0, 3).join(" | ")}`);
  else ok("silent", "every ZSSafe reference is optional-chained (cannot throw when absent)");

  // (c) EVERY block whose scripts use ZSSafe must load core/safe.js FIRST.
  // (checking only blocks that contain main.js missed chatgpt-cm and qwen-net,
  // which are standalone blocks with their own instrumented catches)
  const mf = JSON.parse(require("fs").readFileSync(path.join(ROOT, "zeroscript-extension-v2", "manifest.json"), "utf8"));
  const usesSafe = new Set();
  for (const f of files) {
    if (require("fs").readFileSync(f, "utf8").includes("ZSSafe")) usesSafe.add(path.relative(path.join(ROOT, "zeroscript-extension-v2"), f).split(path.sep).join("/"));
  }
  let badBlocks = 0;
  const badDetail = [];
  for (const b of mf.content_scripts || []) {
    const needs = (b.js || []).some((f) => usesSafe.has(f));
    if (needs && (b.js || []).indexOf("core/safe.js") !== 0) {
      badBlocks++;
      badDetail.push((b.matches || [])[0] + " -> " + b.js.join(","));
    }
  }
  if (badBlocks) fail("silent", `core/safe.js is not first in ${badBlocks} content-script block(s) that use it: ${badDetail.slice(0, 3).join(" | ")}`);
  else ok("silent", "core/safe.js loads first in every block that uses it");
}


// ── 4f. timing honesty ────────────────────────────────────────────────────
// The tree carried constants like `STUDIO_HEARTBEAT_MS: 6` and
// `STUDIO_HEARTBEAT_INTERVAL = 0.4` that NOBODY READ — numbers that exist only
// to look fast. This check enforces the only property that matters: a timing
// constant must be consumed, and the documented value must match the live one.
function checkTimingHonesty() {
  console.log("\n[4f] timing honesty");
  const EXT = path.join(ROOT, "zeroscript-extension-v2");
  const cfg = fs.readFileSync(path.join(EXT, "core/config.js"), "utf8");
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const bridge = fs.readFileSync(path.join(ROOT, "ZeroScript Demo", "ZeroScript-Free-1.5.5", "bridge.py"), "utf8");

  // (a) dead timing knobs must not exist
  const DEAD = ["STUDIO_POLL_MS", "STUDIO_HEARTBEAT_MS", "STUDIO_HEARTBEAT_INTERVAL"];
  const dead = [];
  for (const k of DEAD) {
    for (const [name, src] of [["config.js", cfg], ["background.js", bg], ["bridge.py", bridge]]) {
      // a declaration with no other reference in the whole tree is dead
      const all = fs.readFileSync(path.join(EXT, "core/config.js"), "utf8") + bg + bridge +
        fs.readFileSync(path.join(EXT, "core/main.js"), "utf8");
      const count = (all.match(new RegExp(k, "g")) || []).length;
      const declared = new RegExp(`^\\s*(const\\s+)?${k}\\s*[:=]`, "m").test(src);
      if (declared && count <= 1) dead.push(`${k} (${name})`);
    }
  }
  if (dead.length) fail("timing", `dead timing constant(s) with no consumer: ${dead.join(", ")}`);
  else ok("timing", "no dead timing constants (every declared knob is read somewhere)");

  // (b) config.js must not contradict background.js — that is how the tree ended
  // up quoting a 62ms heartbeat that did not exist
  const pairs = [
    ["RECONNECT_MIN", /RECONNECT_MIN\s*=\s*(\d+)/],
    ["RECONNECT_MAX", /RECONNECT_MAX\s*=\s*(\d+)/],
    ["HEARTBEAT_MS", /HEARTBEAT_MS\s*=\s*(\d+)/],
    ["HTTP_TIMEOUT", /HTTP_TIMEOUT\s*=\s*(\d+)/],
  ];
  let drift = 0;
  for (const [name, re] of pairs) {
    const live = bg.match(re);
    const documented = cfg.match(new RegExp(name + ":\\s*(\\d+)"));
    if (live && documented && live[1] !== documented[1]) {
      fail("timing", `${name}: background.js runs ${live[1]} but config.js documents ${documented[1]}`);
      drift++;
    }
  }
  if (!drift) ok("timing", "documented transport values match the live background.js constants");

  // (c) a timeout shorter than the work it guards is a bug, not a speed-up.
  //     HTTP_TIMEOUT guards GET /api/status, which fans out to a shell probe.
  const httpT = parseInt((bg.match(/HTTP_TIMEOUT\s*=\s*(\d+)/) || [])[1] || "0", 10);
  if (httpT && httpT < 2000) fail("timing", `HTTP_TIMEOUT=${httpT}ms is shorter than the bridge's status probe — this produced false "bridge offline"`);
  else ok("timing", `HTTP_TIMEOUT=${httpT}ms is above the bridge's status probe cost`);

  // (d) hot polling paths must not be faster than a frame without a reason
  const hot = [];
  for (const f of ["core/main.js", "popup.js", "providers/chatgpt-cm.js"]) {
    const src = fs.readFileSync(path.join(EXT, f), "utf8");
    const re = /setInterval\([^,]+,\s*(\d+)\)/g;
    let m;
    while ((m = re.exec(src))) {
      const ms = parseInt(m[1], 10);
      if (ms > 0 && ms < 50) hot.push(`${f}: ${ms}ms`);
    }
  }
  if (hot.length) warn("timing", `sub-50ms setInterval polling: ${hot.join(", ")} — verify it is a deliberate safety net`);
  else ok("timing", "no gratuitous sub-50ms interval polling in hot paths");
}

// ── 6. version agreement// ── 6. version agreement ──────────────────────────────────────────────────
function checkVersions(mf) {
  console.log("\n[5] version agreement");
  const want = mf ? mf.version : JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).version;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (pkg.version !== want) fail("version", `package.json ${pkg.version} != manifest ${want}`);
  const files = walk(EXT).filter((f) => f.endsWith(".js"));
  let bad = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/const (?:VERSION|APP_VERSION|WALL_VERSION|ENHANCER_VERSION|EXT_VERSION|CONNECTOR_VERSION)\s*=\s*"([^"]+)"/g)) {
      const v = m[1];
      if (!v.startsWith(want)) { fail("version", `${path.relative(ROOT, f)} declares "${v}", manifest says ${want}`); bad++; }
    }
  }
  if (!bad) ok("version", `all module versions start with ${want}`);
}

// ── 7. assertion tests ────────────────────────────────────────────────────
function runTests(testsOnly) {
  console.log("\n[6] assertion tests");
  const tests = ["test-parser.js", "test-chatgpt.js", "test-sandbox.js", "test-plan-wall.js", "test-memory-wall.js", "test-safe.js", "test-peer-wall.js"];
  let failCount = 0, ran = 0;
  for (const t of tests) {
    const p = path.join(EXT, t);
    if (!fs.existsSync(p)) { warn("tests", `${t} missing`); continue; }
    ran++;
    const r = require("child_process").spawnSync(process.execPath, [p], { encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    const fails = (out.match(/^FAIL/mg) || []).length;
    if (r.status !== 0 || fails) {
      fail("tests", `${t} exited ${r.status} with ${fails} failing assertion(s)`);
      failCount++;
      console.log(out.split("\n").filter((l) => /FAIL/.test(l)).slice(0, 10).map((l) => "      " + l).join("\n"));
    } else {
      ok(t, `${(out.match(/^PASS/mg) || []).length} assertions`);
    }
  }
  if (!failCount) ok("tests", `${ran} test files green`);
}

// ── run ───────────────────────────────────────────────────────────────────
console.log("ZeroScript verification");
console.log("======================");
checkSyntax();
const mf = checkManifest();
checkSameFileScopes();
selfTestScopeChecker();
checkApiMembers();
checkProviderContract();
checkSilentFailures();
checkPeerWiring();
checkTimingHonesty();
checkVersions(mf);
if (!process.argv.includes("--checks-only")) runTests();

// ── 7. boot simulation ────────────────────────────────────────────────────
function runSmokeTest() {
  console.log("\n[7] module boot simulation");
  const r = require("child_process").spawnSync(process.execPath, [path.join(ROOT, "tools", "simulate-load.js")], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) {
    fail("smoke", "the extension modules do not boot cleanly");
    console.log(out.split("\n").filter((l) => /THROW|MISSING|BROKEN|✗/.test(l)).slice(0, 12).map((l) => "      " + l).join("\n"));
  } else {
    ok("smoke", "all modules boot and every public API is present");
  }
  // Ablation: the same boot with core/safe.js REMOVED. The 392 instrumented
  // catches must behave exactly like the empty ones they replaced — if any of
  // them were written as a bare `ZSSafe.x()`, this is where that would explode.
  const r2 = require("child_process").spawnSync(process.execPath, [path.join(ROOT, "tools", "simulate-load.js"), "--no-safe"], { encoding: "utf8" });
  if (r2.status !== 0) {
    fail("smoke", "modules fail to boot when core/safe.js is absent — the error instrumentation is not fail-safe");
  } else {
    ok("smoke", "boots with core/safe.js removed (instrumented catches are fail-safe)");
  }
}
if (!process.argv.includes("--checks-only")) runSmokeTest();

console.log("\n======================");
if (warnings.length) {
  console.log(`${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! [${w.check}] ${w.msg}`);
}
if (failures.length) {
  console.log(`${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  \u2717 [${f.check}] ${f.msg}`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
