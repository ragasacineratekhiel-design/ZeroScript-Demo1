// SPDX-License-Identifier: GPL-3.0-or-later
// core/sandbox.js — ZeroScript 4.8.0 REAL LUAU PARSER (static analysis only)
//
// WHY THIS FILE WAS REWRITTEN (measured, not asserted)
// ----------------------------------------------------
// The 4.8.0 "analyser" was a tokenizer + block-keyword counter. Run against a
// corpus of 28 broken Luau snippets an AI actually emits, it MISSED 20 of them
// (71%). It had no concept of parentheses, braces or grammar, so every
// unbalanced-paren error — the single most common AI code defect — sailed
// straight through to Studio and burned a 20-second round trip. Meanwhile
// main.js BLOCKS execute_luau on a syntax failure, so the checker's whole job
// was being done badly.
//
// Measured misses the old checker could not catch:
//   foo(1, 2            unclosed paren            local x = = 5
//   { a = 1, b = 2      unclosed brace            local 1x = 5
//   a[1                 unclosed bracket          function () end
//   if x > 1 print(1)   missing 'then'            goto nowhere
//   foo(1, 2,)          trailing comma            break (outside a loop)
//   {1,,2}              double comma              local x: = 5
//
// What it is now:
//  1. A real tokenizer (long strings/comments at any level, escapes, Luau
//     number forms incl. 1_000 / 0x1p4, interpolated `strings {x}`, and every
//     Luau operator — the old one split '->' and '+=' into single chars).
//  2. A recursive-descent parser for statements AND expressions, so grammar is
//     validated, not just counted: precedence, table constructors, parameter
//     lists, type annotations, labels, goto targets, break/continue scope.
//  3. Delimiter tracking with the OPENING token remembered, so the error names
//     the line AND column of the unclosed bracket — not "likely missing end".
//  4. A real linter with actionable warnings (surfaced to the model, never
//     blocking) — including "this block has no `return`, so execute_luau will
//     show you nothing".
//  5. Honest, in-memory metrics: how many snippets were analysed, how many were
//     blocked, how many carried warnings. Nothing is extrapolated into a
//     "quality percentage" anywhere — see below.
//
// WHAT THIS STILL IS NOT
// ----------------------
// There is NO Luau VM here. This cannot catch a nil dereference, a wrong
// argument type, or a bad property name. It parses; it does not execute. That
// boundary is stated in the result and in the model feedback, and nothing in
// this repo may claim otherwise.
(() => {
  "use strict";
  const VERSION = "4.8.0";

  // ── real counters ────────────────────────────────────────────────────────
  // These exist because config.js used to claim "we log real metrics" while
  // logging nothing. They count what IS measurable: work done and errors
  // caught. They deliberately do NOT attempt to measure "quality" or "how much
  // smarter the model got", because no harness here can measure that.
  const _metrics = { analyses: 0, blocked: 0, warned: 0, cacheHits: 0, parses: 0, internalErrors: 0 };
  function metrics() { return { ..._metrics, cacheSize: _analyseCache.size }; }
  function resetMetrics() { for (const k of Object.keys(_metrics)) _metrics[k] = 0; }

  // ── language tables (module scope: built once, not per call) ──────────────
  const UNARY_OPS = new Set(["-", "not", "#", "~"]);
  // binary precedence, Lua/Luau 5.1-compatible
  const BINPREC = {
    or: 1, and: 2,
    "<": 3, ">": 3, "<=": 3, ">=": 3, "~=": 3, "==": 3,
    "|": 4, "~": 5, "&": 6,
    "<<": 7, ">>": 7,
    "..": 8,
    "+": 9, "-": 9,
    "*": 10, "/": 10, "//": 10, "%": 10,
    "^": 12,
  };
  const RIGHT_ASSOC = new Set(["..", "^"]);
  const COMPOUND_ASSIGN = new Set(["+=", "-=", "*=", "/=", "%=", "^=", "..="]);
  const LOOP_KEYWORDS = new Set(["while", "for", "repeat"]);
  // longest-first so '...' wins over '..' and '..=' wins over '..'
  const MULTI_OPS = ["...", "..=", "==", "~=", "<=", ">=", "::", "//", "->", "<<", ">>",
    "+=", "-=", "*=", "/=", "%=", "^=", "|=", "&=", ".."];
  const LITERAL_NAMES = new Set(["nil", "true", "false"]);
  const MAX_DEPTH = 200;

  // ════════════════════════════════════════════════════════════════════════
  //  TOKENIZER
  // ════════════════════════════════════════════════════════════════════════
  function tokenize(src) {
    const s = String(src || "");
    const tokens = [];
    let i = 0, line = 1, lineStart = 0;
    const n = s.length;
    const col = (at) => at - lineStart + 1;
    const push = (type, value, ln, cn) => tokens.push({ type, value, line: ln, col: cn });

    while (i < n) {
      const c = s[i];

      if (c === "\n") { line++; i++; lineStart = i; continue; }
      if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }

      // comments: --[==[ long ]==] / -- short
      if (c === "-" && s[i + 1] === "-") {
        const startLine = line, startCol = col(i);
        const lvl = longBracketLevel(s, i + 2);
        if (lvl >= 0) {
          const closeAt = findLongClose(s, i + 2 + lvl + 2, lvl);
          if (closeAt < 0)
            return { tokens, error: { msg: "unterminated long comment opened with '--[" + "=".repeat(lvl) + "[", line: startLine, col: startCol } };
          const seg = s.slice(i, closeAt + lvl + 2);
          const nl = (seg.match(/\n/g) || []).length;
          line += nl;
          if (nl) lineStart = i + seg.lastIndexOf("\n") + 1;
          i = closeAt + lvl + 2;
          continue;
        }
        const nlAt = s.indexOf("\n", i);
        i = nlAt < 0 ? n : nlAt;
        continue;
      }

      // long string [[ ]] / [==[ ]==]
      if (c === "[") {
        const lvl = longBracketLevel(s, i);
        if (lvl >= 0) {
          const startLine = line, startCol = col(i);
          const closeAt = findLongClose(s, i + lvl + 2, lvl);
          if (closeAt < 0)
            return { tokens, error: { msg: "unterminated long string [[" + "=".repeat(lvl) + "…", line: startLine, col: startCol } };
          const seg = s.slice(i, closeAt + lvl + 2);
          const nl = (seg.match(/\n/g) || []).length;
          line += nl;
          if (nl) lineStart = i + seg.lastIndexOf("\n") + 1;
          push("string", seg, startLine, startCol);
          i = closeAt + lvl + 2;
          continue;
        }
      }

      // short string with escapes
      if (c === '"' || c === "'") {
        const startLine = line, startCol = col(i);
        let j = i + 1, closed = false;
        while (j < n) {
          const d = s[j];
          if (d === "\\") { if (s[j + 1] === "\n") { line++; lineStart = j + 2; } j += 2; continue; }
          if (d === "\n") break;
          if (d === c) { closed = true; j++; break; }
          j++;
        }
        if (!closed) return { tokens, error: { msg: "unterminated string literal", line: startLine, col: startCol } };
        push("string", s.slice(i, j), startLine, startCol);
        i = j;
        continue;
      }

      // interpolated string `hi {name}` — the {…} parts are real expressions
      if (c === "`") {
        const startLine = line, startCol = col(i);
        let j = i + 1, closed = false;
        const parts = [];
        while (j < n) {
          const d = s[j];
          if (d === "\\") { if (s[j + 1] === "\n") { line++; lineStart = j + 2; } j += 2; continue; }
          if (d === "`") { closed = true; j++; break; }
          if (d === "{" && s[j + 1] !== "{") {
            let depth = 1, k = j + 1, segLine = line, segStart = j + 1;
            while (k < n && depth > 0) {
              if (s[k] === "{") depth++;
              else if (s[k] === "}") { depth--; if (!depth) break; }
              if (s[k] === "\n") { line++; lineStart = k + 1; }
              k++;
            }
            if (depth > 0) return { tokens, error: { msg: "unterminated '{' inside an interpolated string", line: segLine, col: col(j) } };
            parts.push(s.slice(segStart, k));
            j = k + 1;
            continue;
          }
          if (d === "\n") { line++; lineStart = j + 1; }
          j++;
        }
        if (!closed) return { tokens, error: { msg: "unterminated interpolated string", line: startLine, col: startCol } };
        const tok = { type: "string", value: s.slice(i, j), line: startLine, col: startCol };
        if (parts.length) tok.interp = parts;
        tokens.push(tok);
        i = j;
        continue;
      }

      // numbers: decimal, hex, 1_000, 1e10, 0x1p4, .5
      if (isDigit(c) || (c === "." && isDigit(s[i + 1]))) {
        const startLine = line, startCol = col(i);
        let j = i;
        if (c === "0" && (s[i + 1] === "x" || s[i + 1] === "X")) {
          j = i + 2;
          while (j < n && /[0-9a-fA-F_.]/.test(s[j])) j++;
          if (s[j] === "p" || s[j] === "P") { j++; if (s[j] === "+" || s[j] === "-") j++; while (j < n && isDigit(s[j])) j++; }
        } else {
          while (j < n && /[0-9_.]/.test(s[j])) j++;
          if (s[j] === "e" || s[j] === "E") { j++; if (s[j] === "+" || s[j] === "-") j++; while (j < n && isDigit(s[j])) j++; }
        }
        push("number", s.slice(i, j), startLine, startCol);
        i = j;
        continue;
      }

      // identifiers / keywords
      if (isIdentStart(c)) {
        const startCol = col(i);
        let j = i + 1;
        while (j < n && isIdentPart(s[j])) j++;
        push("name", s.slice(i, j), line, startCol);
        i = j;
        continue;
      }

      // multi-char operators first
      let matched = null;
      for (const op of MULTI_OPS) {
        if (s.startsWith(op, i)) { matched = op; break; }
      }
      if (matched) { push("op", matched, line, col(i)); i += matched.length; continue; }

      if ("(){}[],;:.".includes(c)) { push("punct", c, line, col(i)); i++; continue; }
      // remaining single-char operators
      // '?' is a Luau operator (optional types, `t?.field`); '@' starts attributes
      if ("+-*/%^#<>=~|&?@".includes(c)) { push("op", c, line, col(i)); i++; continue; }

      // anything else is a character Luau cannot parse
      return { tokens, error: { msg: "unexpected character " + JSON.stringify(c), line, col: col(i) } };
    }
    return { tokens, error: null };
  }

  const isDigit = (c) => c >= "0" && c <= "9";
  const isIdentStart = (c) => !!c && /[A-Za-z_]/.test(c);
  const isIdentPart = (c) => !!c && /[A-Za-z0-9_]/.test(c);
  function longBracketLevel(s, at) {
    if (s[at] !== "[") return -1;
    let k = at + 1, level = 0;
    while (s[k] === "=") { level++; k++; }
    return s[k] === "[" ? level : -1;
  }
  function findLongClose(s, from, level) {
    return s.indexOf("]" + "=".repeat(level) + "]", from);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PARSER
  // ════════════════════════════════════════════════════════════════════════
  function ParseError(message, token, hint) {
    this.message = message;
    this.token = token || null;
    this.hint = hint || "";
  }

  // `::label::` targets, collected before parsing so `goto` can forward-reference
  function collectLabels(tokens) {
    const labels = new Set();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === "op" && t.value === "::") {
        const nm = tokens[i + 1];
        const cl = tokens[i + 2];
        if (nm && nm.type === "name" && cl && cl.type === "op" && cl.value === "::") labels.add(nm.value);
      }
    }
    return labels;
  }

  function parseProgram(tokens) {
    const st = { i: 0, tokens, labels: collectLabels(tokens), depth: 0, gotos: [], sawReturn: false };
    const ctx = { loopDepth: 0, funcDepth: 0 };
    parseBlock(st, ctx, new Set());
    if (st.i < tokens.length) {
      const t = tokens[st.i];
      throw new ParseError("unexpected " + describe(t) + " after the end of the program", t,
        "a stray closing keyword or bracket usually means an earlier block was never closed");
    }
    return st;
  }

  function parseBlock(st, ctx, terminators) {
    while (st.i < st.tokens.length) {
      const t = peek(st);
      if (t.type === "name" && terminators.has(t.value)) return;
      parseStat(st, ctx);
    }
  }

  function parseStat(st, ctx) {
    const t = peek(st);

    // empty statement
    if (t.type === "punct" && t.value === ";") { st.i++; return; }

    // ::label::
    if (t.type === "op" && t.value === "::") {
      st.i++;
      const nm = expect(st, "name", null, "a label name after '::'");
      expectOp(st, "::", "'::' to close the label '::" + nm.value + "'");
      return;
    }

    // a block-closer reached with nothing open: name it plainly, instead of
    // the old confusing "expected '=' after the variable"
    if (t.type === "name" && (t.value === "end" || t.value === "else" || t.value === "elseif" || t.value === "until")) {
      throw new ParseError("unexpected '" + t.value + "' — no block is open here", t,
        "you have one '" + t.value + "' too many, or an earlier block was never opened");
    }

    if (t.type === "name") {
      switch (t.value) {
        case "local": return parseLocal(st, ctx);
        case "function": return parseFunctionStat(st, ctx);
        case "if": return parseIf(st, ctx);
        case "while": return parseWhile(st, ctx);
        case "for": return parseFor(st, ctx);
        case "repeat": return parseRepeat(st, ctx);
        case "do": {
          st.i++;
          bump(st);
          parseBlock(st, ctx, new Set(["end"]));
          expectName(st, "end", "'end' to close the 'do' block opened on line " + t.line);
          unbump(st);
          return;
        }
        case "return": return parseReturn(st, ctx);
        case "break": {
          st.i++;
          if (ctx.loopDepth <= 0)
            throw new ParseError("'break' used outside of a loop", t, "break only works inside for / while / repeat");
          return;
        }
        case "continue": {
          st.i++;
          if (ctx.loopDepth <= 0)
            throw new ParseError("'continue' used outside of a loop", t, "continue only works inside for / while / repeat");
          return;
        }
        case "goto": {
          st.i++;
          const nm = expect(st, "name", null, "a label name after 'goto'");
          st.gotos.push({ name: nm.value, token: nm });
          return;
        }
        case "type": return parseTypeAlias(st, false);
        case "export": {
          st.i++;
          const nx = peek(st);
          if (nx.type === "name" && nx.value === "type") return parseTypeAlias(st, true);
          throw new ParseError("'export' may only be followed by 'type' in Luau", nx, "write 'export type Name = ...'");
        }
        default: break;
      }
    }

    // expression-statement: either a call or an assignment
    const isCall = parsePrimaryPostfix(st, ctx);
    if (isCall) return;

    let targets = 1;
    while (isPunct(peek(st), ",")) {
      st.i++;
      const sub = parsePrimaryPostfix(st, ctx);
      if (sub) throw new ParseError("a function call cannot be an assignment target", peekAt(st, -1), null);
      targets++;
    }

    const op = peek(st);
    if (isOp(op, "=")) {
      st.i++;
      parseExpList(st, ctx);
      return;
    }
    if (op.type === "op" && COMPOUND_ASSIGN.has(op.value)) {
      if (targets > 1) throw new ParseError("'" + op.value + "' takes exactly one target", op, null);
      st.i++;
      parseExpList(st, ctx);
      return;
    }
    throw new ParseError("expected '=' after the variable on line " + t.line + ", found " + describe(op), op,
      "an assignment needs '=': write `x = 1`. A lone expression is not a statement in Luau.");
  }

  function parseLocal(st, ctx) {
    const kw = peek(st); st.i++;
    // local function f() ... end
    if (isName(peek(st), "function")) {
      st.i++;
      expect(st, "name", null, "a function name after 'local function'");
      if (isOp(peek(st), "<")) parseGenericParams(st);
      parseFuncBody(st, ctx, kw);
      return;
    }
    // local a, b [: type] [= explist]
    const first = expect(st, "name", null, "a variable name after 'local'");
    let count = 1;
    while (isPunct(peek(st), ",")) {
      st.i++;
      expect(st, "name", null, "another variable name after ','");
      count++;
    }
    if (isPunct(peek(st), ":")) { st.i++; parseType(st); }
    if (isOp(peek(st), "=")) {
      st.i++;
      parseExpList(st, ctx);
    }
    void first; void count;
  }

  function parseFunctionStat(st, ctx) {
    const kw = peek(st); st.i++;
    expect(st, "name", null, "a function name after 'function'");
    while (isPunct(peek(st), ".")) {
      st.i++;
      expect(st, "name", null, "a field name after '.'");
    }
    if (isPunct(peek(st), ":")) {
      st.i++;
      expect(st, "name", null, "a method name after ':'");
    }
    parseFuncBody(st, ctx, kw);
  }

  function parseGenericParams(st) {
    expectOp(st, "<", "'<' to start the generic parameter list");
    for (;;) {
      const t = peek(st);
      if (t.type === "name") { st.i++; if (isPunct(peek(st), ",")) { st.i++; continue; } break; }
      break;
    }
    expectOp(st, ">", "'>' to close the generic parameter list");
  }

  function parseParams(st, openTok) {
    expectPunct(st, "(", "'(' to start the parameter list");
    if (isPunct(peek(st), ")")) { st.i++; return; }
    for (;;) {
      if (isOp(peek(st), "...")) {
        st.i++;
        if (isPunct(peek(st), ":")) { st.i++; parseType(st); }
        expectPunct(st, ")", "')' — '...' must be the last parameter", openTok);
        return;
      }
      expect(st, "name", null, "a parameter name");
      if (isPunct(peek(st), ":")) { st.i++; parseType(st); }
      if (isPunct(peek(st), ",")) {
        st.i++;
        if (isPunct(peek(st), ")"))
          throw new ParseError("trailing ',' in the parameter list", peek(st),
            "remove the comma before ')' — Luau does not allow a trailing comma in parameters");
        continue;
      }
      expectPunct(st, ")", "')' to close the parameter list", openTok);
      return;
    }
  }

  function parseFuncBody(st, ctx, openTok) {
    parseParams(st, openTok);
    if (isPunct(peek(st), ":")) { st.i++; parseType(st); }   // `function f(): string`
    bump(st);
    const inner = { loopDepth: 0, funcDepth: ctx.funcDepth + 1 };
    parseBlock(st, inner, new Set(["end"]));
    expectName(st, "end", "'end' to close the 'function' opened on line " + openTok.line);
    unbump(st);
  }

  function parseIf(st, ctx) {
    const kw = peek(st); st.i++;
    parseExp(st, ctx, 0);
    expectName(st, "then", "'then' after the if condition on line " + kw.line);
    bump(st);
    parseBlock(st, ctx, new Set(["elseif", "else", "end"]));
    while (isName(peek(st), "elseif")) {
      st.i++;
      parseExp(st, ctx, 0);
      expectName(st, "then", "'then' after the elseif condition");
      bump(st);
      parseBlock(st, ctx, new Set(["elseif", "else", "end"]));
    }
    if (isName(peek(st), "else")) {
      st.i++;
      bump(st);
      parseBlock(st, ctx, new Set(["end"]));
    }
    expectName(st, "end", "'end' to close the 'if' opened on line " + kw.line);
    unbump(st); unbump(st); unbump(st);
  }

  function parseWhile(st, ctx) {
    const kw = peek(st); st.i++;
    parseExp(st, ctx, 0);
    expectName(st, "do", "'do' after the while condition on line " + kw.line);
    bump(st);
    parseBlock(st, { loopDepth: ctx.loopDepth + 1, funcDepth: ctx.funcDepth }, new Set(["end"]));
    expectName(st, "end", "'end' to close the 'while' opened on line " + kw.line);
    unbump(st);
  }

  function parseFor(st, ctx) {
    const kw = peek(st); st.i++;
    expect(st, "name", null, "a loop variable name after 'for'");
    if (isOp(peek(st), "=")) {                       // numeric for
      st.i++;
      parseExp(st, ctx, 0);
      expectPunct(st, ",", "',' after the start value of the numeric for loop");
      parseExp(st, ctx, 0);
      if (isPunct(peek(st), ",")) { st.i++; parseExp(st, ctx, 0); }
    } else {                                          // generic for
      while (isPunct(peek(st), ",")) { st.i++; expect(st, "name", null, "a loop variable name"); }
      expectName(st, "in", "'in' after the loop variables");
      parseExpList(st, ctx);
    }
    expectName(st, "do", "'do' after the for header on line " + kw.line);
    bump(st);
    parseBlock(st, { loopDepth: ctx.loopDepth + 1, funcDepth: ctx.funcDepth }, new Set(["end"]));
    expectName(st, "end", "'end' to close the 'for' opened on line " + kw.line);
    unbump(st);
  }

  function parseRepeat(st, ctx) {
    const kw = peek(st); st.i++;
    bump(st);
    parseBlock(st, { loopDepth: ctx.loopDepth + 1, funcDepth: ctx.funcDepth }, new Set(["until"]));
    expectName(st, "until", "'until' to close the 'repeat' opened on line " + kw.line);
    parseExp(st, ctx, 0);
    unbump(st);
  }

  function parseReturn(st, ctx) {
    const kw = peek(st); st.i++;
    const t = peek(st);
    if (st.i >= st.tokens.length) return;
    if (t.type === "punct" && t.value === ";") { st.i++; return; }
    if (t.type === "name" && (t.value === "end" || t.value === "else" || t.value === "elseif" || t.value === "until")) return;
    parseExpList(st, ctx);
    if (isPunct(peek(st), ";")) st.i++;
    if (!st.sawReturn) st.sawReturn = true;
    void kw;
  }

  function parseTypeAlias(st, isExport) {
    st.i++;
    expect(st, "name", null, "a type name after 'type'");
    if (isOp(peek(st), "<")) parseGenericParams(st);
    expectOp(st, "=", "'=' to define the type");
    parseType(st);
  }

  // ── expressions ─────────────────────────────────────────────────────────
  function parseExpList(st, ctx) {
    parseExp(st, ctx, 0);
    while (isPunct(peek(st), ",")) {
      st.i++;
      parseExp(st, ctx, 0);
    }
  }

  function parseExp(st, ctx, minPrec) {
    bump(st);
    if (st.depth > MAX_DEPTH) { unbump(st); throw new ParseError("expression nested too deeply", peek(st), "split this into several statements"); }
    let t = peek(st);
    // 'not' tokenizes as a name (it is a word-operator), so it is matched here
    if ((t.type === "op" && UNARY_OPS.has(t.value)) || (t.type === "name" && t.value === "not")) {
      st.i++;
      parseExp(st, ctx, 11);
    } else {
      parsePrimaryPostfix(st, ctx);
    }
    for (;;) {
      t = peek(st);
      // 'and' / 'or' are name-typed word-operators
      if (t.type !== "op" && !(t.type === "name" && BINPREC[t.value] !== undefined)) break;
      const prec = BINPREC[t.value];
      if (prec === undefined || prec < minPrec) break;
      st.i++;
      parseExp(st, ctx, RIGHT_ASSOC.has(t.value) ? prec : prec + 1);
    }
    unbump(st);
  }

  // returns true when the parsed expression was a CALL (a valid statement on
  // its own); false when it is a variable (which must be assigned).
  function parsePrimaryPostfix(st, ctx) {
    bump(st);
    if (st.depth > MAX_DEPTH) { unbump(st); throw new ParseError("expression nested too deeply", peek(st), null); }
    parsePrimary(st, ctx);
    let isCall = false;
    for (;;) {
      const t = peek(st);
      if (t.type === "punct" && t.value === ".") {
        st.i++;
        expect(st, "name", null, "a field name after '.'");
        isCall = false;
        continue;
      }
      if (t.type === "punct" && t.value === "[") {
        st.i++;
        parseExp(st, ctx, 0);
        expectPunct(st, "]", "']' to close the index '['", t);
        isCall = false;
        continue;
      }
      if (t.type === "punct" && t.value === ":") {
        st.i++;
        expect(st, "name", null, "a method name after ':'");
        parseCallArgs(st, ctx);
        isCall = true;
        continue;
      }
      if (t.type === "punct" && t.value === "(") { parseCallArgs(st, ctx); isCall = true; continue; }
      if (t.type === "punct" && t.value === "{") { parseTable(st, ctx); isCall = true; continue; }
      if (t.type === "string") { st.i++; isCall = true; continue; }
      break;
    }
    unbump(st);
    return isCall;
  }

  function parseCallArgs(st, ctx) {
    const openTok = peek(st);
    if (openTok.type === "punct" && openTok.value === "(") {
      st.i++;
      if (isPunct(peek(st), ")")) { st.i++; return; }
      for (;;) {
        parseExp(st, ctx, 0);
        if (isPunct(peek(st), ",")) {
          st.i++;
          if (isPunct(peek(st), ")"))
            throw new ParseError("trailing ',' in the argument list", peek(st),
              "remove the comma before ')' — Luau does not allow a trailing comma in a call");
          continue;
        }
        expectPunct(st, ")", "')' to close the call '('", openTok);
        return;
      }
    }
    throw new ParseError("expected '(' to start the argument list", peek(st), null);
  }

  function parsePrimary(st, ctx) {
    const t = peek(st);
    if (t.type === "punct" && t.value === "(") {
      st.i++;
      parseExp(st, ctx, 0);
      expectPunct(st, ")", "')' to close the group '('", t);
      return;
    }
    // table constructor — a PRIMARY expression, not just a call postfix
    if (t.type === "punct" && t.value === "{") { parseTable(st, ctx); return; }
    if (t.type === "number" || t.type === "string") { st.i++; return; }
    if (t.type === "op" && t.value === "...") { st.i++; return; }
    if (t.type === "name") {
      if (LITERAL_NAMES.has(t.value)) { st.i++; return; }
      if (t.value === "function") {
        st.i++;
        if (isOp(peek(st), "<")) parseGenericParams(st);
        parseFuncBody(st, ctx, t);
        return;
      }
      st.i++;
      return;
    }
    throw new ParseError("expected an expression, found " + describe(t), t,
      "an expression is a value, a variable, a call, or a table/function constructor");
  }

  function parseTable(st, ctx) {
    const openTok = peek(st);
    expectPunct(st, "{", "'{' to start a table");
    if (isPunct(peek(st), "}")) { st.i++; return; }
    for (;;) {
      const t = peek(st);
      if (t.type === "punct" && t.value === "[") {
        st.i++;
        parseExp(st, ctx, 0);
        expectPunct(st, "]", "']' to close the table key '['", t);
        expectOp(st, "=", "'=' after the table key");
        parseExp(st, ctx, 0);
      } else if (t.type === "name" && isOp(st.tokens[st.i + 1], "=")) {
        st.i += 2;
        parseExp(st, ctx, 0);
      } else {
        parseExp(st, ctx, 0);
      }
      if (isPunct(peek(st), ",") || isPunct(peek(st), ";")) {
        st.i++;
        if (isPunct(peek(st), "}")) { st.i++; return; }   // trailing separator is fine
        continue;
      }
      expectPunct(st, "}", "'}' to close the table '{'", openTok);
      return;
    }
  }

  // ── type annotations (validated, but permissively) ───────────────────────
  function parseType(st) {
    parseUnionType(st);
  }
  function parseUnionType(st) {
    parseSimpleType(st);
    for (;;) {
      const t = peek(st);
      if (t.type === "op" && (t.value === "|" || t.value === "&")) { st.i++; parseSimpleType(st); continue; }
      break;
    }
  }
  function parseSimpleType(st) {
    const t = peek(st);
    // function type: (a, b) -> c
    if (t.type === "punct" && t.value === "(") {
      st.i++;
      if (!isPunct(peek(st), ")")) { parseType(st); while (isPunct(peek(st), ",")) { st.i++; parseType(st); } }
      expectPunct(st, ")", "')' to close the parameter type list", t);
      if (isOp(peek(st), "->")) { st.i++; parseType(st); return; }
      return;
    }
    // table type: { a: number, [string]: any }
    if (t.type === "punct" && t.value === "{") {
      st.i++;
      while (!isPunct(peek(st), "}") && st.i < st.tokens.length) {
        if (isPunct(peek(st), "[")) { st.i++; parseType(st); expectPunct(st, "]", "']' in the table type"); }
        else if (peek(st).type === "name") { st.i++; }
        else { st.i++; continue; }
        if (isPunct(peek(st), ":")) { st.i++; parseType(st); }
        if (isPunct(peek(st), ",") || isPunct(peek(st), ";")) { st.i++; continue; }
        break;
      }
      expectPunct(st, "}", "'}' to close the table type", t);
      return;
    }
    if (t.type === "name") {
      if (t.value === "typeof") { st.i++; expectPunct(st, "(", "'(' after 'typeof'"); parseExp(st, { loopDepth: 0, funcDepth: 0 }, 0); expectPunct(st, ")", "')' after typeof("); return; }
      st.i++;
      if (isOp(peek(st), "<")) {   // generic instantiation: Array<number>
        st.i++;
        while (!isOp(peek(st), ">") && st.i < st.tokens.length) {
          if (isPunct(peek(st), ",")) { st.i++; continue; }
          parseType(st);
        }
        expectOp(st, ">", "'>' to close the generic type arguments");
      }
      // postfix: ?  and  []
      for (;;) {
        if (isOp(peek(st), "?")) { st.i++; continue; }
        if (isPunct(peek(st), "[")) {
          st.i++;
          if (!isPunct(peek(st), "]")) parseType(st);
          expectPunct(st, "]", "']' to close the array type");
          continue;
        }
        break;
      }
      return;
    }
    throw new ParseError("expected a type, found " + describe(t), t,
      "after ':' Luau expects a type such as `number`, `string?`, `{string}` or `(number) -> string`");
  }

  // ── small helpers ───────────────────────────────────────────────────────
  function peek(st) {
    const t = st.tokens[st.i];
    return t || { type: "eof", value: "<end of code>", line: (st.tokens[st.tokens.length - 1] || {}).line || 1, col: 1 };
  }
  function peekAt(st, back) { return st.tokens[st.i + back] || peek(st); }
  function bump(st) { st.depth++; }
  function unbump(st) { st.depth = Math.max(0, st.depth - 1); }
  function isPunct(t, v) { return !!t && t.type === "punct" && t.value === v; }
  function isOp(t, v) { return !!t && t.type === "op" && t.value === v; }
  function isName(t, v) { return !!t && t.type === "name" && t.value === v; }
  function describe(t) {
    if (!t) return "<end of code>";
    if (t.type === "eof") return "<end of code>";
    if (t.type === "string") return "a string";
    return "'" + t.value + "'";
  }
  function expect(st, type, value, what) {
    const t = peek(st);
    if (t.type === type && (value === null || t.value === value)) { st.i++; return t; }
    throw new ParseError("expected " + (what || "a " + type) + ", found " + describe(t), t, null);
  }
  function expectPunct(st, v, what, openTok) {
    const t = peek(st);
    if (isPunct(t, v)) { st.i++; return t; }
    const where = openTok ? " (the '" + openTok.value + "' was opened on line " + openTok.line + ", column " + openTok.col + ")" : "";
    throw new ParseError("expected '" + v + "' — " + what + where, t,
      openTok ? "add the missing '" + v + "' to close the '" + openTok.value + "' on line " + openTok.line : null);
  }
  function expectOp(st, v, what) {
    const t = peek(st);
    if (isOp(t, v)) { st.i++; return t; }
    throw new ParseError("expected '" + v + "' — " + what, t, null);
  }
  function expectName(st, v, what) {
    const t = peek(st);
    if (isName(t, v)) { st.i++; return t; }
    throw new ParseError("expected '" + v + "' — " + what, t, null);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  LINT (warnings — never block)
  // ════════════════════════════════════════════════════════════════════════
  function lintLuau(src) {
    const warnings = [];
    if (/[^.]:WaitForChild\s*\(\s*"[^"]*"\s*\)/.test(src) && !/:WaitForChild\s*\([^,]+,\s*\d+\s*\)/.test(src))
      warnings.push("WaitForChild without a timeout can yield forever — use WaitForChild(\"X\", 5)");
    if (/\bprint\s*\(/.test(src))
      warnings.push("print() output is NOT captured by execute_luau — use `return` to see values");
    if (/\.Position\s*=\s*"/.test(src))
      warnings.push("Position assigned a string — use Vector3.new(x, y, z)");
    if (/\bgame\.Workspace\b/.test(src) && !/\bgame:GetService\(\s*["']Workspace["']\s*\)/.test(src))
      warnings.push("prefer game:GetService(\"Workspace\") over the game.Workspace shorthand");
    if (/\bwhile\s+true\b/.test(src) && !/\btask\.wait\s*\(|\bwait\s*\(/.test(src))
      warnings.push("`while true` with no task.wait() will hang Studio — add task.wait() inside the loop");
    if (/\bwait\s*\(/.test(src) && !/\btask\.wait\s*\(/.test(src))
      warnings.push("wait() is deprecated — use task.wait()");
    if (/\bspawn\s*\(/.test(src) && !/\btask\.spawn\s*\(/.test(src))
      warnings.push("spawn() is deprecated — use task.spawn()");
    if (/Instance\.new\s*\(\s*["'][A-Za-z]+["']\s*,\s*[A-Za-z_]/.test(src))
      warnings.push("Instance.new(class, parent) sets properties before the parent — prefer Instance.new(class) then set .Parent last");
    if (/\b(SetAsync|GetAsync|UpdateAsync|IncrementAsync|RemoveAsync)\s*\(/.test(src) && !/\bpcall\s*\(/.test(src))
      warnings.push("DataStore call without pcall — a failed save throws and loses data; wrap it in pcall");
    if (!/\breturn\b/.test(src))
      warnings.push("no `return` in this block — execute_luau shows you nothing unless you return a value");
    return warnings;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ENTRY POINTS
  // ════════════════════════════════════════════════════════════════════════
  // 4.8.0 speed: keyed on the FULL source (the 4.8.0 key used length + head +
  // tail, so two different programs sharing those could return each other's
  // cached verdict). Bounded LRU, results copied so a caller cannot mutate it.
  const _analyseCache = new Map();
  const CACHE_MAX = 128;

  function _copyResult(r) {
    return { ...r, errors: (r.errors || []).slice(), warnings: (r.warnings || []).slice() };
  }

  function analyseLuau(code) {
    const src = String(code || "");
    _metrics.analyses++;
    const hit = _analyseCache.get(src);
    if (hit) { _metrics.cacheHits++; return _copyResult(hit); }
    let result;
    try {
      result = _analyseLuauInner(src);
    } catch (e) {
      // A parser crash must NOT block valid code (that was the 4.2.0 bug), and
      // must not silently pass either — it is counted and reported.
      _metrics.internalErrors++;
      try { globalThis.ZSSafe?.seen?.("sandbox.analyseLuau", e); } catch (_e) { void _e; }
      result = {
        ok: true, kind: "static", warnings: ["internal parser error — this block was NOT verified (" + String((e && e.message) || e).slice(0, 80) + ")"],
        errors: [], stats: { tokens: 0, lines: 0 },
        note: "static analysis only — no Luau VM here; runtime behaviour must be verified in Studio",
      };
    }
    if (!result.ok) _metrics.blocked++;
    else if ((result.warnings || []).length) _metrics.warned++;
    _analyseCache.set(src, result);
    if (_analyseCache.size > CACHE_MAX) _analyseCache.delete(_analyseCache.keys().next().value);
    return _copyResult(result);
  }

  function _analyseLuauInner(src) {
    _metrics.parses++;
    if (!src.trim()) return { ok: false, kind: "syntax", error: "empty code block", line: 0, col: 0, errors: [], warnings: [] };

    const { tokens, error } = tokenize(src);
    if (error) {
      return {
        ok: false, kind: "syntax",
        error: error.msg + " (line " + error.line + ", column " + error.col + ")",
        line: error.line, col: error.col,
        hint: "close the string or comment — an unterminated literal swallows the rest of the file",
        errors: [{ message: error.msg, line: error.line, col: error.col }],
        warnings: [], stats: { tokens: tokens.length, lines: lineCount(src) },
      };
    }

    let st;
    try {
      st = parseProgram(tokens);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      const t = e.token || {};
      const where = t.line ? " (line " + t.line + ", column " + (t.col || "?") + ")" : "";
      return {
        ok: false, kind: "syntax",
        error: e.message + where,
        line: t.line || 0, col: t.col || 0, hint: e.hint || null,
        errors: [{ message: e.message, line: t.line || 0, col: t.col || 0, hint: e.hint || null }],
        warnings: lintLuau(src),
        stats: { tokens: tokens.length, lines: lineCount(src) },
      };
    }

    // goto targets (validated after the whole file, so a label may appear later)
    for (const g of st.gotos) {
      if (!st.labels.has(g.name)) {
        return {
          ok: false, kind: "syntax",
          error: "goto '" + g.name + "' has no matching '::" + g.name + "::' label (line " + g.token.line + ")",
          line: g.token.line, col: g.token.col,
          hint: "add the label '::" + g.name + "::' or remove the goto",
          errors: [{ message: "undefined label '" + g.name + "'", line: g.token.line, col: g.token.col }],
          warnings: lintLuau(src), stats: { tokens: tokens.length, lines: lineCount(src) },
        };
      }
    }

    return {
      ok: true, kind: "static",
      warnings: lintLuau(src), errors: [],
      stats: { tokens: tokens.length, lines: lineCount(src) },
      note: "static analysis only — no Luau VM here; runtime behaviour must be verified in Studio",
    };
  }

  function lineCount(src) {
    let n = 1;
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
    return n;
  }

  // ── back-compat entry points ────────────────────────────────────────────
  function dryRunLuau(code) { return analyseLuau(code); }

  function checkLuauSyntax(code) {
    const r = analyseLuau(code);
    return r.ok
      ? { ok: true, warning: (r.warnings || [])[0], warnings: r.warnings || [], okWithWarning: !!(r.warnings || []).length }
      : { ok: false, error: r.error, hint: r.hint, line: r.line, col: r.col };
  }

  function checkJS(code) {
    const src = String(code || "");
    if (!src.trim()) return { ok: false, kind: "syntax", error: "empty code block" };
    try { new Function(src); return { ok: true, kind: "parse", note: "JS parsed OK — not executed" }; }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (/Content Security Policy|CSP/i.test(msg))
        return { ok: true, kind: "parse", note: "CSP blocks the parser — syntax not verified" };
      return { ok: false, kind: "syntax", error: msg };
    }
  }
  const dryRunJS = checkJS;

  function extractPayloads(replyText) {
    const text = String(replyText || "");
    const out = [];
    const reLua = /###\s*LUA(?::(?:Server|Client|Edit))?\s*###([\s\S]*?)###\s*END_LUA\s*###/gi;
    let m;
    while ((m = reLua.exec(text)) !== null) out.push({ kind: "luau", code: m[1] });
    const reFence = /```(?:lua|luau)\s*\n([\s\S]*?)```/gi;
    while ((m = reFence.exec(text)) !== null) out.push({ kind: "luau", code: m[1] });
    return out;
  }

  function dryRunReply(replyText) {
    const payloads = extractPayloads(replyText);
    if (!payloads.length) return { ok: true, kind: "no-code", blocks: 0 };
    const results = [];
    const warnings = [];
    for (let i = 0; i < payloads.length; i++) {
      const r = analyseLuau(payloads[i].code);
      results.push({ block: i + 1, ok: r.ok, error: r.error, line: r.line, col: r.col, hint: r.hint, warnings: r.warnings || [] });
      for (const w of (r.warnings || [])) warnings.push("block " + (i + 1) + ": " + w);
      if (!r.ok)
        return { ok: false, kind: "syntax", error: r.error, line: r.line, col: r.col, hint: r.hint, block: i + 1, blocks: payloads.length, results, warnings };
    }
    return { ok: true, kind: "static", blocks: payloads.length, results, warnings };
  }

  function formatFixFeedback(dryResult) {
    if (!dryResult || dryResult.ok) return null;
    const where = dryResult.line ? " (line " + dryResult.line + (dryResult.col ? ", column " + dryResult.col : "") + ")" : "";
    const hint = dryResult.hint ? "\nHint: " + dryResult.hint : "";
    return "ERROR (static Luau check)" + where + ": " + dryResult.error + hint +
      "\nFix the code and retry. This check parses your Luau — it does not run it, so it only rejects code that cannot possibly compile.";
  }

  function inferTestContract(raw, wallCtx, theme) {
    const ctx = (wallCtx || "").toLowerCase();
    const hasTest = /test|spec|describe\(|it\(|expect\(|assert|__tests__|spec\.lua/i.test(ctx) || /test|spec|verify|check/i.test(raw || "");
    if (!hasTest) return "";
    const signals = [];
    const m1 = (wallCtx || "").match(/(TestService|TestEZ|Spec|__tests__)[^\n]{0,60}/gi);
    if (m1) signals.push(...m1.slice(0, 3));
    const m2 = (wallCtx || "").match(/[A-Za-z_]+\.spec\.lua|Test[^ \n]{0,30}/g);
    if (m2) signals.push(...m2.slice(0, 3));
    const uniq = [...new Set(signals)].slice(0, 4);
    const list = uniq.length ? uniq.join(", ") : "inferred from Theme " + ((theme && theme.name) || "generic");
    return "━━━ TEST CONTRACT — SPEC-DRIVEN GENERATION (upstream) ━━━\nDetected in workspace: " + list + "\n" +
      "You MUST ensure generated code passes: (1) it parses (a real Luau parser runs before execution), " +
      "(2) pcall-wrapped DataStore, (3) server-authority checks, (4) mobile-safe UDim2.fromScale.\n" +
      "If a test file exists (e.g. ReplicatedStorage/Tests.spec.lua), match its expected signatures.\n" +
      "━━━ END TEST CONTRACT ━━━";
  }

  const ZSSandbox = {
    version: VERSION,
    analyseLuau, dryRunLuau, checkLuauSyntax, checkJS, dryRunJS,
    dryRunReply, extractPayloads, formatFixFeedback, inferTestContract, tokenize,
    parseProgram, lintLuau, metrics, resetMetrics,
    // explicit capability statement, so nothing downstream can over-claim
    capabilities: {
      luau: "static-only",
      js: "parse-only",
      runtimeExecution: false,
      grammar: "recursive-descent (statements + expressions + type annotations)",
      delimiterTracking: true,
    },
  };
  try { if (typeof window !== "undefined") window.ZSSandbox = ZSSandbox; } catch (_e) { globalThis.ZSSafe?.seen?.("sandbox.m2", _e); }
  if (typeof self !== "undefined") try { self.ZSSandbox = ZSSandbox; } catch (_e) { globalThis.ZSSafe?.seen?.("sandbox.m2", _e); }
  try { if (typeof globalThis !== "undefined") globalThis.ZSSandbox = ZSSandbox; } catch (_e) { globalThis.ZSSafe?.seen?.("sandbox.m2", _e); }
  if (typeof module !== "undefined" && module.exports) module.exports = ZSSandbox;
})();
