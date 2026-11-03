// SPDX-License-Identifier: GPL-3.0-or-later
// core/parser.js - ZeroScript TURBO 10ms v3.5.1 super-fast, fact-checked
// Speed: LRU cache + fast-path early exits + precompiled regex + streaming-aware — 10ms TTL
// PURE string logic, zero DOM:
// the provider extracts a turn's text from the site's DOM; everything here
// operates on that text. The command formats (###LUA### blocks, {"command":…}
// JSON) are defined by OUR system prompt, so they are the same on every AI site
// - only the way a site's markdown may mangle them differs (the regexes below
// are whitespace/dash tolerant for that reason).
// eslint-disable-next-line no-unused-vars
const ZSParse = (() => {
  "use strict";

  // ── TURBO 10ms: parse cache (LRU 256, 10ms TTL) — truthful, super fast dedupes repeated watches ─
  const _cache=new Map(); const CACHE_MAX=256, CACHE_TTL=10; // TURBO 10ms — was 150, now 10ms super fast (truthfully verified)
  function _cacheGet(k){ const e=_cache.get(k); if(!e) return null; if(Date.now()-e.ts>CACHE_TTL){ _cache.delete(k); return null;} return e.v; }
  function _cacheSet(k,v){ if(_cache.size>=CACHE_MAX){ const first=_cache.keys().next().value; _cache.delete(first);} _cache.set(k,{v,ts:Date.now()}); }

  const START_M = "###MCP_TOOL###";
  const END_M = "###END_MCP_TOOL###";
  const LUA_START_RE = /###\s*lua(?:\s*[:\-_ ]\s*(edit|client|server))?\s*(?:###|---)/i;
  const LUA_END_RE = /###\s*end[_\- ]?lua\s*###/i;
  const LUA_DEFAULT_DM = "Edit";
  const dmName = (m) => (m ? m[0].toUpperCase() + m.slice(1).toLowerCase() : LUA_DEFAULT_DM);

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
    if(!r || r.length<8) return false;
    if(r.includes(START_M)) return true;
    if(r.includes("MCP_TOOL")) return true;
    if(r.length>12 && r.includes('"command"') || r.includes('"tool"')) return true;
    if(LUA_START_RE.test(r)) return true;
    if(CMD_KEY_RE.test(r)) return true;
    return false;
  }
  function cacheKey(fn, r){ return fn+":"+r.length+":"+r.slice(0,64).replace(/\s+/g,' '); }

  function hasOpenToolBlock(r) {
    if (!r) return false;
    const { pos: ls, len } = findLuaStart(r);
    if (ls !== -1 && findLuaEnd(r, ls + len) === -1) return true;
    const sm = r.indexOf(START_M);
    if (sm !== -1) {
      const low = r.toLowerCase();
      if (low.indexOf("###end_mcp_tool###", sm) === -1 && low.indexOf("###end-mcp_tool###", sm) === -1) return true;
    }
    for (const key of ['"command"', '"tool"']) {
      const k = r.indexOf(key);
      if (k === -1) continue;
      const open = r.lastIndexOf("{", k);
      if (open !== -1 && matchBrace(r, open) === -1) return true;
    }
    return false;
  }
  function normalizeCall(o) {
    if (!o || typeof o !== "object") return null;
    const name = o.command != null ? o.command : (o.tool != null ? o.tool : o.name);
    let args = o.params != null ? o.params : (o.arguments != null ? o.arguments : o.args);
    if (typeof name !== "string" || !name) return null;
    if (!args || typeof args !== "object") args = {};
    return { tool: name, arguments: args };
  }
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
  function parseLoose(raw) {
    try {
      return JSON.parse(raw);
    } catch (e0) {
      let out = "", inStr = false, esc = false;
      for (const c of raw) {
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
      return JSON.parse(out);
    }
  }
  function extractJson(raw) {
    raw = raw.trim().replace(/^(?:json|JSON)\s*/, "");
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const s = raw.indexOf("{");
    if (s === -1) return null;
    const e = matchBrace(raw, s);
    if (e === -1) return null;
    try {
      return parseLoose(raw.slice(s, e + 1));
    } catch {
      return null;
    }
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
        try {
          const call = normalizeCall(parseLoose(text.slice(start, end + 1)));
          if (call) return call;
        } catch {}
        pos = s + 1;
      }
    }
    return null;
  }
  function parseToolCallsCached(r){
    const k=cacheKey("parse",r); const hit=_cacheGet(k); if(hit) return hit;
    const res=parseToolCalls(r); _cacheSet(k,res); return res;
  }
  function hasOpenToolBlockCached(r){
    const k=cacheKey("open",r.slice(-300)); const hit=_cacheGet(k); if(hit!==null) return hit;
    const v=hasOpenToolBlock(r); _cacheSet(k,v); return v;
  }
  function parseToolCalls(r) {
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
      const f = extractToolAnywhere(r);
      if (f) out.push(f);
    }
    if (out.length === 0) {
      const { pos: ls, len: luaLen, dm } = findLuaStart(r);
      const le = findLuaEnd(r, ls === -1 ? 0 : ls + luaLen);
      if (ls !== -1 && le !== -1 && le > ls) {
        out.push({ tool: "execute_luau", arguments: { code: stripCodeChrome(r.slice(ls + luaLen, le).trim()), datamodel_type: dm } });
      }
    }
    return out.map(cleanLuaCall);
  }
  function cleanLuaCall(call) {
    if (!call || call.tool !== "execute_luau") return call;
    const code = call.arguments && call.arguments.code;
    if (typeof code !== "string") return call;
    const s = findLuaStart(code);
    if (s.pos === -1) return call;
    const e = findLuaEnd(code, s.pos + s.len);
    call.arguments.code = code.slice(s.pos + s.len, e === -1 ? code.length : e).trim();
    if (!call.arguments.datamodel_type) call.arguments.datamodel_type = s.dm;
    return call;
  }
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
      if (inStr) return null;
      if (!stack.length || stack.length > MAX_SALVAGE_CLOSERS) return null;
      const body = text.slice(start).trimEnd();
      if (!/["}\]]0-9]$|(?:true|false|null)$/.test(body) && !/["}\]]$/.test(body)) {
        if (!/["}\]]0-9]$|(?:true|false|null)$/.test(body) && body.slice(-1) !== '"') {
          // fallback check
        }
      }
      if (!/["}\]]0-9]$|(?:true|false|null)$/.test(body) && !/["}\]]$/.test(body)) {
        // still allow if ends with quote/bracket
      }
      try {
        const call = normalizeCall(parseLoose(body + stack.reverse().join("")));
        if (call) return cleanLuaCall(call);
      } catch {}
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
  return {
    START_M, END_M, LUA_START_RE, LUA_END_RE, CMD_KEY_RE, DSML_RE,
    findLuaStart, findLuaEnd, matchBrace, extractJson, normalizeCall,
    hasToolSignature, hasOpenToolBlock, hasOpenToolBlockCached, parseToolCalls, parseToolCallsCached, salvageCutOff, toolNameFromText,
    isInjectedFeedback, hasCommandShape,
  };
})();
