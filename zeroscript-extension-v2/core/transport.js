// SPDX-License-Identifier: GPL-3.0-or-later
// core/transport.js — ZeroScript ULTRA+ transport abstraction v2.2.0
// Provides unified Transport API for all middle-layer methods.
// The actual WebSocket/HTTP/SSE/Batch logic lives in background.js (service worker);
// this module is the content-script side thin client that talks to background via
// chrome.runtime.sendMessage but adds ultra features: coalescing, cache, retry,
// metrics, and batch orchestration. Kept separate so providers remain agnostic.
//
// All GUIs/colors untouched — this is pure logic.
(() => {
  "use strict";
  const ZS_Transport = (() => {
    const CACHE_MS = 1200; // v2.2: tighter cache for faster Studio attach
    const _cache = new Map(); // key -> {v, exp}
    const _inflight = new Map(); // key -> promise

    function _key(m){ try{ return JSON.stringify(m); }catch{ return String(m.type); } }
    function _getCache(k){ const e=_cache.get(k); if(!e) return null; if(Date.now()>e.exp){ _cache.delete(k); return null;} return e.v; }
    function _setCache(k,v,ttl=CACHE_MS){ _cache.set(k,{v,exp:Date.now()+ttl}); if(_cache.size>64){ const f=_cache.keys().next().value; _cache.delete(f);} }

    // call background with dedupe + retry
    async function _bg(msg, {cacheTtl=0, retry=1}={}){
      const k=_key(msg);
      if(cacheTtl){
        const h=_getCache(k); if(h) return h;
      }
      if(_inflight.has(k)) return _inflight.get(k);
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
            return r;
          }
          if(attempt<retry) await new Promise(r=>setTimeout(r, 120* (attempt+1)));
          else return r;
        }
      })();
      _inflight.set(k,p);
      p.finally(()=> _inflight.delete(k));
      return p;
    }

    async function status(){ return _bg({type:"status"}, {cacheTtl:300}); } // v2.2: 300ms for instant studio drop detection
    async function listTools(force=false){ return _bg({type:"list_tools", force}, {cacheTtl: force?0:600}); }
    async function callTool(name, args, timeout=120000){
      return _bg({type:"call_tool", name, arguments:args, timeout}, {retry:1});
    }
    async function callBatch(calls){ // [{name, arguments, timeout}]
      if(!calls || !calls.length) return {ok:false, error:"no calls"};
      // if single, use normal path for compatibility
      if(calls.length===1) return callTool(calls[0].name, calls[0].arguments, calls[0].timeout);
      return _bg({type:"call_batch", calls}, {retry:0});
    }
    async function metrics(){ return _bg({type:"metrics"}, {cacheTtl:1000}); }
    async function ping(){ return _bg({type:"ping"}, {cacheTtl:0}); }

    return { status, listTools, callTool, callBatch, metrics, ping };
  })();
  // expose globally for main.js if needed
  try{ window.ZS_Transport=ZS_Transport; }catch{}
  if(typeof self!=='undefined') try{ self.ZS_Transport=ZS_Transport; }catch{}
})();
