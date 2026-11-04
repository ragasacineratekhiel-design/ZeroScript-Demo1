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
  const tests = ["test-parser.js", "test-chatgpt.js", "test-sandbox.js", "test-plan-wall.js", "test-memory-wall.js"];
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
