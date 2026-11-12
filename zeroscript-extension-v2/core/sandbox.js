// SPDX-License-Identifier: GPL-3.0-or-later
// core/sandbox.js — ZeroScript 4.3.0 STATIC LUAU ANALYSER
//
// HONEST REWRITE (audit #11/#12/#13). What this file used to do was NOT a
// sandbox: `dryRunLuau` ran a handful of regexes and `dryRunJS`/`dryRunReply`
// were dead code, while core/config.js told the model that Luau "executes
// against a mock Roblox env and runtime TypeErrors are intercepted". That was
// false, and worse, the keyword heuristic counted `if|for|while|and do` as
// openers against only `end` as closers, so three sequential `for` loops were
// rejected as "likely missing 'end'" and any `(` inside a `--` comment was
// reported as unbalanced. main.js blocks execute_luau on a syntax failure, so
// that heuristic was throwing away VALID code before it ever reached Studio.
//
// What it does now:
//  1. A real Luau tokenizer (short/long strings, short/long comments, levels,
//     escapes, `--`, `--[==[`, `[[ ]]`, `[=[ ]=]`, numeric literals).
//  2. Block balancing on TOKENS, with `do` attributed correctly: Luau opens a
//     block on function/if/then/for/while/do/repeat and closes on end/until.
//     `while … do` and `for … do` must NOT double count, so `do` only opens when
//     it is a standalone statement (`do … end`), never as a loop header.
//  3. A precise, line-numbered diagnostic when something IS wrong, instead of a
//     vague "likely missing end".
//  4. Honest capability reporting: this is STATIC analysis. It cannot detect
//     runtime nil-derefs. No claim is made that it can.
(() => {
  "use strict";
  const VERSION = "4.7.0";

  // ── Tokenizer ────────────────────────────────────────────────────────────
  // Returns { tokens:[{type,value,line}], error } — never throws on bad input,
  // because a half-streamed AI reply is a legitimate input here.
  function tokenize(src) {
    const s = String(src || "");
    const tokens = [];
    let i = 0, line = 1;
    const n = s.length;
    const push = (type, value, ln) => tokens.push({ type, value, line: ln });

    while (i < n) {
      const c = s[i];

      // newline
      if (c === "\n") { line++; i++; continue; }
      // whitespace
      if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }

      // comments: --[[ long ]] / --[==[ ... ]==] / -- short
      if (c === "-" && s[i + 1] === "-") {
        const startLine = line;
        const lvl = longBracketLevel(s, i + 2);
        if (lvl >= 0) {
          const open = i + 2, closeAt = findLongClose(s, open + lvl + 2, lvl);
          if (closeAt < 0) return { tokens, error: { msg: "unterminated long comment opened with '--[" + "=".repeat(lvl) + "[", line: startLine } };
          line += countNewlines(s.slice(i, closeAt + lvl + 2));
          i = closeAt + lvl + 2;
          continue;
        }
        const nl = s.indexOf("\n", i);
        i = nl < 0 ? n : nl; // leave the \n for the newline case
        continue;
      }

      // long string [[ ]] / [==[ ]==]
      if (c === "[") {
        const lvl = longBracketLevel(s, i);
        if (lvl >= 0) {
          const startLine = line;
          const closeAt = findLongClose(s, i + lvl + 2, lvl);
          if (closeAt < 0) return { tokens, error: { msg: "unterminated long string [[" + "=".repeat(lvl) + "…", line: startLine } };
          line += countNewlines(s.slice(i, closeAt + lvl + 2));
          push("string", s.slice(i, closeAt + lvl + 2), startLine);
          i = closeAt + lvl + 2;
          continue;
        }
      }

      // short strings with escapes
      if (c === '"' || c === "'") {
        const startLine = line;
        let j = i + 1, closed = false;
        while (j < n) {
          const d = s[j];
          if (d === "\\") { if (s[j + 1] === "\n") line++; j += 2; continue; }
          if (d === "\n") break;               // unterminated at end of line
          if (d === c) { closed = true; j++; break; }
          j++;
        }
        if (!closed) return { tokens, error: { msg: "unterminated string literal", line: startLine } };
        push("string", s.slice(i, j), startLine);
        i = j;
        continue;
      }

      // numbers (incl. hex, exponents, Luau `0x1p4`, and 1_000 separators)
      if (isDigit(c) || (c === "." && isDigit(s[i + 1]))) {
        const startLine = line;
        let j = i;
        if (c === "0" && (s[i + 1] === "x" || s[i + 1] === "X")) {
          j = i + 2;
          while (j < n && /[0-9a-fA-F_.]/.test(s[j])) j++;
          if (s[j] === "p" || s[j] === "P") { j++; if (s[j] === "+" || s[j] === "-") j++; while (j < n && isDigit(s[j])) j++; }
        } else {
          while (j < n && /[0-9_.]/.test(s[j])) j++;
          if (s[j] === "e" || s[j] === "E") { j++; if (s[j] === "+" || s[j] === "-") j++; while (j < n && isDigit(s[j])) j++; }
        }
        push("number", s.slice(i, j), startLine);
        i = j;
        continue;
      }

      // identifiers / keywords
      if (isIdentStart(c)) {
        let j = i + 1;
        while (j < n && isIdentPart(s[j])) j++;
        push("name", s.slice(i, j), line);
        i = j;
        continue;
      }

      // multi-char operators (so we never mis-read .. / ... / == / ~= / :: )
      const three = s.slice(i, i + 3), two = s.slice(i, i + 2);
      if (three === "...") { push("op", three, line); i += 3; continue; }
      if (["..", "==", "~=", "<=", ">=", "::", "//", "->", "+=", "-=", "*=", "/=", "%=", "<<", ">>", "|", "&"].includes(two) && two.length === 2) {
        // only treat as one token when it really is a 2-char operator
        if (["..", "==", "~=", "<=", ">=", "::", "//"].includes(two)) { push("op", two, line); i += 2; continue; }
      }
      push("paren", c, line);
      i++;
    }
    return { tokens, error: null };
  }

  const isDigit = (c) => c >= "0" && c <= "9";
  const isIdentStart = (c) => !!c && /[A-Za-z_]/.test(c);
  const isIdentPart = (c) => !!c && /[A-Za-z0-9_]/.test(c);
  const countNewlines = (str) => (str.match(/\n/g) || []).length;

  // `[`, `[=`, `[==` … followed by `[`?  returns level, else -1
  function longBracketLevel(s, at) {
    if (s[at] !== "[") return -1;
    let k = at + 1, level = 0;
    while (s[k] === "=") { level++; k++; }
    return s[k] === "[" ? level : -1;
  }
  // find the closing `]==]` for a level-n opener, starting at `from`
  function findLongClose(s, from, level) {
    const closer = "]" + "=".repeat(level) + "]";
    const at = s.indexOf(closer, from);
    return at; // -1 when unterminated
  }

  // ── Block balance on tokens ──────────────────────────────────────────────
  const LOOP_HEADS = new Set(["for", "while"]);

  // 4.6.0 speed: identical Luau blocks are analysed once (bounded cache).
  const _analyseCache = new Map();
  function analyseLuau(code) {
    const src = String(code || "");
    if (!src.trim()) return { ok: false, kind: "syntax", error: "empty code block", line: 0 };
    const cacheKey = src.length + ":" + src.slice(0, 64) + ":" + src.slice(-64);
    const hit = _analyseCache.get(cacheKey);
    if (hit && hit.src === src) {
      return hit.result.warnings ? { ...hit.result, warnings: hit.result.warnings.slice() } : { ...hit.result };
    }
    const result = _analyseLuauInner(src);
    if (_analyseCache.size >= 128) _analyseCache.delete(_analyseCache.keys().next().value);
    _analyseCache.set(cacheKey, {
      src,
      result: result.warnings ? { ...result, warnings: result.warnings.slice() } : { ...result },
    });
    return result;
  }
  function _analyseLuauInner(src) {

    const { tokens, error } = tokenize(src);
    if (error) return { ok: false, kind: "syntax", error: error.msg, line: error.line };

    const stack = [];
    // Track whether the current `do` was consumed by a for/while header.
    let pendingLoopHead = false;

    for (let idx = 0; idx < tokens.length; idx++) {
      const t = tokens[idx];
      if (t.type !== "name") continue;
      const v = t.value;

      if (LOOP_HEADS.has(v)) { stack.push({ kw: v, line: t.line }); pendingLoopHead = true; continue; }

      if (v === "do") {
        // `for … do` / `while … do` : the header already opened the block.
        if (pendingLoopHead) { pendingLoopHead = false; continue; }
        stack.push({ kw: "do", line: t.line });
        continue;
      }
      if (v === "then") { pendingLoopHead = false; continue; } // `if` already counted

      if (v === "function") { stack.push({ kw: "function", line: t.line }); pendingLoopHead = false; continue; }
      if (v === "if") { stack.push({ kw: "if", line: t.line }); pendingLoopHead = false; continue; }
      if (v === "repeat") { stack.push({ kw: "repeat", line: t.line }); pendingLoopHead = false; continue; }

      if (v === "end") {
        // pop the nearest non-repeat block
        const at = lastIndexOfKw(stack, new Set(["if", "for", "while", "do", "function"]));
        if (at < 0) return { ok: false, kind: "syntax", error: `unexpected 'end' with nothing open`, line: t.line };
        stack.splice(at, 1);
        continue;
      }
      if (v === "until") {
        const at = lastIndexOfKw(stack, new Set(["repeat"]));
        if (at < 0) return { ok: false, kind: "syntax", error: "unexpected 'until' without 'repeat'", line: t.line };
        stack.splice(at, 1);
        continue;
      }
      if (v === "else" || v === "elseif") { pendingLoopHead = false; continue; }
    }

    if (stack.length) {
      const top = stack[stack.length - 1];
      const need = top.kw === "repeat" ? "until" : "end";
      return {
        ok: false, kind: "syntax",
        error: `${stack.length} block(s) never closed — '${top.kw}' opened on line ${top.line} needs '${need}'`,
        line: top.line,
        hint: `add the missing '${need}' (open blocks: ${stack.map(x => x.kw + "@" + x.line).join(", ")})`,
      };
    }

    // ── warning-only checks (never block a valid program) ──────────────────
    const warnings = [];
    if (/[^:]:WaitForChild\s*\(\s*"[^"]*"\s*\)/.test(src) && !/:WaitForChild\s*\([^,]+,\s*\d+\s*\)/.test(src))
      warnings.push("WaitForChild without a timeout can yield forever inside execute_luau — use WaitForChild(\"X\", 5)");
    if (/\bprint\s*\(/.test(src))
      warnings.push("print() output is NOT captured by execute_luau — use `return` to see values");
    if (/\.Position\s*=\s*"/.test(src))
      warnings.push("Position assigned a string — needs Vector3.new(x, y, z)");
    if (/\bgame\.Workspace\b/.test(src) && !/\bgame:GetService\(\s*["']Workspace["']\s*\)/.test(src))
      warnings.push("prefer game:GetService(\"Workspace\") over the game.Workspace shorthand in scripts");

    return {
      ok: true, kind: "static",
      tokens: tokens.length,
      warnings,
      note: "static analysis only — no Luau VM here; runtime behaviour must be verified in Studio",
    };
  }
  function lastIndexOfKw(stack, set) {
    for (let i = stack.length - 1; i >= 0; i--) if (set.has(stack[i].kw)) return i;
    return -1;
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
  // errors. It is honesty-labelled as parse-only; the old version claimed to
  // "run against a mock Roblox env", which it never did.
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

  // ── Reply scan: find every executable payload and check it ───────────────
  function extractPayloads(replyText) {
    const text = String(replyText || "");
    const out = [];
    // ###LUA### … ###END_LUA### (and the :Server / :Client datamodel variants)
    const reLua = /###\s*LUA(?::(?:Server|Client|Edit))?\s*###([\s\S]*?)###\s*END_LUA\s*###/gi;
    let m;
    while ((m = reLua.exec(text)) !== null) out.push({ kind: "luau", code: m[1] });
    // fenced ```lua
    const reFence = /```(?:lua|luau)\s*\n([\s\S]*?)```/gi;
    while ((m = reFence.exec(text)) !== null) out.push({ kind: "luau", code: m[1] });
    return out;
  }
  function dryRunReply(replyText) {
    const payloads = extractPayloads(replyText);
    if (!payloads.length) return { ok: true, kind: "no-code", blocks: 0 };
    const results = [];
    for (let i = 0; i < payloads.length; i++) {
      const p = payloads[i];
      const r = analyseLuau(p.code);
      results.push({ block: i + 1, ok: r.ok, error: r.error, line: r.line, hint: r.hint, warnings: r.warnings || [] });
      if (!r.ok) return { ok: false, kind: "syntax", error: r.error, line: r.line, hint: r.hint, block: i + 1, blocks: payloads.length, results };
    }
    return { ok: true, kind: "static", blocks: payloads.length, results };
  }

  function formatFixFeedback(dryResult) {
    if (!dryResult || dryResult.ok) return null;
    const where = dryResult.line ? ` (line ${dryResult.line})` : "";
    const hint = dryResult.hint ? `\nHint: ${dryResult.hint}` : "";
    return `ERROR (static Luau check)${where}: ${dryResult.error}${hint}\n` +
      `Fix the code and retry. This check is static — it only rejects code that cannot possibly parse.`;
  }

  // ── Test-contract helper (unchanged behaviour, kept because the prompt
  //    enhancer consumes it) ────────────────────────────────────────────────
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
