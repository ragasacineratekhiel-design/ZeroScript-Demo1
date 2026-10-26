// SPDX-License-Identifier: GPL-3.0-or-later
// core/transport.js — ZeroScript MAX transport abstraction v3.0.0
// Content-script thin client to background.js (service worker) with MAX features:
// coalescing, cache, retry, metrics, batch, webtransport hedge.
// All GUIs/colors untouched — pure logic MAX.
// All GUIs/colors untouched — this is pure logic.
(() => {
  "use strict";
  const ZS_Transport = (() => {
    const CACHE_MS = 600; // MAX 600ms — tighter for instant Studio attach
    const _cache = new Map();
    const _inflight = new Map();

    function _key(m){ try{ return JSON.stringify(m); }catch{ return String(m.type); } }
    function _getCache(k){ const e=_cache.get(k); if(!e) return null; if(Date.now()>e.exp){ _cache.delete(k); return null;} return e.v; }
    function _setCache(k,v,ttl=CACHE_MS){ _cache.set(k,{v,exp:Date.now()+ttl}); if(_cache.size>64){ const f=_cache.keys().next().value; _cache.delete(f);} }

    async function _bg(msg, {cacheTtl=0, retry=2}={}){ // MAX retry 2 (was 1) — never lose
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
          // MAX backoff: 80ms * attempt
          if(attempt<retry) await new Promise(r=>setTimeout(r, 80* (attempt+1)));
          else return r;
        }
      })();
      _inflight.set(k,p);
      p.finally(()=> _inflight.delete(k));
      return p;
    }

    async function status(){ return _bg({type:"status"}, {cacheTtl:120}); } // MAX 120ms
    async function listTools(force=false){ return _bg({type:"list_tools", force}, {cacheTtl: force?0:400}); } // MAX 400ms
    async function callTool(name, args, timeout=120000){
      return _bg({type:"call_tool", name, arguments:args, timeout}, {retry:2});
    }
    async function callBatch(calls){
      if(!calls || !calls.length) return {ok:false, error:"no calls"};
      if(calls.length===1) return callTool(calls[0].name, calls[0].arguments, calls[0].timeout);
      // MAX batch: 24 tools, hedge 120ms
      return _bg({type:"call_batch", calls}, {retry:1});
    }
    async function metrics(){ return _bg({type:"metrics"}, {cacheTtl:600}); }
    async function ping(){ return _bg({type:"ping"}, {cacheTtl:0}); }

    return { status, listTools, callTool, callBatch, metrics, ping };
  })();
  try{ window.ZS_Transport=ZS_Transport; }catch{}
  if(typeof self!=='undefined') try{ self.ZS_Transport=ZS_Transport; }catch{}
})();
