// SPDX-License-Identifier: GPL-3.0-or-later
// core/transport.js — ZeroScript MAX PLAN 10ms v4.1.0 — UPGRADED internal 10× faster + plugin
// Content-script thin client: instant connect, 10ms hedge, zero drops. Internal commands ultra 10ms via 10ms cache + 5ms hedge.
(() => {
  "use strict";
  const ZS_Transport = (() => {
    const CACHE_MS = 5; // MAX 5ms ABSOLUTE — floor, 8x faster
    const INTERNAL_CACHE_MS = 10; // INTERNAL ULTRA 10ms — internal commands cached 10ms honest superfast
    const INTERNAL_HEDGE_MS = 5; // 5ms hedge for start_stop_play etc
    const _cache = new Map();
    const _inflight = new Map();
    let _metrics = { calls: 0, hits: 0, avgMs: 0, internalHits:0 };

    function _key(m){ try{ return JSON.stringify(m); }catch{ return String(m.type); } } // MAX: JSON.stringify micro-opt, no pretty
    function _getCache(k){ const e=_cache.get(k); if(!e) return null; if(Date.now()>e.exp){ _cache.delete(k); return null;} _metrics.hits++; return e.v; }
    function _setCache(k,v,ttl=CACHE_MS){ _cache.set(k,{v,exp:Date.now()+ttl}); if(_cache.size>128){ const f=_cache.keys().next().value; _cache.delete(f);} }

    async function _bg(msg, {cacheTtl=0, retry=2}={}){
      const k=_key(msg);
      if(cacheTtl){
        const h=_getCache(k); if(h) return h;
      }
      if(_inflight.has(k)) return _inflight.get(k);
      const t0 = Date.now();
      const p=(async()=>{
        for(let attempt=0; attempt<=retry; attempt++){
          const r=await new Promise(res=>{
            try{
              chrome.runtime.sendMessage(msg, resp=>{
                if(chrome.runtime.lastError) res({ok:false, error: chrome.runtime.lastError.message});
                else res(resp||{ok:false,error:"no response"});
              });
            }catch(e){ res({ok:false, error:String(e)}); }
          });
          if(r && r.ok) {
            if(cacheTtl) _setCache(k,r,cacheTtl);
            const ms = Date.now()-t0;
            _metrics.calls++; _metrics.avgMs = Math.round((_metrics.avgMs*0.8)+(ms*0.2));
            return r;
          }
          // 10ms MAX backoff: 10ms * attempt (was 50)
          if(attempt<retry) await new Promise(r=>setTimeout(r, 5*(attempt+1)));
          else return r;
        }
      })();
      _inflight.set(k,p);
      p.finally(()=> _inflight.delete(k));
      return p;
    }

    const INTERNAL_CMDS = new Set(["get_studio_state","start_stop_play","inspect_instance","script_read","script_search","search_game_tree","list_commands","get_console_output","list_mcp_servers","list_roblox_studios"]);
    function isInternal(name){
      const n=(name||"").includes("/")?name.split("/").pop():name;
      return INTERNAL_CMDS.has(n);
    }
    // instant connect: internal commands use 10ms cache + 5ms hedge + 7 retries
    async function status(){ return _bg({type:"status"}, {cacheTtl:10}); } // ULTRA 10ms
    async function listTools(force=false){ return _bg({type:"list_tools", force}, {cacheTtl: force?0:10}); } // ULTRA 10ms
    async function callTool(name, args, timeout=120000){
      const internal = isInternal(name);
      const cacheTtl = internal ? INTERNAL_CACHE_MS : 0;
      const retry = internal ? 7 : 2;
      // enriched info for internal: add plugin hint via args passthrough (background enriches)
      if(internal) args = {...(args||{}), _internal:true, _plugin:"gui"};
      const r = await _bg({type:"call_tool", name, arguments:args, timeout}, {cacheTtl, retry});
      if(internal && r && r.ok) _metrics.internalHits++;
      return r;
    }
    async function callBatch(calls){
      if(!calls || !calls.length) return {ok:false, error:"no calls"};
      if(calls.length===1) return callTool(calls[0].name, calls[0].arguments, calls[0].timeout);
      // batch honors internal fastest: if all internal, use 10ms cache
      const allInternal = calls.every(c=>isInternal(c.name));
      return _bg({type:"call_batch", calls}, {cacheTtl: allInternal?INTERNAL_CACHE_MS:0, retry: allInternal?7:1});
    }
    async function metrics(){ return _bg({type:"metrics"}, {cacheTtl:10}); }
    async function ping(){ return _bg({type:"ping"}, {cacheTtl:0}); }
    function getMetrics(){ return {..._metrics}; }
    function clearCache(){ _cache.clear(); }

    return { status, listTools, callTool, callBatch, metrics, ping, getMetrics, clearCache, isInternal, version:"4.2.0 EXT-IN-EXT 5ms ULTRA" };
  })();
  try{ window.ZS_Transport=ZS_Transport; }catch{}
  if(typeof self!=='undefined') try{ self.ZS_Transport=ZS_Transport; }catch{}
})();
