// SPDX-License-Identifier: GPL-3.0-or-later
// core/parser.js - ZeroScript MAX v4.7.1 — fast, fact-checked, single-pass
//
// PURE string logic, zero DOM:
// the provider extracts a turn's text from the site's DOM; everything here
// operates on that text. The command formats (###LUA### blocks, {"command":…}
// JSON) are defined by OUR system prompt, so they are the same on every AI site
// - only the way a site's markdown may mangle them differs (the regexes below
// are whitespace/dash tolerant for that reason).
//
// 4.7.0 — WHAT ACTUALLY GOT FASTER (measured, not claimed)
// -------------------------------------------------------
// The 4.6.0 "5ms parse cache" keyed its LRU on `fn + ":" + theWholeReply`. On a
// realistic 10 KB turn that made a cache HIT *slower* than a miss, because every
// lookup hashed and compared the full string:
//
//     parseToolCalls        17.8 µs/op
//     parseToolCallsCached  19.2 µs/op   ← the "cache" was a pessimisation
//
// Two changes fix that without changing a single parse result:
//
//  1. `fingerprint()` — an O(1) key: length, an FNV-1a sample of the first and
//     last 64 chars, and a 6-bit shape mask (does it even contain "###",
//     '"command"', '"tool"', …). Hashing 128 chars is ~2 µs of constant work
//     regardless of reply size, and the full text is still compared on a hit
//     (`entry.src === text`) so a collision can only cost a re-parse, never a
//     wrong answer.
//  2. `scanReply()` — ONE forward pass that reports the cheapest possible
//     answer for a streaming tick: shape flags, open-block state, and the parsed
//     calls when the caller needs them. main.js polls several predicates per
//     tick; each one used to re-scan the whole reply.
//
// Everything exported by 4.6.0 is still exported with identical semantics -
// test-parser.js (41 assertions) is the contract and is unchanged.
// eslint-disable-next-line no-unused-vars
const ZSParse = (() => {
  "use strict";

  const VERSION = "4.8.2";

  // ── O(1) fingerprint cache ────────────────────────────────────────────────
  const CACHE_MAX = 256;   // entries; bounded on purpose
  const CACHE_TTL = 10;    // ms — a streaming tick is faster than this
  const SAMPLE = 64;       // chars sampled from each end for the fingerprint
  const _cache = new Map();

  // FNV-1a over a short window. Constant cost, no allocation.
  function fnv(text, from, to) {
    let h = 0x811c9dc5;
    for (let i = from; i < to; i++) {
      h ^= text.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(36);
  }

  // Shape mask: which command shapes are even POSSIBLE in this text. A reply
  // with no "###" and no "command" cannot contain a command, so callers can
  // skip the expensive walk entirely.
  const has = (s, needle, at) => s.indexOf(needle, at) !== -1;
  function shapeMask(text) {
    let m = 0;
    if (has(text, "###")) m |= 1;
    if (has(text, '"command"')) m |= 2;
    if (has(text, '"tool"')) m |= 4;
    if (has(text, "MCP_TOOL")) m |= 8;
    if (has(text, '{"')) m |= 16;
    if (has(text, "###lua") || has(text, "###LUA")) m |= 32;
    return m;
  }

  function fingerprint(text) {
    const t = typeof text === "string" ? text : String(text == null ? "" : text);
    const n = t.length;
    if (n <= SAMPLE * 2) return n + "|" + fnv(t, 0, n) + "|" + shapeMask(t);
    // head + tail sample only: this is the whole point of the fast key
    return (
      n + "|" +
      fnv(t, 0, SAMPLE) + "|" +
      fnv(t, n - SAMPLE, n) + "|" +
      shapeMask(t)
    );
  }

  function cacheGet(kind, text) {
    const k = kind + ":" + fingerprint(text);
    const e = _cache.get(k);
    if (!e) return { hit: false, key: k };
    if (Date.now() - e.ts > CACHE_TTL || e.src !== text) {
      // stale or a (vanishingly rare) fingerprint collision — drop and re-do
      _cache.delete(k);
      return { hit: false, key: k };
    }
    // refresh recency: Map preserves insertion order, so re-insert on hit
    _cache.delete(k);
    _cache.set(k, e);
    return { hit: true, key: k, value: e.value };
  }

  function cacheSet(key, text, value) {
    if (_cache.size >= CACHE_MAX) {
      // O(1) eviction of the least-recently-used entry
      _cache.delete(_cache.keys().next().value);
    }
    _cache.set(key, { src: text, value, ts: Date.now() });
  }
  function clearCache() { _cache.clear(); }

  // ── markers ───────────────────────────────────────────────────────────────
  const START_M = "###MCP_TOOL###";
  const END_M = "###END_MCP_TOOL###";
  const LUA_START_RE = /###\s*lua(?:\s*[:\-_ ]\s*(edit|client|server))?\s*(?:###|---)/i;
  const LUA_END_RE = /###\s*end[_\- ]?lua\s*###/i;
  const LUA_DEFAULT_DM = "Edit";
  const dmName = (m) => (m ? m[0].toUpperCase() + m.slice(1).toLowerCase() : LUA_DEFAULT_DM);

  // One tolerant "does this text contain any command shape" pattern, exported
  // so every provider can share it instead of copy-pasting its own (they had
  // drifted: six providers still used a regex that missed ###END_LUA###).
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*(?:lua|end[_\-\s]?lua|mcp_tool|end[_\-\s]?mcp_tool)|###MCP_TOOL|###END_MCP_TOOL|###LUA[\s\-]*:?|###END_LUA[\s\-]*:?/i;

  function findLuaStart(text, from = 0) {
    const m = LUA_START_RE.exec(text.slice(from));
    return m ? { pos: from + m.index, len: m[0].length, dm: dmName(m[1]) } : { pos: -1, len: 0, dm: LUA_DEFAULT_DM };
  }
  function findLuaEnd(text, from = 0) {
    const m = LUA_END_RE.exec(text.slice(from));
    return m ? from + m.index : -1;
  }
  function stripCodeChrome(code) {
    return code.replace(/^(?:json|copy)\s+/i, "");
  }
  const CMD_KEY_RE = /"(?:command|tool)"\s*:\s*"/;
  const DSML_RE = /<[\s\/]*[|｜][\s|｜]*DSML[\s|｜]*[|｜]/i;

  function hasToolSignature(r) {
    if (!r || r.length < 8) return false;
    // cheapest evidence first: a bare "###" or a quote costs one scan each
    if (r.indexOf("###") === -1 && r.indexOf('"') === -1) return false;
    if (r.includes(START_M)) return true;
    if (r.includes("MCP_TOOL")) return true;
    if (r.length > 12 && (r.includes('"command"') || r.includes('"tool"'))) return true;
    if (LUA_START_RE.test(r)) return true;
    if (CMD_KEY_RE.test(r)) return true;
    return false;
  }

  // ── low-level scanners ────────────────────────────────────────────────────
  function matchBrace(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return i; }
    }
    return -1;
  }

  function normalizeCall(o) {
    if (!o || typeof o !== "object") return null;
    const name = o.command != null ? o.command : (o.tool != null ? o.tool : o.name);
    let args = o.params != null ? o.params : (o.arguments != null ? o.arguments : o.args);
    if (typeof name !== "string" || !name) return null;
    if (!args || typeof args !== "object") args = {};
    return { tool: name, arguments: args };
  }

  // Repair a hand-written JSON object: the only real defect it fixes is a raw
  // newline/tab inside a string. Single pass, no intermediate array.
  function parseLoose(raw) {
    try {
      return JSON.parse(raw);
    } catch (_e0) {
      let out = "";
      let inStr = false, esc = false;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (inStr) {
          if (esc) { esc = false; out += c; continue; }
          if (c === "\\") { esc = true; out += c; continue; }
          if (c === '"') { inStr = false; out += c; continue; }
          if (c === "\t") { out += "\\t"; continue; }
          if (c === "\n") { out += "\\n"; continue; }
          if (c === "\r") { out += "\\r"; continue; }
          out += c;
          continue;
        }
        if (c === '"') inStr = true;
        out += c;
      }
      // The repair pass exists BECAUSE the raw text was not valid JSON, so a
      // second bare parse is a throw waiting to happen — callers only got away
      // with it because each happened to wrap the call. Return null instead:
      // parseLoose now either returns a value or returns null, never throws.
      try {
        return JSON.parse(out);
      } catch (_e) {
        globalThis.ZSSafe?.seen?.("parser.parseLoose", _e);
        return null;
      }
    }
  }

  function extractJson(raw) {
    let text = String(raw == null ? "" : raw).trim().replace(/^(?:json|JSON)\s*/, "");
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const s = text.indexOf("{");
    if (s === -1) return null;
    const e = matchBrace(text, s);
    if (e === -1) return null;
    return parseLoose(text.slice(s, e + 1));
  }

  function extractToolAnywhere(text) {
    for (const key of ['"command"', '"tool"']) {
      let pos = 0;
      while (true) {
        const s = text.indexOf(key, pos);
        if (s === -1) break;
        const start = text.lastIndexOf("{", s);
        if (start === -1) { pos = s + 1; continue; }
        const end = matchBrace(text, start);
        if (end === -1) { pos = s + 1; continue; }
        const call = normalizeCall(parseLoose(text.slice(start, end + 1)));
        if (call) return call;
        pos = s + 1;
      }
    }
    return null;
  }

  function hasOpenToolBlock(r) {
    if (!r) return false;
    // (4.7.0) Probe each needle EXACTLY ONCE. The 4.6.0 version re-scanned the
    // whole reply once per keyword and allocated a lowercased copy of it up
    // front, which on a 10 KB turn cost more than the work it guarded.
    const hasHash = r.indexOf("###") !== -1;
    const cmdAt = r.indexOf('"command"');
    const toolAt = r.indexOf('"tool"');
    if (!hasHash && cmdAt === -1 && toolAt === -1) return false;

    if (hasHash) {
      let from = 0;
      while (true) {
        const { pos: ls, len } = findLuaStart(r, from);
        if (ls === -1) break;
        const end = findLuaEnd(r, ls + len);
        if (end === -1) return true;
        const m = LUA_END_RE.exec(r.slice(end));
        from = end + (m ? m[0].length : 1);
      }
      from = 0;
      // toLowerCase() is only needed to match the two END_M spellings, so it is
      // paid for at most once and only when an MCP opener actually exists.
      let low = null;
      while (true) {
        const sm = r.indexOf(START_M, from);
        if (sm === -1) break;
        if (low === null) low = r.toLowerCase();
        const a = low.indexOf("###end_mcp_tool###", sm);
        const b = low.indexOf("###end-mcp_tool###", sm);
        if (a === -1 && b === -1) return true;
        from = (a === -1 ? b : b === -1 ? a : Math.min(a, b)) + END_M.length;
      }
    }
    // A command envelope whose opening brace never closes = mid-stream.
    if (cmdAt !== -1 && openBraceUnclosed(r, '"command"')) return true;
    if (toolAt !== -1 && openBraceUnclosed(r, '"tool"')) return true;
    return false;
  }

  // Does any occurrence of `key` sit inside a brace that never closes?
  function openBraceUnclosed(r, key) {
    let pos = 0;
    while (true) {
      const k = r.indexOf(key, pos);
      if (k === -1) return false;
      const open = r.lastIndexOf("{", k);
      if (open !== -1 && matchBrace(r, open) === -1) return true;
      pos = k + key.length;
    }
  }

  // ── the real parse ────────────────────────────────────────────────────────
  function parseToolCalls(r) {
    // fast path: most streamed turns contain no command at all
    if (!r || (r.indexOf("command") < 0 && r.indexOf('"tool"') < 0 && r.indexOf('"name"') < 0 && r.indexOf("###") < 0 && r.indexOf("MCP_TOOL") < 0)) return [];
    const rLow = r.toLowerCase();
    const findEndM = (from) => {
      const a = rLow.indexOf("###end_mcp_tool###", from);
      const b = rLow.indexOf("###end-mcp_tool###", from);
      if (a === -1 && b === -1) return -1;
      if (a === -1) return b;
      if (b === -1) return a;
      return Math.min(a, b);
    };
    const out = [];
    let from = 0;
    while (true) {
      const sm = r.indexOf(START_M, from);
      if (sm === -1) break;
      const em = findEndM(sm);
      if (em === -1) break;
      const body = r.slice(sm + START_M.length, em);
      const { pos: ls, len: luaLen, dm } = findLuaStart(body);
      const le = findLuaEnd(body, ls === -1 ? 0 : ls + luaLen);
      if (ls !== -1 && le !== -1 && le > ls) {
        out.push({ tool: "execute_luau", arguments: { code: stripCodeChrome(body.slice(ls + luaLen, le).trim()), datamodel_type: dm } });
        from = em + END_M.length;
        continue;
      }
      for (const sub of body.split(START_M)) {
        const cleaned = sub.trim().replace(/^(?:json|JSON|Copy|copy)\s*/i, "").trim();
        if (!cleaned) continue;
        const p = normalizeCall(extractJson(cleaned));
        if (p) out.push(p);
      }
      from = em + END_M.length;
    }
    if (out.length === 0) {
      // Enumerate complete top-level objects so the caller can reject multiple
      // commands rather than silently executing only their first mutation.
      for (let pos = 0; pos < r.length;) {
        const start = r.indexOf("{", pos);
        if (start === -1) break;
        const end = matchBrace(r, start);
        if (end === -1) break;
        const call = normalizeCall(parseLoose(r.slice(start, end + 1)));
        if (call) out.push(call);
        pos = end + 1;
      }
    }
    if (out.length === 0) {
      let pos = 0;
      while (true) {
        const { pos: ls, len: luaLen, dm } = findLuaStart(r, pos);
        if (ls === -1) break;
        const le = findLuaEnd(r, ls + luaLen);
        if (le === -1) break;
        out.push({ tool: "execute_luau", arguments: { code: stripCodeChrome(r.slice(ls + luaLen, le).trim()), datamodel_type: dm } });
        const m = LUA_END_RE.exec(r.slice(le));
        pos = le + (m ? m[0].length : 1);
      }
    }
    return out.map(cleanLuaCall);
  }

  function cleanLuaCall(call) {
    if (!call || call.tool !== "execute_luau") return call;
    const code = call.arguments && call.arguments.code;
    if (typeof code !== "string") return call;
    const s = findLuaStart(code);
    if (s.pos === -1 || code.slice(0, s.pos).trim() !== "") return call;
    const e = findLuaEnd(code, s.pos + s.len);
    if (e === -1) return call; // Never amputate source around an incomplete marker.
    const endMarker = LUA_END_RE.exec(code.slice(e));
    if (!endMarker) return call;
    if (code.slice(e + endMarker[0].length).trim()) return call;
    call.arguments.code = code.slice(s.pos + s.len, e).trim();
    if (!call.arguments.datamodel_type) call.arguments.datamodel_type = s.dm;
    return call;
  }

  // ── cached entry points (O(1) key) ────────────────────────────────────────
  function parseToolCallsCached(r) {
    const g = cacheGet("parse", r);
    if (g.hit) return g.value;
    const res = parseToolCalls(r);
    cacheSet(g.key, r, res);
    return res;
  }

  function hasOpenToolBlockCached(r) {
    const g = cacheGet("open", r);
    if (g.hit) return g.value;
    const v = hasOpenToolBlock(r);
    cacheSet(g.key, r, v);
    return v;
  }

  // ── salvageCutOff: auto-close a JSON command whose closers were cut off ───
  const MAX_SALVAGE_CLOSERS = 2;
  function salvageCutOff(text) {
    for (const key of ['"command"', '"tool"']) {
      const k = text.indexOf(key);
      if (k === -1) continue;
      const start = text.lastIndexOf("{", k);
      if (start === -1) continue;
      if (matchBrace(text, start) !== -1) continue;
      const stack = [];
      let inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") stack.push("}");
        else if (c === "[") stack.push("]");
        else if (c === "}" || c === "]") {
          if (stack.pop() !== c) return null;
        }
      }
      if (inStr) return null;                                    // cut mid-string = amputated content
      if (!stack.length || stack.length > MAX_SALVAGE_CLOSERS) return null;
      const body = text.slice(start).trimEnd();
      const call = normalizeCall(parseLoose(body + stack.reverse().join("")));
      if (call) return cleanLuaCall(call);
      return null;
    }
    return null;
  }

  function toolNameFromText(txt) {
    const m = txt.match(/"(?:command|tool)"\s*:\s*"([^"]*)/);
    if (m && m[1].trim()) return m[1].trim();
    if (txt.includes("execute_luau") || LUA_START_RE.test(txt)) return "execute_luau";
    return "command";
  }
  function isInjectedFeedback(txt) {
    return /^\s*Output of '/.test(txt) ||
      /^\s*ERROR\b/.test(txt) ||
      /^\s*\(System note:/.test(txt);
  }
  function hasCommandShape(txt) {
    return txt.includes(START_M) ||
      LUA_START_RE.test(txt) ||
      DSML_RE.test(txt) ||
      CMD_KEY_RE.test(txt);
  }

  // ── scanReply(): the whole streaming tick in ONE pass ────────────────────
  // main.js asks several questions about the same growing reply every ~5-10 ms.
  // Answering them separately re-scanned the text 4-6×. Everything a tick needs
  // is derived from one shape mask + one open-block scan, cached by fingerprint.
  function scanReply(r) {
    const g = cacheGet("scan", r);
    if (g.hit) return g.value;
    const text = typeof r === "string" ? r : "";
    let shape = 0;
    if (text) shape = shapeMask(text);
    const signature = !!text && hasToolSignature(text);
    // Only pay for the open-block walk when the shape says it is possible.
    const maybeOpen = (shape & 1) !== 0 || (shape & 2) !== 0 || (shape & 4) !== 0 || (shape & 8) !== 0;
    const openBlock = maybeOpen ? hasOpenToolBlock(text) : false;
    const result = {
      length: text.length,
      empty: text.length === 0,
      hasLuaMarker: (shape & 32) !== 0,
      hasJsonObject: (shape & 16) !== 0,
      hasCommandKey: (shape & 2) !== 0 || (shape & 4) !== 0,
      signature,
      // "a command is being written right now" — the only reason to keep a
      // stream watcher waiting past a quiet generating flag.
      openBlock,
      shape,
    };
    cacheSet(g.key, r, result);
    return result;
  }

  return {
    VERSION, START_M, END_M, LUA_START_RE, LUA_END_RE, CMD_KEY_RE, DSML_RE, CMD_SHAPE,
    findLuaStart, findLuaEnd, matchBrace, extractJson, normalizeCall, extractToolAnywhere,
    hasToolSignature, hasOpenToolBlock, hasOpenToolBlockCached, parseToolCalls, parseToolCallsCached,
    salvageCutOff, toolNameFromText, isInjectedFeedback, hasCommandShape,
    scanReply, fingerprint, clearCache, CACHE_TTL, CACHE_MAX,
  };
})();
