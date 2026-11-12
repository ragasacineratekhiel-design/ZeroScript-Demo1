// SPDX-License-Identifier: GPL-3.0-or-later
// core/transport.js — ZeroScript MAX transport abstraction v4.6.0
// Content-script thin client to background.js (service worker) with read-only
// cache/coalescing, explicit cache invalidation, WS-first team mailboxes, and
// non-replayed tool/batch/verifyFact calls.
(() => {
  "use strict";
  const VERSION = "4.7.0";
  const ZS_Transport = (() => {
    const CACHE_MS = 600;
    const _cache = new Map();
    const _inflight = new Map();

    function _key(m) {
      try { return JSON.stringify(m); }
      catch (_e) { globalThis.ZSSafe?.seen?.("transport.key", _e); return String(m && m.type); }
    }
    function _getCache(k) {
      const e = _cache.get(k);
      if (!e) return null;
      if (Date.now() > e.exp) { _cache.delete(k); return null; }
      return e.v;
    }
    function _setCache(k, v, ttl = CACHE_MS) {
      _cache.set(k, { v, exp: Date.now() + ttl });
      if (_cache.size > 64) _cache.delete(_cache.keys().next().value);
    }
    function invalidate(prefix) {
      if (!prefix) { _cache.clear(); return; }
      for (const k of [..._cache.keys()]) if (k.includes(prefix)) _cache.delete(k);
    }

    function _bg(msg, { cacheTtl = 0, retry = 2 } = {}) {
      const k = _key(msg);
      if (cacheTtl) {
        const h = _getCache(k);
        if (h) return Promise.resolve(h);
        if (_inflight.has(k)) return _inflight.get(k);
      }
      const p = (async () => {
        for (let attempt = 0; attempt <= retry; attempt++) {
          const r = await new Promise((res) => {
            try {
              chrome.runtime.sendMessage(msg, (resp) => {
                if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
                else res(resp || { ok: false, error: "no response" });
              });
            } catch (e) { globalThis.ZSSafe?.seen?.("transport.send", e); res({ ok: false, error: String(e) }); }
          });
          if (r && (r.ok || (msg.type === "status" && typeof r.connected === "boolean"))) {
            if (cacheTtl) _setCache(k, r, cacheTtl);
            return r;
          }
          if (attempt < retry) await new Promise((r2) => setTimeout(r2, 80 * (attempt + 1)));
          else return r;
        }
        return { ok: false, error: "transport exhausted" };
      })();
      if (cacheTtl) _inflight.set(k, p);
      p.finally(() => _inflight.delete(k));
      return p;
    }

    function status() { return _bg({ type: "status" }, { cacheTtl: 120 }); }
    function listTools(force = false) { return _bg({ type: "list_tools", force }, { cacheTtl: force ? 0 : 400 }); }
    function callTool(name, args, timeout = 120000) {
      invalidate("status");
      return _bg({ type: "call_tool", name, arguments: args, timeout }, { retry: 0 });
    }
    function callBatch(calls) {
      if (!calls || !calls.length) return Promise.resolve({ ok: false, error: "no calls" });
      if (calls.length === 1) return callTool(calls[0].name, calls[0].arguments, calls[0].timeout);
      invalidate("status");
      return _bg({ type: "call_batch", calls }, { retry: 0 });
    }
    function metrics() { return _bg({ type: "metrics" }, { cacheTtl: 600 }); }
    function ping() { return _bg({ type: "ping" }, { cacheTtl: 0 }); }
    function team(action, payload = {}) {
      const map = { status: "team_status", inbox: "team_inbox", ack: "team_ack", send: "team_send", ready: "team_ready", summary: "team_summary" };
      const type = map[action] || ("team_" + action);
      return _bg({ type, ...payload }, { retry: 0 });
    }
    function verifyFact(path, tool) {
      return _bg({ type: "verify_fact", path: path || "", tool: tool || "inspect_instance" }, { retry: 0 });
    }

    return { VERSION, status, listTools, callTool, callBatch, metrics, ping, team, verifyFact, invalidate };
  })();
  try { window.ZS_Transport = ZS_Transport; } catch (_e) { globalThis.ZSSafe?.seen?.("transport.export", _e); }
  if (typeof self !== "undefined") try { self.ZS_Transport = ZS_Transport; } catch (_e) { globalThis.ZSSafe?.seen?.("transport.export", _e); }
})();
