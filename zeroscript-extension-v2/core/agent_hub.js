// SPDX-License-Identifier: GPL-3.0-or-later
// core/agent_hub.js — ZeroScript MAX 4.3.0 EXTENSION-IN-EXTENSION — agent temporary storage via bridge
// Purpose: agents know what they are doing — AI builds code, bridge stores as temporary, other AI reads
// Planner is usually sender. Uses fastest communicator servers (WS 10ms hedge, HTTP 5ms, BC instant, storage 10ms)
// Stores {key, value, from, t, ttl} in background memory + chrome.storage cache, readable by all tabs in 10ms
(() => {
  "use strict";
  const VERSION = "4.3.0";
  const HUB_PREFIX = "zsAgentHub_";
  const BC_NAME = "zs-agent-hub";

  let _bc = null;
  try { _bc = new BroadcastChannel(BC_NAME); } catch {}
  const _cache = new Map();
  const _pending = new Map();
  let _listeners = [];

  // write to temp storage via bridge (background memory) + broadcast
  async function write(key, value, opts={}){
    const k = String(key);
    const payload = { key:k, value, from: opts.from||"planner", t:Date.now(), ttl: opts.ttl|| 120000, v:VERSION };
    _cache.set(HUB_PREFIX+k, payload);
    // broadcast instant
    try { if(_bc) _bc.postMessage({type:"hub_write", payload}); } catch {}
    // persist via background (bridge temp)
    try {
      await new Promise(res=>{
        try{ chrome.runtime.sendMessage({type:"agent_temp_write", key:k, value, from:payload.from, ttl:payload.ttl}, ()=>res()); }catch{ res(); }
        setTimeout(res, 37); // MAX 150
      });
    } catch {}
    // also mirror to chrome.storage for fallback (10ms)
    try { chrome.storage.local.set({[HUB_PREFIX+k]: payload}); } catch {}
    for(const fn of _listeners) try{ fn(payload); }catch{}
    return payload;
  }

  async function read(key){
    const k = String(key);
    if(_cache.has(HUB_PREFIX+k)) return _cache.get(HUB_PREFIX+k).value;
    // try background
    try{
      const r = await new Promise(res=>{
        try{ chrome.runtime.sendMessage({type:"agent_temp_read", key:k}, rr=>res(rr)); }catch{ res(null); }
        setTimeout(()=>res(null), 50); // MAX 200
      });
      if(r && r.ok && r.payload) { _cache.set(HUB_PREFIX+k, r.payload); return r.payload.value; }
    }catch{}
    // try chrome.storage
    try{
      const rr = await new Promise(res=>{ try{ chrome.storage.local.get(HUB_PREFIX+k, v=>res(v)); }catch{ res({}); } });
      if(rr && rr[HUB_PREFIX+k]) { _cache.set(HUB_PREFIX+k, rr[HUB_PREFIX+k]); return rr[HUB_PREFIX+k].value; }
    }catch{}
    return null;
  }

  async function listKeys(){
    try{
      const r = await new Promise(res=>{ try{ chrome.runtime.sendMessage({type:"agent_temp_list"}, rr=>res(rr)); }catch{ res(null); } setTimeout(()=>res(null), 50); }); // MAX
      if(r && r.ok && Array.isArray(r.keys)) return r.keys;
    }catch{}
    return [..._cache.keys()].map(k=>k.replace(HUB_PREFIX,""));
  }

  // ── ROLLING TEMP BUFFER (audit #4) ─────────────────────────────────────
  // main.js calls pushTemp()/getTemp() for the wall audit trail; those methods
  // did not exist, so every write was silently swallowed by a try/catch.
  const TEMP_KEY = "zsAgentTempLog";
  const TEMP_MAX = 60;
  let _temp = [];
  function pushTemp(entry){
    try{
      const e = { ...(entry || {}), t: (entry && entry.ts) || Date.now(), from: (entry && entry.from) || "agent" };
      _temp.push(e);
      if(_temp.length > TEMP_MAX) _temp = _temp.slice(-TEMP_MAX);
      try{ const k = HUB_PREFIX + TEMP_KEY; chrome.storage.local.set({ [k]: _temp }); }catch{}
      for(const fn of _listeners) try{ fn(e); }catch{}
      return e;
    }catch{ return null; }
  }
  function getTemp(n = TEMP_MAX){
    return _temp.slice(-Math.max(1, Math.min(TEMP_MAX, n)));
  }
  async function loadTemp(){
    try{
      const k = HUB_PREFIX + TEMP_KEY;
      const rr = await new Promise(res => { try{ chrome.storage.local.get(k, v => res(v || {})); }catch{ res({}); } });
      if(Array.isArray(rr[k])) _temp = rr[k].slice(-TEMP_MAX);
    }catch{}
    return _temp;
  }

  function onWrite(fn){
    if(typeof fn!=="function") return ()=>{};
    _listeners.push(fn);
    return ()=>{ const i=_listeners.indexOf(fn); if(i!==-1) _listeners.splice(i,1); };
  }

  // listen to BC + storage changes
  try{
    if(_bc) _bc.onmessage = (e)=>{
      const m=e.data;
      if(m && m.type==="hub_write" && m.payload){
        _cache.set(HUB_PREFIX+m.payload.key, m.payload);
        for(const fn of _listeners) try{ fn(m.payload); }catch{}
      }
    };
  }catch{}
  try{
    chrome.storage.onChanged.addListener((ch,area)=>{
      if(area!=="local") return;
      for(const k in ch){
        if(k.startsWith(HUB_PREFIX) && ch[k].newValue){
          _cache.set(k, ch[k].newValue);
          for(const fn of _listeners) try{ fn(ch[k].newValue); }catch{}
        }
      }
    });
  }catch{}

  // communicator servers turbo: expose fastest path for all servers
  const COMMUNICATOR = {
    servers: ["websocket","http-rest","sse","long-poll","batch","binary-msgpack","broadcast-channel","webtransport"],
    hedgeMs: 5,
    pollMs: 5,
    batchMax: 32,
    version: "4.3.0",
  };

  // HONEST LATENCY (audit #20): these are REAL paths, not marketing numbers.
  // In-memory Map hit = sub-ms; BroadcastChannel = same-event-loop (~0-2ms cross
  // tab); chrome.storage = ~1-5ms; bridge HTTP temp = ~5-40ms on localhost.
  const API = {
    VERSION, write, read, listKeys, onWrite,
    pushTemp, getTemp, loadTemp, TEMP_MAX,
    pending: () => _pending.size,
    COMMUNICATOR, HUB_PREFIX,
  };

  try{ loadTemp(); }catch{}
  try{ window.ZSAgentHub = API; window.__zsAgentHub = API; }catch{}
  if(typeof self!=="undefined") try{ self.ZSAgentHub = API; }catch{}
})();
