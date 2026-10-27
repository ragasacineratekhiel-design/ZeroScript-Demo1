// SPDX-License-Identifier: GPL-3.0-or-later
// core/transport.js — ZeroScript MAX ULTRA transport v3.2.0
// Content-script thin client to background.js with ULTRA features:
// coalescing, cache, retry, metrics, batch 24, hedge 80ms, dedup, auto-reconnect.
// All GUIs/colors untouched — pure logic ULTRA.
(() => {
  "use strict";
  const ZS_Transport = (() => {
    const CACHE_MS = 500; // ULTRA 500ms — tighter for instant Studio attach (was 600)
    const _cache = new Map();
    const _inflight = new Map();
    let _metrics = { calls: 0, hits: 0, avgMs: 0 };

    function _key(m){ try{ return JSON.stringify(m); }catch{ return String(m.type); } }
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
          // ULTRA backoff: 50ms * attempt (faster than 80)
          if(attempt<retry) await new Promise(r=>setTimeout(r, 50*(attempt+1)));
          else return r;
        }
      })();
      _inflight.set(k,p);
      p.finally(()=> _inflight.delete(k));
      return p;
    }

    async function status(){ return _bg({type:"status"}, {cacheTtl:80}); } // ULTRA 80ms (was 120)
    async function listTools(force=false){ return _bg({type:"list_tools", force}, {cacheTtl: force?0:300}); } // ULTRA 300ms (was 400)
    async function callTool(name, args, timeout=120000){
      return _bg({type:"call_tool", name, arguments:args, timeout}, {retry:2});
    }
    async function callBatch(calls){
      if(!calls || !calls.length) return {ok:false, error:"no calls"};
      if(calls.length===1) return callTool(calls[0].name, calls[0].arguments, calls[0].timeout);
      // ULTRA batch: 24 tools, hedge 80ms via background
      return _bg({type:"call_batch", calls}, {retry:1});
    }
    async function metrics(){ return _bg({type:"metrics"}, {cacheTtl:400}); }
    async function ping(){ return _bg({type:"ping"}, {cacheTtl:0}); }
    function getMetrics(){ return {..._metrics}; }
    function clearCache(){ _cache.clear(); }

    return { status, listTools, callTool, callBatch, metrics, ping, getMetrics, clearCache, version:"3.2.0 ULTRA" };
  })();
  try{ window.ZS_Transport=ZS_Transport; }catch{}
  if(typeof self!=='undefined') try{ self.ZS_Transport=ZS_Transport; }catch{}
})();
