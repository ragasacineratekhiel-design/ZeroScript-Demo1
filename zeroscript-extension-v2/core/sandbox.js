// SPDX-License-Identifier: GPL-3.0-or-later
// core/sandbox.js — ZeroScript 4.7.0 STATIC LUAU PARSER
//
// WHY THIS FILE CHANGED ARCHITECTURE (4.7.0)
// -----------------------------------------
// 4.6.0 counted block keywords (`function/if/for/while/do/repeat` vs `end/until`)
// and popped "the nearest matching keyword". That is not a grammar, and it threw
// away VALID code that the caller then refused to execute — main.js blocks
// execute_luau on `kind:"syntax"`, so a false positive is a lost turn:
//
//     for _, cb in ipairs({function() return 1 end}) do cb() end
//        → "1 block(s) never closed — 'for' opened on line 1 needs 'end'"
//     local v = if x then 1 else 2          (Luau if-EXPRESSION)
//        → "1 block(s) never closed — 'if' opened on line 1 needs 'end'"
//     while (function() return false end)() do end
//        → same
//
// 4.0's hand-rolled keyword counter reported 4 of 10 valid Luau snippets as
// broken; each one is a real model output shape (callback tables, ternary-style
// if, inline predicates). The fix is to stop guessing: this file now contains a
// real recursive-descent parser for the Luau grammar (enough of it to accept any
// program a model writes and to reject what Studio would reject).
//
// Design rules kept from 4.6.0:
//  • never throws on bad input (a half-streamed reply is a legitimate input);
//  • static analysis ONLY — it cannot and does not claim to detect runtime
//    nil-derefs, and says so in `capabilities`;
//  • warnings never block; only a real parse failure is fatal;
//  • results are cached by content (identical blocks are parsed once).
(() => {
  "use strict";
  const VERSION = "4.7.0";

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. LEXER
  // ═══════════════════════════════════════════════════════════════════════════
  // Tokens are stored FLAT in a numeric array, 5 numbers per token:
  //     [type, valueIndex, line, col, pos]
  // `valueIndex` points into a per-call `values` string array. This measures
  // ~2.4× faster than allocating one object per token (a 155-line script has
  // ~1400 tokens; a 20k-line script has ~80k, and the old allocator dominated
  // the whole analysis). Nothing outside this file sees the layout.
  const T = {
    NAME: 1, NUMBER: 2, STRING: 3, INTERP: 4, OP: 5, PUNC: 6, EOF: 7,
  };
  const STRIDE = 5;

  const KEYWORDS = new Set([
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
    "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true",
    "until", "while", "continue", "type", "export",
  ]);

  // Character classes work on CHAR CODES. The 4.7.0 lexer used string compares
  // (`c >= "0" && c <= "9"`), which is a boxed comparison per character; these
  // are plain integer tests. `NaN` (charCodeAt out of range) fails every test,
  // which is exactly the "end of input" behaviour the call sites rely on.
  const isDigit = (c) => c >= 48 && c <= 57;
  const isHex = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
  const isNameStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
  const isNamePart = (c) => isNameStart(c) || isDigit(c);
  // Three-character operators — `//=` (floor-divide assign) and `..=` (concat
  // assign). The two-char table could never emit them: `n //= 4` lexed as `//`
  // then `=`, so the statement failed with "expected an expression but found
  // '='". They are matched arithmetically in the scan loop (a Set lookup per
  // character was measurable), so no table is kept here.
  const TWO_CHAR = new Set([
    "..", "==", "~=", "<=", ">=", "::", "//", "->", "+=", "-=", "*=", "/=",
    "%=", "^=", "<<", ">>", "|=", "&=",
  ]);

  // Long-bracket opener at `at`: [ [ / [= [ ... returns level or -1
  function longBracketLevel(s, at) {
    if (s[at] !== "[") return -1;
    let k = at + 1, level = 0;
    while (s[k] === "=") { level++; k++; }
    return s[k] === "[" ? level : -1;
  }
  function longCloser(level) { return "]" + "=".repeat(level) + "]"; }

  function countNewlines(s, from, to) {
    let n = 0;
    for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  }

  /**
   * tokenize(src) → { tokens, error }
   * Never throws. `error` is a { msg, line, col } describing the first lexical
   * problem; the token list up to that point is still returned so callers can
   * report a useful position.
   */
  function tokenize(src) {
    const s = String(src == null ? "" : src);
    const n = s.length;
    // One token per source character is the absolute worst case, so this
    // allocation is exactly big enough and grow() is a safety net only.
    const buf = new Int32Array(Math.min(n, 1 << 20) * STRIDE + STRIDE);
    let bn = 0;
    const values = [];        // token text
    let i = 0, line = 1, lineStart = 0;

    // Inline (not a closure per call): buf.push with 5 arguments allocates and
    // the closure prevents V8 from inlining the whole hot loop.
    const push = (type, value, ln, at) => {
      values.push(value);
      emit(type, values.length - 1, ln, at);
    };
    const fail = (msg, ln, colAt) => ({ tokens: bufRef.buf, count: bn, values, error: { msg, line: ln, col: colAt } });
    // growable flat buffer (Int32Array halves memory traffic vs a boxed array)
    const grow = () => {
      const bigger = new Int32Array(buf.length * 2);
      bigger.set(buf);
      bufRef.buf = bigger;
    };
    const bufRef = { buf };
    const emit = (type, vi, ln, at) => {
      if (bn + STRIDE > bufRef.buf.length) grow();
      const b = bufRef.buf;
      b[bn] = type; b[bn + 1] = vi; b[bn + 2] = ln; b[bn + 3] = at - lineStart + 1; b[bn + 4] = at;
      bn += STRIDE;
    };

    // Interned operator/punctuation values, keyed by the TEXT. (Keying by first
    // char silently aliased "==" onto "=" — caught by the continue-keyword test.)
    const SLOTS = new Map();
    const slotOf = (ch) => {
      let i2 = SLOTS.get(ch);
      if (i2 === undefined) {
        values.push(ch);
        i2 = values.length - 1;
        SLOTS.set(ch, i2);
      }
      return i2;
    };

    // Three-code fast paths are tested arithmetically: building `s.slice(i,i+3)`
    // per character (an earlier 4.7.0 draft did) allocated one string for every
    // byte of the script and made the lexer the top hotspot.
    const at3 = (a, b, c2) =>
      i + 2 < n && s.charCodeAt(i) === a && s.charCodeAt(i + 1) === b && s.charCodeAt(i + 2) === c2;

    while (i < n) {
      const code = s.charCodeAt(i);

      // ── whitespace / newlines (the commonest outcome by far) ─────────────
      if (code === 10) { line++; i++; lineStart = i; continue; }
      if (code === 32 || code === 9 || code === 13 || code === 12 || code === 11) { i++; continue; }
      if (i === 0 && code === 0xfeff) { i++; continue; }

      const c = s[i];

      // ── comments ──────────────────────────────────────────────────────────
      if (code === 45 && s.charCodeAt(i + 1) === 45) {
        const startLine = line, startCol = i - lineStart + 1;
        const lvl = longBracketLevel(s, i + 2);
        if (lvl >= 0) {
          const bodyStart = i + 4 + lvl;
          const close = s.indexOf(longCloser(lvl), bodyStart);
          if (close < 0) return fail(`unterminated long comment opened with '--[${"=".repeat(lvl)}['`, startLine, startCol);
          line += countNewlines(s, i, close);
          i = close + lvl + 2;
          lineStart = s.lastIndexOf("\n", i - 1) + 1;
          continue;
        }
        const nl = s.indexOf("\n", i);
        i = nl < 0 ? n : nl; // leave the \n for the newline branch
        continue;
      }

      // ── long strings ──────────────────────────────────────────────────────
      if (code === 91) {
        const lvl = longBracketLevel(s, i);
        if (lvl >= 0) {
          const startLine = line;
          const bodyStart = i + lvl + 2;
          const close = s.indexOf(longCloser(lvl), bodyStart);
          if (close < 0) return fail(`unterminated long string [[${"=".repeat(lvl)}`, startLine, i - lineStart + 1);
          const stop = close + lvl + 2;
          push(T.STRING, s.slice(i, stop), startLine, i);
          line += countNewlines(s, i, stop);
          i = stop;
          lineStart = s.lastIndexOf("\n", i - 1) + 1;
          continue;
        }
      }

      // ── short strings (with escapes) ──────────────────────────────────────
      if (code === 34 || code === 39) {
        const startLine = line, start = i;
        const quote = code;
        let j = i + 1, closed = false;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === 92) {                        // backslash
            if (s.charCodeAt(j + 1) === 10) { line++; lineStart = j + 2; }
            j += 2;
            continue;
          }
          if (d === 10) break;                   // a short string cannot span lines
          if (d === quote) { closed = true; j++; break; }
          j++;
        }
        if (!closed) return fail("unterminated string literal", startLine, start - lineStart + 1);
        push(T.STRING, s.slice(start, j), startLine, start);
        i = j;
        continue;
      }

      // ── backtick interpolated string (Luau `…{expr}…`) ────────────────────
      if (code === 96) {
        const startLine = line, start = i;
        let j = i + 1, depth = 0, closed = false;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === 92) { j += 2; continue; }
          if (d === 123) { depth++; j++; continue; }
          if (d === 125) { if (depth > 0) depth--; j++; continue; }
          if (d === 10) { line++; lineStart = j + 1; }
          if (d === 96 && depth === 0) { closed = true; j++; break; }
          j++;
        }
        if (!closed) return fail("unterminated interpolated string", startLine, start - lineStart + 1);
        push(T.INTERP, s.slice(start, j), startLine, start);
        i = j;
        continue;
      }

      // ── numbers ───────────────────────────────────────────────────────────
      if (isDigit(code) || (code === 46 && isDigit(s.charCodeAt(i + 1)))) {
        const startLine = line, start = i;
        let j = i;
        if (code === 48 && (s.charCodeAt(i + 1) === 120 || s.charCodeAt(i + 1) === 88)) {
          j = i + 2;
          while (j < n && (isHex(s.charCodeAt(j)) || s.charCodeAt(j) === 95 || s.charCodeAt(j) === 46)) j++;
          if (s.charCodeAt(j) === 112 || s.charCodeAt(j) === 80) {
            j++;
            if (s.charCodeAt(j) === 43 || s.charCodeAt(j) === 45) j++;
            while (j < n && (isDigit(s.charCodeAt(j)) || s.charCodeAt(j) === 95)) j++;
          }
        } else if (code === 48 && (s.charCodeAt(i + 1) === 98 || s.charCodeAt(i + 1) === 66)) {
          j = i + 2;
          while (j < n && (s.charCodeAt(j) === 48 || s.charCodeAt(j) === 49 || s.charCodeAt(j) === 95)) j++;
        } else {
          while (j < n && (isDigit(s.charCodeAt(j)) || s.charCodeAt(j) === 95)) j++;
          if (s.charCodeAt(j) === 46 && isDigit(s.charCodeAt(j + 1))) { j++; while (j < n && (isDigit(s.charCodeAt(j)) || s.charCodeAt(j) === 95)) j++; }
          else if (s.charCodeAt(j) === 46 && s.charCodeAt(j + 1) !== 46 && !isNameStart(s.charCodeAt(j + 1))) j++;
          if (s.charCodeAt(j) === 101 || s.charCodeAt(j) === 69) {
            j++;
            if (s.charCodeAt(j) === 43 || s.charCodeAt(j) === 45) j++;
            while (j < n && (isDigit(s.charCodeAt(j)) || s.charCodeAt(j) === 95)) j++;
          }
        }
        push(T.NUMBER, s.slice(start, j), startLine, start);
        i = j;
        continue;
      }

      // ── names / keywords ──────────────────────────────────────────────────
      if (isNameStart(code)) {
        const start = i;
        let j = i + 1;
        while (j < n && isNamePart(s.charCodeAt(j))) j++;
        const word = s.slice(start, j);
        push(KEYWORDS.has(word) ? T.OP : T.NAME, word, line, start);
        i = j;
        continue;
      }

      // ── operators & punctuation (longest match first) ─────────────────────
      // `//=` and `..=`: arithmetic test first, slice only on a real match.
      if ((at3(47, 47, 61) || at3(46, 46, 61))) {
        const three = s.slice(i, i + 3);
        emit(T.OP, slotOf(three), line, i);
        i += 3;
        continue;
      }
      if (at3(46, 46, 46)) { emit(T.PUNC, slotOf("..."), line, i); i += 3; continue; }
      const two = s.slice(i, i + 2);
      if (TWO_CHAR.has(two)) { emit(T.OP, slotOf(two), line, i); i += 2; continue; }
      // ASCII dispatch: one switch beats two string includes on every char
      // Single-char operators/punctuation reuse a pre-seeded value slot, so the
      // commonest tokens cost no allocation at all.
      switch (code) {
        case 43: case 45: case 42: case 47: case 37: case 94: case 35:
        case 61: case 60: case 62: case 38: case 124: case 126: case 58:
        case 63: // '?' — Luau optional type suffix (number?) and `if x then a else b` erasure
          emit(T.OP, slotOf(c), line, i); i++; continue;
        case 40: case 41: case 123: case 125: case 91: case 93: case 59: case 44: case 46:
          emit(T.PUNC, slotOf(c), line, i); i++; continue;
        default: break;
      }

      return fail(`unexpected character '${c}'`, line, i - lineStart + 1);
    }

    emit(T.EOF, slotOf(""), line, n);
    return { tokens: bufRef.buf, count: bn, values, error: null };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. PARSER (recursive descent, statement + expression grammar)
  // ═══════════════════════════════════════════════════════════════════════════
  // The block model is the real one: no "keyword stack", no nearest-match pops.
  // A `for` header is an EXPRESSSION LIST, so a function literal inside it is
  // consumed by the expression parser and can never be mistaken for a block
  // opened by the loop. Same for `if` as an expression.

  // Frozen block terminators, shared by every parse (allocating a Set inside
  // parseBlock cost one allocation per if/for/while/function in the script).
  const STOP_END = new Set(["end"]);
  // every compound assignment Luau accepts (plain `=` is tested separately)
  const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "//=", "%=", "^=", "..="]);
  const STOP_END_ELSE = new Set(["end", "else", "elseif"]);
  const STOP_UNTIL = new Set(["until"]);
  const STOP_NONE = new Set();

  function makeParser(tokens, values, count) {
    // Flat cursor over the columnar buffer: [type, valueIndex, line, col, pos].
    let at = 0;                    // index INTO THE FLAT ARRAY (multiple of STRIDE)
    const last = Math.max(0, (count == null ? tokens.length : count) - STRIDE);
    // Lookahead accessors (only used for k>0 — the rare, structural questions
    // like "is the next token a NAME?").
    const tType = (k) => tokens[Math.min(at + k * STRIDE, last)];
    const tVal = (k) => values[tokens[Math.min(at + k * STRIDE, last) + 1]];
    // ── CURSOR IN LOCALS (4.7.0) ────────────────────────────────────────────
    // isOp/isPunc/isKw run several times per token, and each one used to do
    // `tokens[Math.min(at, last)]` plus a second indexed read for the value.
    // Profiling put tType+tVal+advance at ~55% of total parse time. Keeping the
    // current token in four closure locals turns every one of those tests into a
    // pair of comparisons, and advance() pays the array reads exactly once.
    let curType = 0, curVal = "", curLine = 0, curCol = 0;
    function loadAt(q) {
      curType = tokens[q];
      curVal = values[tokens[q + 1]];
      curLine = tokens[q + 2];
      curCol = tokens[q + 3];
    }
    loadAt(0);
    // A tiny mutable token VIEW reused by the code below, so the parser body
    // keeps reading naturally ({type, value, line, col}) with zero allocation.
    const view = { type: 0, value: "", line: 0, col: 0 };
    function tok(k = 0) {
      if (k !== 0) {
        const q = Math.min(at + k * STRIDE, last);
        view.type = tokens[q]; view.value = values[tokens[q + 1]];
        view.line = tokens[q + 2]; view.col = tokens[q + 3];
        return view;
      }
      view.type = curType; view.value = curVal;
      view.line = curLine; view.col = curCol;
      return view;
    }
    const peek = tok;
    function advance() {
      if (at < last) { at += STRIDE; loadAt(at); }
      return tok();
    }
    // Open-block ledger: { kw, line }. Kept so an unclosed block can be reported
    // by NAME and line ("'function' opened on line 2 needs 'end'") instead of a
    // bare "expected end", which is what the model needs to fix it in one shot.
    const openBlocks = [];
    const isOp = (v) => curType === T.OP && curVal === v;
    const isPunc = (v) => curType === T.PUNC && curVal === v;
    const isKw = (v) => curType === T.OP && curVal === v;
    const next = advance;
    let depth = 0; // recursion guard (a malicious reply could nest deeply)

    const err = (msg, tok) => {
      const t = tok || peek();
      const e = new Error(msg);
      e.zsLine = t.line;
      e.zsCol = t.col;
      throw e;
    };

    function expectPunc(v) { if (!isPunc(v)) err(`expected '${v}' but found ${describe(tok())}`); return next(); }
    function expectKw(v) { if (!isKw(v)) err(`expected '${v}' but found ${describe(tok())}`); return next(); }
    function describe(t) {
      if (!t || t.type === T.EOF) return "end of input";
      if (t.type === T.NUMBER) return `number ${t.value}`;
      if (t.type === T.STRING) return "string";
      if (t.type === T.INTERP) return "interpolated string";
      return `'${t.value}'`;
    }

    // ── expressions ─────────────────────────────────────────────────────────

    function parseExpr() { parseBinary(0); return true; }

    // Lua/Luau precedence, lowest first, as a lockup TABLE so a token's level is
    // one property read instead of a scan through arrays of strings.
    //   or | and | comparisons | ~ | & | << >> | .. | + - | * / // %
    const BIN_LEVEL = new Map([
      ["or", 0], ["and", 1],
      ["<", 2], [">", 2], ["<=", 2], [">=", 2], ["~=", 2], ["==", 2],
      ["|", 3], ["~", 3], ["&", 4], ["<<", 5], [">>", 5], ["..", 6],
      ["+", 7], ["-", 7], ["*", 8], ["/", 8], ["//", 8], ["%", 8],
    ]);
    const MAX_LEVEL = 8;

    function parseBinary(level) {
      const nextLevel = level + 1;
      // left operand
      if (nextLevel > MAX_LEVEL) parseUnary();
      else parseBinary(nextLevel);
      while (true) {
        if (curType !== T.OP) return true;
        const lvl = BIN_LEVEL.get(curVal);
        if (lvl === undefined || lvl !== level) return true;
        next();
        // right operand at the same precedence (left-associative); for `..` and
        // `^` Lua folds right, which this still accepts because the recursive
        // call re-enters at level+1 and the loop re-checks the operator.
        if (nextLevel > MAX_LEVEL) parseUnary();
        else parseBinary(nextLevel);
      }
      return true;
    }

    function parseUnary() {
      const t = peek();
      if (t.type === T.OP && (t.value === "not" || t.value === "-" || t.value === "#" || t.value === "~" || t.value === "+")) {
        next();
        return parseUnary();
      }
      return parsePow();
    }

    function parsePow() {
      parseSimple();
      // right-associative `^`
      if (isOp("^")) { next(); return parsePow(); }
      return true;
    }

    function parseSimple() {
      const t = peek();
      if (t.type === T.NUMBER) { next(); return parseSuffixes(); }
      if (t.type === T.STRING) { next(); return parseSuffixes(); }
      if (t.type === T.INTERP) { next(); return parseSuffixes(); }
      if (t.type === T.OP && (t.value === "nil" || t.value === "true" || t.value === "false")) { next(); return parseSuffixes(); }
      if (t.type === T.OP && t.value === "function") { parseFunctionBody(); return parseSuffixes(); }
      if (t.type === T.OP && t.value === "if") { parseIfExpression(); return parseSuffixes(); }
      if (t.type === T.PUNC && t.value === "{") { parseTable(); return parseSuffixes(); }
      if (t.type === T.PUNC && t.value === "(") {
        next();
        parseExpr();
        expectPunc(")");
        return parseSuffixes();
      }
      if (t.type === T.PUNC && t.value === "...") { next(); return parseSuffixes(); }
      if (t.type === T.NAME) { next(); return parseSuffixes(); }
      return err(`expected an expression but found ${describe(t)}`);
    }

    function parseSuffixes() {
      while (true) {
        const t = peek();
        if (t.type === T.PUNC && t.value === ".") {
          next();
          if (peek().type !== T.NAME) err(`expected a field name after '.' but found ${describe(peek())}`);
          next();
          continue;
        }
        if (t.type === T.OP && t.value === ":") {
          next();
          if (peek().type !== T.NAME) err(`expected a method name after ':' but found ${describe(peek())}`);
          next();
          parseCallArgs();
          continue;
        }
        if (t.type === T.PUNC && t.value === "[") { next(); parseExpr(); expectPunc("]"); continue; }
        if ((t.type === T.PUNC && (t.value === "(" || t.value === "{")) || t.type === T.STRING || t.type === T.INTERP) {
          parseCallArgs();
          continue;
        }
        // Luau type assertion `:: Type`
        if (t.type === T.OP && t.value === "::") { next(); parseType(); continue; }
        return true;
      }
    }

    function parseCallArgs() {
      const t = peek();
      if (t.type === T.STRING || t.type === T.INTERP) { next(); return; }
      if (t.type === T.PUNC && t.value === "{") { parseTable(); return; }
      if (t.type === T.PUNC && t.value === "(") {
        next();
        if (!isPunc(")")) {
          parseExpr();
          while (isPunc(",")) { next(); parseExpr(); }
        }
        expectPunc(")");
        return;
      }
      err(`expected call arguments but found ${describe(t)}`);
    }

    function parseTable() {
      expectPunc("{");
      while (!isPunc("}")) {
        if (peek().type === T.EOF) err("unterminated table constructor — missing '}'");
        // `[expr] = value` — the key expression may itself be parenthesised or a
        // table, so it goes through the full expression parser before the '='.
        if (isPunc("[")) {
          next(); parseExpr(); expectPunc("]");
          if (isOp("=")) { next(); parseExpr(); }
          else err(`expected '=' after a table key but found ${describe(peek())}`);
        } else if ((curType === T.NAME || curType === T.OP) && tType(1) === T.OP && tVal(1) === "=") {
          next(); next(); parseExpr();
        } else {
          parseExpr();
        }
        if (isPunc(",") || isPunc(";")) next();
        else if (!isPunc("}")) err(`expected ',' or '}' in table but found ${describe(peek())}`);
      }
      expectPunc("}");
    }

    // Luau `if <expr> then <expr> else <expr>` (an EXPRESSION, not a block)
    function parseIfExpression() {
      expectKw("if");
      parseExpr();
      expectKw("then");
      parseExpr();
      while (isKw("elseif")) {
        next();
        parseExpr();
        expectKw("then");
        parseExpr();
      }
      expectKw("else");
      parseExpr();
    }

    // Function literal / declaration body: (params) [: rettype] <block> end
    function parseFunctionBody() {
      const closeFn = openKw("function", peek());
      expectKw("function");
      if (isPunc("(")) parseParams();
      // generics: function f<T, U>(...)
      if (isOp("<")) parseTypeParams();
      if (curType === T.PUNC && curVal === "(") parseParams();
      if (isOp(":")) { next(); parseType(); }
      parseBlock(STOP_END);
      expectKw("end");
      closeFn();
    }

    function parseParams() {
      expectPunc("(");
      if (!isPunc(")")) {
        do {
          const t = peek();
          if (t.type === T.NAME) {
            next();
            if (isOp(":")) { next(); parseType(); }
          } else if (t.type === T.PUNC && t.value === "...") {
            next();
            if (isOp(":")) { next(); parseType(); }
          } else {
            err(`expected a parameter name but found ${describe(t)}`);
          }
        } while (isPunc(",") && next());
      }
      expectPunc(")");
    }

    // ── Luau type grammar (permissive: this only has to be skipped correctly) ──
    function parseTypeParams() {
      expectOp("<");
      do {
        if (peek().type === T.NAME) next();
        else err(`expected a generic parameter name but found ${describe(peek())}`);
        if (isOp("=")) { next(); parseType(); }
      } while (isPunc(",") && next());
      expectOp(">");
    }
    function expectOp(v) { if (!isOp(v)) err(`expected '${v}' but found ${describe(peek())}`); return next(); }

    function parseType() {
      if (depth > 200) err("type annotation nested too deeply");
      depth++;
      try {
        // function types: (A, B) -> C   and   variadic (A, ...B) -> C
        if (isPunc("(")) {
          next();
          if (!isPunc(")")) {
            do {
              if (peek().type === T.PUNC && peek().value === "...") next();
              parseType();
            } while (isPunc(",") && next());
            if (isPunc(")")) next();
          } else { next(); }
          if (isOp("->")) { next(); parseType(); }
          return;
        }
        if (isPunc("{")) return parseTypeTable();
        if (peek().type === T.PUNC && peek().value === "<") { // generic application
          parseTypeParams();
          return;
        }
        if (peek().type === T.STRING) { next(); return; }
        if (peek().type === T.NAME) {
          next();
          while (isPunc(".") && next() && peek().type === T.NAME) next();
          // generic arguments: Array<T>
          if (isOp("<")) parseTypeArgs();
          if (isOp("?")) next();
          // intersection / union
          while (isOp("|") || isOp("&")) { next(); parseType(); }
          return;
        }
        if (isOp("nil")) { next(); return; }
        return;
      } finally {
        depth--;
      }
    }

    function parseTypeArgs() {
      expectOp("<");
      if (!isOp(">")) {
        do { parseType(); } while (isPunc(",") && next());
      }
      expectOp(">");
    }

    function parseTypeTable() {
      expectPunc("{");
      if (isPunc("}")) { next(); return; }
      // A Luau table type is a LIST of props, and the props may be MIXED:
      //   { [K]: V }        dictionary
      //   { name: T }       named fields
      //   { T }             array
      //   { [K]: V, name: T }   ← indexer + fields together, real Luau
      // 4.6.0 branched on the FIRST prop and then assumed every later prop had
      // the same shape, so the mixed form failed with the nonsense
      // "expected '}' but found ':'". Parse prop-by-prop instead.
      while (!isPunc("}")) {
        if (peek().type === T.EOF) err("unterminated table type — missing '}'");
        if (isPunc("[")) {
          next(); parseType(); expectPunc("]"); expectOp(":"); parseType();
        } else if (curType === T.NAME && tType(1) === T.OP && tVal(1) === ":") {
          next(); next(); parseType();
        } else {
          parseType();                       // array/union element type
        }
        if (isPunc(",") || isPunc(";")) next();
        else if (!isPunc("}")) err(`expected ',' or '}' in the table type but found ${describe(peek())}`);
      }

      expectPunc("}");
    }

    // ── statements ──────────────────────────────────────────────────────────

    // `stop` = the set of keywords that terminates this block
    // Register a block opener; call the returned function when it closes.
    function openKw(kw, tok) {
      openBlocks.push({ kw, line: (tok || peek()).line });
      return () => { openBlocks.pop(); };
    }

    function parseBlock(stop) {
      while (true) {
        const t = peek();
        if (t.type === T.EOF) {
          if (stop.has("end") || stop.has("until")) {
            const need = stop.has("until") ? "until" : "end";
            const top = openBlocks[openBlocks.length - 1];
            if (top) {
              const who = top.kw === "do" ? "a 'do' block" : `'${top.kw}'`;
              err(`${openBlocks.length} block(s) never closed — ${who} opened on line ${top.line} needs '${need}'`, t);
            }
            err(`block is never closed — expected '${need}' before end of code`, t);
          }
          return;
        }
        if (t.type === T.OP && stop.has(t.value)) return;
        if (t.type === T.PUNC && t.value === ";") { next(); continue; }
        parseStatement();
      }
    }

    function parseStatement() {
      if (depth > 400) err("code nested too deeply (possible malformed reply)");
      depth++;
      try {
        const t = peek();

        if (t.type === T.OP) {
          switch (t.value) {
            case "local": {
              next();
              if (isKw("function")) {
                next();                                  // consume `function`
                if (peek().type !== T.NAME) err(`expected a function name but found ${describe(peek())}`);
                next();                                  // the name
                parseFunctionBodyFromKeyword();           // generics, params, body
                return;
              }
              // local <name list> [= <expr list>]   |   local name: <type> [= expr]
              if (peek().type !== T.NAME) err(`expected a local name but found ${describe(peek())}`);
              next();
              if (isOp(":")) {                       // typed single declaration
                next(); parseType();
                if (isOp("=")) { next(); parseExpr(); }
                return;
              }
              while (isPunc(",")) {                  // plain name list
                next();
                if (peek().type !== T.NAME) err(`expected a local name but found ${describe(peek())}`);
                next();
              }
              if (isOp("=")) {
                next(); parseExpr();
                while (isPunc(",") && next()) parseExpr();
              }
              return;
            }
            case "function": {
              // `function` can start a named declaration (function M.x() …) or a
              // bare function LITERAL (used as a call argument / table field).
              // Only the named form has a NAME directly after the keyword.
              if (tType(1) === T.NAME) {
                next(); next();
                while (isPunc(".")) { next(); if (peek().type !== T.NAME) err("expected a field name"); next(); }
                if (isOp(":")) { next(); if (peek().type !== T.NAME) err("expected a method name"); next(); }
                parseFunctionBodyFromKeyword();
                return;
              }
              parseFunctionBody();
              return;
            }
            case "if": { parseIfStatement(); return; }
            case "while": {
              const close = openKw("while", t); next();
              parseExpr();
              expectKw("do");
              parseBlock(STOP_END);
              expectKw("end");
              close();
              return;
            }
            case "repeat": {
              const close = openKw("repeat", t); next();
              parseBlock(STOP_UNTIL);
              expectKw("until");
              parseExpr();
              close();
              return;
            }
            case "for": {
              const closeFor = openKw("for", t);
              next();
              if (peek().type !== T.NAME) err(`expected a loop variable but found ${describe(peek())}`);
              next();
              // numeric for:  for i = a, b[, c] do
              // generic for:  for k, v [, k2, v2 …] in <expr list> do
              if (isOp(":")) { next(); parseType(); }
              while (isPunc(",")) { next(); if (peek().type !== T.NAME) err(`expected a loop variable but found ${describe(peek())}`); next(); if (isOp(":")) { next(); parseType(); } }
              if (isOp("=")) { next(); parseExpr(); expectPunc(","); parseExpr(); if (isPunc(",")) { next(); parseExpr(); } }
              else if (isOp("in")) { next(); do { parseExpr(); } while (isPunc(",") && next()); }
              else err(`expected '=' or 'in' in the for header but found ${describe(peek())}`);
              expectKw("do");
              parseBlock(STOP_END);
              expectKw("end");
              closeFor();
              return;
            }
            case "do": {
              const closeDo = openKw("do", t); next();
              parseBlock(STOP_END);
              expectKw("end");
              closeDo();
              return;
            }
            case "return": {
              next();
              const nt = peek();
              const blockEnd = nt.type === T.EOF ||
                (nt.type === T.OP && ["end", "else", "elseif", "until"].includes(nt.value)) ||
                (nt.type === T.PUNC && nt.value === ";");
              if (!blockEnd) {
                parseExpr();
                while (isPunc(",") && next()) parseExpr();
              }
              if (isPunc(";")) next();
              return;
            }
            case "break": next(); return;
            case "continue": next(); return;
            case "type": {
              // type Name<T> = <type>
              next();
              if (peek().type !== T.NAME) err(`expected a type name but found ${describe(peek())}`);
              next();
              if (isOp("<")) parseTypeParams();
              expectOp("=");
              parseType();
              return;
            }
            case "export": {
              next();
              if (isKw("type")) return parseStatement();
              err("expected 'type' after 'export'");
              return;
            }
            case "end":
            case "else":
            case "elseif":
            case "until":
              err(`unexpected '${t.value}' — nothing is open here`, t);
              return;
          }
        }

        // expression statement: call, or an assignment to one-or-many targets
        parseExpr();
        while (isPunc(",") && isAssignAhead()) { next(); parseExpr(); }
        if (isAssignOp()) {
          next();
          parseExpr();
          while (isPunc(",") && next()) parseExpr();
        }
        return;
      } finally {
        depth--;
      }
    }

    // `,` continues an assignment target list only when an assignment follows.
    // `f(a), g(b)` (two calls separated by a comma) must NOT be re-read as
    // targets — Luau has no comma operator — so peek past the next expression
    // for an assignment operator.
    function isAssignAhead() {
      let i = 1, seenExprStart = false;
      const stop = new Set([",", ";"]);
      while (i < 64) {
        const t = tType(i), v = tVal(i);
        if (t === T.EOF) return false;
        if (t === T.OP && ASSIGN_OPS.has(v)) return true;
        if (t === T.PUNC && stop.has(v)) return false;
        // a block keyword ends the statement entirely
        if (t === T.OP && ["end", "else", "elseif", "until", "then", "do", "local", "function", "return", "if", "for", "while", "repeat"].includes(v)) return false;
        if (!seenExprStart && (t === T.NAME || t === T.NUMBER || t === T.STRING)) seenExprStart = true;
        i++;
      }
      return false;
    }

    function isAssignOp() { return isOp("=") || (peek().type === T.OP && ASSIGN_OPS.has(peek().value)); }

    // we are positioned ON the `function` keyword consumed by `local function x`
    function parseFunctionBodyFromKeyword() {
      const closeFn = openKw("function", peek());
      if (isOp("<")) parseTypeParams();
      parseParams();
      if (isOp(":")) { next(); parseType(); }
      parseBlock(STOP_END);
      expectKw("end");
      closeFn();
    }

    function parseIfStatement() {
      const closeIf = openKw("if", peek());
      expectKw("if");
      parseExpr();
      expectKw("then");
      parseBlock(STOP_END_ELSE);
      while (isKw("elseif")) {
        next();
        parseExpr();
        expectKw("then");
        parseBlock(STOP_END_ELSE);
      }
      if (isKw("else")) {
        next();
        parseBlock(STOP_END);
      }
      expectKw("end");
      closeIf();
    }

    return {
      parseProgram() {
        parseBlock(STOP_NONE);
        if (curType !== T.EOF) err(`unexpected ${describe(tok())} after the end of the program`);
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. PUBLIC ANALYSIS API
  // ═══════════════════════════════════════════════════════════════════════════
  const _cache = new Map();
  const _CACHE_MAX = 128;

  function analyseLuau(code) {
    const src = String(code == null ? "" : code);
    if (!src.trim()) return { ok: false, kind: "syntax", error: "empty code block", line: 0 };

    const key = src.length + ":" + src.slice(0, 48) + ":" + src.slice(-48);
    const hit = _cache.get(key);
    if (hit && hit.src === src) return clone(hit.result);

    const result = analyseInner(src);
    if (_cache.size >= _CACHE_MAX) _cache.delete(_cache.keys().next().value);
    _cache.set(key, { src, result: clone(result) });
    return result;
  }

  function clone(r) {
    const copy = { ...r };
    if (r.warnings) copy.warnings = r.warnings.slice();
    return copy;
  }

  function analyseInner(src) {
    const { tokens, count, values, error } = tokenize(src);
    if (error) return { ok: false, kind: "syntax", error: error.msg, line: error.line, col: error.col };

    try {
      makeParser(tokens, values, count).parseProgram();
    } catch (e) {
      if (e && e.zsLine) {
        return {
          ok: false, kind: "syntax", error: e.message, line: e.zsLine, col: e.zsCol,
          hint: hintFor(e.message),
        };
      }
      // A parser crash is OUR defect, not the model's code — never reject code
      // because of it. Report it through ZSSafe and accept the program.
      globalThis.ZSSafe?.seen?.("sandbox.parserCrash", e);
      return {
        ok: true, kind: "static", tokens: count / STRIDE, warnings: [],
        note: "static analysis only — the checker hit an internal error and did not block this code",
      };
    }

    return {
      ok: true, kind: "static",
      tokens: count / STRIDE,
      warnings: collectWarnings(src, tokens),
      note: "static analysis only — no Luau VM here; runtime behaviour must be verified in Studio",
    };
  }

  function hintFor(msg) {
    if (/never closed|expected 'end'/.test(msg)) return "add the missing 'end' (every if/for/while/function/do opens one)";
    if (/Unterminated|unterminated/.test(msg)) return "close the string, long string or long comment";
    if (/expected 'until'/.test(msg)) return "a 'repeat' block must be closed by 'until <condition>'";
    if (/expected an expression/.test(msg)) return "an expression is missing or truncated — check for a cut-off reply";
    if (/expected '\)'/.test(msg)) return "a '(' is not closed";
    if (/expected '}'/.test(msg)) return "a '{' is not closed";
    if (/expected ']'/.test(msg)) return "a '[' is not closed";
    if (/unexpected 'end'/.test(msg)) return "remove the extra 'end' — nothing is open there";
    return "check the Luau syntax around the reported line";
  }

  function collectWarnings(src, tokens) {
    const warnings = [];
    if (/:\s*WaitForChild\s*\(\s*"[^"]*"\s*\)/.test(src) && !/:\s*WaitForChild\s*\([^,]+,\s*[\d.]+/.test(src)) {
      warnings.push('WaitForChild without a timeout can yield forever inside execute_luau — use WaitForChild("X", 5)');
    }
    if (/\bprint\s*\(/.test(src)) {
      warnings.push("print() output is NOT captured by execute_luau — use `return` to see values");
    }
    if (/\.Position\s*=\s*"/.test(src)) {
      warnings.push("Position assigned a string — needs Vector3.new(x, y, z)");
    }
    if (/\bgame\.Workspace\b/.test(src) && !/\bgame\s*:\s*GetService\s*\(\s*["']Workspace["']\s*\)/.test(src)) {
      warnings.push('prefer game:GetService("Workspace") over the game.Workspace shorthand in scripts');
    }
    if (/\bwhile\s+true\s+do\b/.test(src) && !/\btask\.wait\s*\(|\bwait\s*\(/.test(src)) {
      warnings.push("`while true do` with no task.wait() inside will freeze the thread — add task.wait(1)");
    }
    void tokens;
    return warnings;
  }

  // ── Back-compat entry points (main.js calls dryRunLuau) ──────────────────
  function dryRunLuau(code) { return analyseLuau(code); }
  function checkLuauSyntax(code) {
    const r = analyseLuau(code);
    // legacy contract: { ok, error, hint, warning }
    return r.ok
      ? { ok: true, warning: (r.warnings || [])[0], okWithWarning: !!(r.warnings || []).length }
      : { ok: false, error: r.error, hint: r.hint, line: r.line };
  }

  // ── JavaScript static check (real: uses the engine's own parser) ─────────
  // `new Function` parses WITHOUT executing, so this genuinely catches syntax
  // errors. It is honesty-labelled as parse-only.
  const _jsCache = new Map();
  function checkJS(code) {
    const src = String(code || "");
    if (!src.trim()) return { ok: false, kind: "syntax", error: "empty code block" };
    const key = src.length + ":" + src.slice(0, 48) + ":" + src.slice(-48);
    const hit = _jsCache.get(key);
    if (hit && hit.src === src) return { ...hit.result };
    let result;
    try {
      new Function(src);
      result = { ok: true, kind: "parse", note: "JS parsed OK — not executed" };
    } catch (e) {
      const msg = String((e && e.message) || e);
      result = /Content Security Policy|CSP/i.test(msg)
        ? { ok: true, kind: "parse", note: "CSP blocks the parser — syntax not verified" }
        : { ok: false, kind: "syntax", error: msg };
    }
    if (_jsCache.size >= 64) _jsCache.delete(_jsCache.keys().next().value);
    _jsCache.set(key, { src, result });
    return { ...result };
  }
  const dryRunJS = checkJS;

  // ── Reply scan: find every executable payload and check it ───────────────
  const RE_LUA_BLOCK = /###\s*LUA(?::(?:Server|Client|Edit))?\s*###([\s\S]*?)###\s*END_LUA\s*###/gi;
  const RE_FENCE_LUA = /```(?:lua|luau)\s*\n([\s\S]*?)```/gi;

  function extractPayloads(replyText) {
    const text = String(replyText || "");
    const out = [];
    let m;
    RE_LUA_BLOCK.lastIndex = 0;
    while ((m = RE_LUA_BLOCK.exec(text)) !== null) out.push({ kind: "luau", code: m[1] });
    RE_FENCE_LUA.lastIndex = 0;
    while ((m = RE_FENCE_LUA.exec(text)) !== null) out.push({ kind: "luau", code: m[1] });
    return out;
  }

  function dryRunReply(replyText) {
    const payloads = extractPayloads(replyText);
    if (!payloads.length) return { ok: true, kind: "no-code", blocks: 0 };
    const results = [];
    for (let i = 0; i < payloads.length; i++) {
      const r = analyseLuau(payloads[i].code);
      results.push({ block: i + 1, ok: r.ok, error: r.error, line: r.line, hint: r.hint, warnings: r.warnings || [] });
      if (!r.ok) return { ok: false, kind: "syntax", error: r.error, line: r.line, hint: r.hint, block: i + 1, blocks: payloads.length, results };
    }
    return { ok: true, kind: "static", blocks: payloads.length, results };
  }

  function formatFixFeedback(dryResult) {
    if (!dryResult || dryResult.ok) return null;
    const where = dryResult.line ? ` (line ${dryResult.line}${dryResult.col ? ":" + dryResult.col : ""})` : "";
    const hint = dryResult.hint ? `\nHint: ${dryResult.hint}` : "";
    return `ERROR (static Luau check)${where}: ${dryResult.error}${hint}\n` +
      `Fix the code and retry. This check is static — it only rejects code that cannot possibly parse.`;
  }

  // ── Test-contract helper (consumed by the prompt enhancer) ───────────────
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
    return `━━━ TEST CONTRACT — SPEC-DRIVEN GENERATION (upstream) ━━━\nDetected in workspace: ${list}\n` +
      `You MUST ensure generated code passes: (1) it parses (static check runs before execution), ` +
      `(2) pcall-wrapped DataStore, (3) server-authority checks, (4) mobile-safe UDim2.fromScale.\n` +
      `If a test file exists (e.g. ReplicatedStorage/Tests.spec.lua), match its expected signatures.\n` +
      `━━━ END TEST CONTRACT ━━━`;
  }

  const ZSSandbox = {
    version: VERSION,
    analyseLuau, dryRunLuau, checkLuauSyntax, checkJS, dryRunJS,
    dryRunReply, extractPayloads, formatFixFeedback, inferTestContract, tokenize,
    // explicit capability statement, so nothing downstream can over-claim
    capabilities: { luau: "static-only", js: "parse-only", runtimeExecution: false },
  };
  try { if (typeof window !== "undefined") window.ZSSandbox = ZSSandbox; } catch (_e) { globalThis.ZSSafe?.seen?.("sandbox.m2", _e); }
  if (typeof self !== "undefined") try { self.ZSSandbox = ZSSandbox; } catch (_e) { globalThis.ZSSafe?.seen?.("sandbox.m2", _e); }
  try { if (typeof globalThis !== "undefined") globalThis.ZSSandbox = ZSSandbox; } catch (_e) { globalThis.ZSSafe?.seen?.("sandbox.m2", _e); }
  if (typeof module !== "undefined" && module.exports) module.exports = ZSSandbox;
})();
