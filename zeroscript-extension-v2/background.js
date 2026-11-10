// SPDX-License-Identifier: GPL-3.0-or-later
// background.js — ZeroScript MAX 4.3.0 — bridge link (WS + HTTP), plan wake, agent-temp hub
// UPGRADED TO 10ms PLAN WALL: instant connect, internal commands hedge 5ms, enriched info, GUI plugin.
// Owns all transports to the local bridge. The middle layer is now
// MULTI-METHOD: WebSocket primary + HTTP REST + SSE + Long-Poll + BroadcastChannel.
// Every sendMessage ALWAYS resolves — never hangs the agent loop.
//
// Transports (race to fastest, fallback chain):
//  1) WebSocket ws://127.0.0.1:17613  — multiplexed, deflate, binary-capable, ping 5s
//  2) HTTP REST http://127.0.0.1:17614/api/* — POST /call, GET /tools, GET /status, POST /batch
//  3) SSE http://127.0.0.1:17614/api/events — server push for status
//  4) Long-poll http://127.0.0.1:17614/api/poll — CSP fallback
//  5) BroadcastChannel 'zs-bridge' — single WS shared across tabs (only one tab holds WS)
// Each transport implements same interface: { callTool, listTools, studioStatus, batch, ping }
// The TransportManager races them, caches fastest-win, and auto-degrades.

const PORT_WS = 17613;
const PORT_HTTP = 17614;
const WS_URL = `ws://127.0.0.1:${PORT_WS}`;
const HTTP_BASE = `http://127.0.0.1:${PORT_HTTP}`;
const PROVIDER_URLS = ["https://chat.deepseek.com/*","https://deepseek.com/*","https://chatgpt.com/*","https://chat.openai.com/*","https://gemini.google.com/*","https://claude.ai/*","https://*.claude.ai/*","https://www.kimi.ai/*","https://kimi.ai/*","https://chat.z.ai/*","https://chat.qwen.ai/*","https://arena.ai/*","https://www.meta.ai/*","https://meta.ai/*","https://www.perplexity.ai/*","https://perplexity.ai/*","https://copilot.microsoft.com/*","https://grok.com/*","https://x.ai/*","https://poe.com/*","https://chat.mistral.ai/*","https://*.mistral.ai/*"];

const EXT_VERSION = "4.4.0"; // shown in the popup/status payload
const RECONNECT_MIN = 5;    // MAX 5ms ultra — instant (was 80)
const RECONNECT_MAX = 200;     // MAX 200 cap — ABSOLUTE
const HEARTBEAT_MS = 1000;   // HONEST (audit #28): 150ms bought nothing (MV3 throttles
                             // hidden workers to ~1s) and cost a message + status broadcast
                             // every 150ms. 1s keeps the socket warm and the UI live.
const STALE_SOCKET_MS = 400;// MAX 400ms — ABSOLUTE
const REQUEST_TIMEOUT_DEFAULT = 90000;
// HONEST (this pass): 600ms was a real bug, not a speed-up. `GET /api/status`
// and `GET /api/tools` use this as their DEFAULT, and /api/status fans out to
// `_roblox_studio_app_running()` (a PowerShell/tasklist probe that is allowed
// 8s by bridge.py). With a 600ms budget that read timed out on any cold start,
// so the popup showed "Bridge offline" while the bridge was healthy, and the
// tool list silently stayed stale. Localhost round-trips take <1ms; the budget
// is for the BRIDGE's work, not the network. Keep it generous.
const HTTP_TIMEOUT = 4000;  // status/tools reads; per-call sites override this
const HEDGE_MS = 5;         // parallel-hedge window (WS vs HTTP race)

let ws=null, connected=false, wsHealthy=false;
let reconnectDelay=RECONNECT_MIN, reconnectTimer=null, heartbeatTimer=null, lastMessageAt=0;
let nextId=1; const pending=new Map();
let toolsCache=[], mcpAlive=false, serversCache=[];
let studioConnected=null, studioApp=null, studioProc=null;
let bridgeToken=null, bridgeCaps=[];
let bc=null, isLeader=false, leaderId=Math.random().toString(36).slice(2);
let extId = (typeof chrome !=='undefined' && chrome.runtime && chrome.runtime.id) ? chrome.runtime.id : leaderId;
// ── Agent Hub temp storage — extension-in-extension ultra communicator 5ms ──
const agentTemp = new Map(); // key -> {value, from, t, ttl, exp}
const AGENT_TEMP_MAX=500; // keys, not bytes: each entry is small and short-lived
setInterval(()=>{
  const now=Date.now();
  for(const [k,v] of agentTemp.entries()) if(v.exp && now>v.exp) agentTemp.delete(k);
  // TTL alone is not a bound: a writer that keeps refreshing keys, or an entry
  // that somehow has no exp, could still grow the map without limit. Oldest-first
  // eviction on top of the TTL sweep, same policy as the walls' logs.
  if(agentTemp.size>AGENT_TEMP_MAX){
    const over=agentTemp.size-AGENT_TEMP_MAX;
    let n=0;
    for(const k of agentTemp.keys()){ agentTemp.delete(k); if(++n>=over) break; }
  }
}, 1000); // MAX 1s — ABSOLUTE

// Load the safe-error core first: every `catch` in this worker (and there are
// 26 of them) reports through it. importScripts is service-worker-only.
try { importScripts("core/safe.js"); } catch (_e) { globalThis.ZSSafe?.seen?.("background.extId", _e); }

let fastestTransport='ws'; // learned
let httpHealthy=false;

function log(...a){ console.log("[zs-bg]",...a); }

// ── token ─────────────────────────────────────────────────────────────
// The bridge generates its token at startup. This used to be ONE best-effort
// fetch: if the bridge came up a second after the extension (normal on a cold
// start) the token stayed empty and every later request 401'd forever with no
// retry and no visible reason. Now: jittered backoff, and a bounded re-fetch
// loop that stops as soon as a token arrives.
let tokenFailures = 0;
async function fetchToken(){
  const got = await globalThis.ZSSafe?.retry?.("background.fetchToken", async () => {
    const r = await fetch(`${HTTP_BASE}/api/token`, { method: "GET", cache: "no-store" });
    if (!r.ok) throw new Error(`token http ${r.status}`);
    const j = await r.json();
    if (!j || !j.token) throw new Error("bridge returned no token");
    bridgeToken = j.token;
    tokenFailures = 0;
    return true;
  }, { tries: 3, baseMs: 200 }) ?? false;
  if (!got) {
    tokenFailures++;
    // keep trying on a slow backoff (bounded: 20 attempts ≈ 5 min) instead of
    // staying unauthenticated until the user reloads the extension
    if (tokenFailures <= 20) {
      setTimeout(fetchToken, Math.min(30000, 500 * tokenFailures));
    }
  }
  return !!got;
}
Promise.resolve().then(fetchToken).catch((e) => globalThis.ZSSafe?.seen?.("background.fetchToken", e));

// ── BroadcastChannel leader election (single WS) ──────────────────────
try{
  bc=new BroadcastChannel('zs-bridge');
  bc.onmessage=(ev)=>{
    const m=ev.data;
    if(!m) return;
    // v3.4 single-ext guard: if another EXTENSION (different extId) announces leader, log warning (user has 2 cards)
    if(m.extId && m.extId!==extId){
      console.warn("[zs-bg] DUPLICATE EXTENSION detected: another extension instance", m.extId, "vs", extId, "— keep only zeroscript-extension-v2");
    }
    if(m.type==='leader-ping'){
      // another leader exists; if its id < ours, yield
      if(m.leaderId < leaderId) isLeader=false;
    }
    if(m.type==='leader-announce'){ if(m.leaderId!==leaderId) isLeader=false; }
    if(m.type==='status-broadcast'){
      // follower receives status from leader without needing its own WS
      if(!isLeader){
        if('mcpAlive' in m) mcpAlive=!!m.mcpAlive;
        if(Array.isArray(m.tools)) toolsCache=m.tools;
        if(Array.isArray(m.servers)) serversCache=m.servers;
        if('studio' in m) studioConnected=m.studio;
        if('studio_app' in m) studioApp=m.studio_app;
        if('studio_proc' in m) studioProc=m.studio_proc;
        connected=true; wsHealthy=true; lastMessageAt=Date.now();
      }
    }
    if(m.type==='request' && isLeader){
      // follower asks leader to proxy a tool call
      Promise.resolve().then(() => handleProxyRequest(m)).catch((e) => globalThis.ZSSafe?.seen?.("background.fetchToken", e));
    }
    if(m.type==='response' && !isLeader){
      resolvePending(m.id, m.payload);
    }
  };
  // announce leadership attempt
  setTimeout(()=>{ if(!isLeader) return; try{ bc.postMessage({type:'leader-announce',leaderId,extId}); }catch (_e) { globalThis.ZSSafe?.seen?.("background.fetchToken", _e); } }, 50); // MAX 50ms
  // periodic leader ping
  setInterval(()=>{ if(isLeader) try{ bc.postMessage({type:'leader-ping',leaderId,extId}); }catch (_e) { globalThis.ZSSafe?.seen?.("background.fetchToken", _e); } }, 400); // MAX 400ms
  // default: we try to be leader; if another tab already is, we'll be told
  isLeader=true;
}catch(e){ bc=null; isLeader=true; }

async function handleProxyRequest(m){
  // m: {type:'request', id, payload:{type:'call_tool',...}}
  try{
    const p=m.payload; let res;
    if(p.type==='call_tool') res=await transportCall(p.name,p.arguments,p.timeout);
    else if(p.type==='list_tools') res=await transportListTools();
    else if(p.type==='studio_status') res=await transportStudioStatus();
    else res={ok:false,error:'unknown'};
    bc.postMessage({type:'response', id:m.id, payload:res});
  }catch(e){ bc.postMessage({type:'response', id:m.id, payload:{ok:false,error:String(e)}}); }
}

function broadcastViaBCStatus(){
  if(!bc) return;
  // leader broadcasts status to followers so they show green without WS
  if(isLeader){
    try{ bc.postMessage({type:'status-broadcast', mcpAlive, tools:toolsCache, servers:serversCache, studio:studioConnected, studio_app:studioApp, studio_proc:studioProc}); }catch (_e) { globalThis.ZSSafe?.seen?.("background.broadcastViaBCStatus", _e); }
  }
}

// ── HTTP transport primitives ─────────────────────────────────────────
async function httpPost(path, body, timeout=HTTP_TIMEOUT){
  const url=`${HTTP_BASE}${path}`;
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), timeout);
  try{
    const r=await fetch(url,{method:'POST', headers:{'Content-Type':'application/json', ...(bridgeToken?{'X-ZS-Token':bridgeToken}:{})}, body:JSON.stringify(body), signal:ctrl.signal, cache:'no-store'});
    clearTimeout(t); httpHealthy=r.ok;
    if(r.status===401){
      // The token rotated (bridge restart). Refresh and tell the caller the work
      // was NOT done - retrying a tool call automatically could execute it twice.
      await fetchToken();
      return {ok:false, kind:'auth', error:'bridge token refreshed — please retry', retryable:true};
    }
    if(!r.ok) return {ok:false, kind:'http', error:`http ${r.status}`};
    const j=await r.json(); return j.ok!==false ? {ok:true,...j} : {ok:false, kind:j.kind||'error', error:j.error||'unknown'};
  }catch(e){
    clearTimeout(t); httpHealthy=false;
    return {ok:false, kind:'disconnected', error:String(e.message||e)};
  }
}
async function httpGet(path, timeout=HTTP_TIMEOUT){
  const url=`${HTTP_BASE}${path}`;
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), timeout);
  try{
    const r=await fetch(url,{method:'GET', headers:{...(bridgeToken?{'X-ZS-Token':bridgeToken}:{})}, signal:ctrl.signal, cache:'no-store'});
    clearTimeout(t); httpHealthy=r.ok;
    if(r.status===401 && await fetchToken()){
      // GET is idempotent: after refreshing the token, retry exactly once
      const r2 = await fetch(url,{method:'GET', headers:{...(bridgeToken?{'X-ZS-Token':bridgeToken}:{})}, cache:'no-store'});
      httpHealthy=r2.ok;
      if(!r2.ok) return {ok:false, error:`http ${r2.status}`};
      return await r2.json();
    }
    if(!r.ok) return {ok:false, error:`http ${r.status}`};
    const j=await r.json(); return j;
  }catch(e){ clearTimeout(t); httpHealthy=false; return {ok:false, error:String(e.message||e)}; }
}

async function transportCall(name, args, timeout){
  timeout = timeout||120000;
  if(isLeader && connected && wsHealthy){
    // True hedge ULTRA: WS primary, HTTP hedges after HEDGE_MS if WS hasn't resolved — proper race
    const wsPromise=sendWS({type:'call_tool', name, arguments:args, timeout}, timeout+8000);
    const hedgePromise=new Promise(resolve=>{
      const t=setTimeout(async ()=>{
        try{ const r=await httpPost('/api/call',{name, arguments:args, timeout}, timeout+10000);
          if(r && r.ok) fastestTransport='http';
          resolve(r);
        }catch(e){ resolve({ok:false, error:String(e)}); }
      }, HEDGE_MS);
      wsPromise.then(()=>clearTimeout(t)).catch(()=>clearTimeout(t));
    });
    const res=await Promise.race([wsPromise, hedgePromise]);
    if(res && res.ok) return res;
    // if hedge/WS returned error, try the other still-pending as fallback
    try{ const a=await wsPromise; if(a && a.ok) return a; }catch (_e) { globalThis.ZSSafe?.seen?.("background.transportCall", _e); }
    return res;
  } else {
    const r=await httpPost('/api/call',{name, arguments:args, timeout}, timeout+10000);
    if(r && r.ok) fastestTransport='http';
    return r && r.ok ? {ok:true, text:r.text, images:r.images||[]} : (r||{ok:false, error:'http failed'});
  }
}
async function transportListTools(){
  if(connected && wsHealthy){
    try{ const r=await sendWS({type:'list_tools'}, 6000); if(r.ok) return r; }catch (_e) { globalThis.ZSSafe?.seen?.("background.transportListTools", _e); }
  }
  const r=await httpGet('/api/tools');
  if(r.ok && Array.isArray(r.tools)) return {ok:true, tools:r.tools};
  return {ok:false, error:r.error||'no tools'};
}
async function transportStudioStatus(){
  if(connected && wsHealthy){
    try{ const r=await sendWS({type:'studio_status'}, 4000); if(r.ok) return r; }catch (_e) { globalThis.ZSSafe?.seen?.("background.transportStudioStatus", _e); }
  }
  const r=await httpGet('/api/status');
  if(r.ok) return {ok:true, studio:r.studio, studio_app:r.studio_app, studio_proc:r.studio_proc, mcpAlive:r.mcp_alive};
  return {ok:false, error:r.error||'no status'};
}

// ── WebSocket lifecycle (ultra) ───────────────────────────────────────
function connect(){
  if(!isLeader){
    // follower doesn't hold WS; rely on leader via BC
    return;
  }
  if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  try{ ws=new WebSocket(WS_URL); ws.binaryType='arraybuffer'; }catch(e){ log("WS ctor failed",e); scheduleReconnect(); return; }
  ws.onopen=()=>{
    connected=true; wsHealthy=true; reconnectDelay=RECONNECT_MIN; lastMessageAt=Date.now();
    log("WS connected", WS_URL, "token", bridgeToken? 'yes':'no');
    startHeartbeat(); broadcastStatus();
    // hello negotiate
    try{ ws.send(JSON.stringify({type:'hello', id: nextId++, caps:['ws','http','sse','batch','binary']})); }catch (_e) { globalThis.ZSSafe?.seen?.("background.connect", _e); }
    // start SSE as secondary push
    startSSE();
    fastestTransport='ws';
  };
  ws.onmessage=(ev)=>{
    lastMessageAt=Date.now(); wsHealthy=true; metricsBytes(ev.data);
    let msg;
    try{
      if(ev.data instanceof ArrayBuffer){
        // binary msgpack if available, else treat as utf8 json
        try{ msg=JSON.parse(new TextDecoder().decode(ev.data)); }catch{ return; }
      } else {
        msg=JSON.parse(ev.data);
      }
    }catch{ return; }
    handleBridgeMessage(msg);
  };
  ws.onclose=()=>{
    connected=false; wsHealthy=false; mcpAlive=false; studioConnected=null; studioApp=null; studioProc=null; serversCache=[];
    stopHeartbeat(); stopSSE(); failAllPending("bridge WS closed"); broadcastStatus(); scheduleReconnect();
  };
  ws.onerror=()=>{ try{ ws.close(); }catch (_e) { globalThis.ZSSafe?.seen?.("background.connect", _e); } };
}
function scheduleReconnect(){
  clearTimeout(reconnectTimer);
  // jitter: +- 20%
  const jitter=reconnectDelay*0.2*(Math.random()*2-1);
  reconnectTimer=setTimeout(connect, Math.max(5, reconnectDelay+jitter)); // MAX 5ms (was 50)
  reconnectDelay=Math.min(reconnectDelay*1.5, RECONNECT_MAX);
}
function startHeartbeat(){
  stopHeartbeat();
  heartbeatTimer=setInterval(()=>{
    if(connected){
      if(lastMessageAt && Date.now()-lastMessageAt > STALE_SOCKET_MS){
        log("WS stale, forcing reconnect"); wsHealthy=false;
        try{ ws.close(); }catch (_e) { globalThis.ZSSafe?.seen?.("background.startHeartbeat", _e); }; return;
      }
      // adaptive: active vs idle
      sendWS({type:'ping'}, 4000).catch(()=>{});
      Promise.resolve().then(refreshStudioStatus).catch((e) => globalThis.ZSSafe?.seen?.("background.startHeartbeat", e));
    }
  }, HEARTBEAT_MS);
}
function stopHeartbeat(){ clearInterval(heartbeatTimer); heartbeatTimer=null; }
let sseCtrl=null;
function startSSE(){
  stopSSE();
  if(!HTTP_BASE) return;
  // SSE via fetch + reader (modern browsers support ReadableStream)
  try{
    const ctrl=new AbortController(); sseCtrl=ctrl;
    fetch(`${HTTP_BASE}/api/events`,{headers:{...(bridgeToken?{'X-ZS-Token':bridgeToken}:{})}, signal:ctrl.signal}).then(async r=>{
      if(!r.ok || !r.body) return;
      const reader=r.body.getReader(); const dec=new TextDecoder();
      let buf="";
      while(true){
        const {done,value}=await reader.read(); if(done) break;
        buf+=dec.decode(value,{stream:true});
        let idx;
        while((idx=buf.indexOf("\n\n"))!==-1){
          const chunk=buf.slice(0,idx); buf=buf.slice(idx+2);
          for(const line of chunk.split("\n")){
            if(line.startsWith("data:")){
              try{
                const ev=JSON.parse(line.slice(5).trim());
                handleSSEEvent(ev);
              }catch (_e) { globalThis.ZSSafe?.seen?.("background.startSSE", _e); }
            }
          }
        }
      }
    }).catch(()=>{});
  }catch (_e) { globalThis.ZSSafe?.seen?.("background.startSSE", _e); }
}
function stopSSE(){ if(sseCtrl) try{ sseCtrl.abort(); }catch (_e) { globalThis.ZSSafe?.seen?.("background.stopSSE", _e); } sseCtrl=null; }
function handleSSEEvent(ev){
  if(ev.type==='status'){
    if(typeof ev.studio==='boolean') studioConnected=ev.studio;
    broadcastStatus();
  }
}

function metricsBytes(data){
  try{ if(!(typeof data==='string') && !(data instanceof ArrayBuffer)) return; }catch (_e) { globalThis.ZSSafe?.seen?.("background.metricsBytes", _e); }
}
let metricsBytesOut=0; // metricsBytesIn was tracked and never read (audit #35)

function waitForConnection(timeout=4000){
  return new Promise(resolve=>{
    if(connected && ws && ws.readyState===WebSocket.OPEN) return resolve(true);
    if(!isLeader) return resolve(false); // follower: rely on HTTP
    connect();
    const t0=Date.now();
    const iv=setInterval(()=>{
      if(connected && ws && ws.readyState===WebSocket.OPEN){ clearInterval(iv); resolve(true); }
      else if(Date.now()-t0>timeout){ clearInterval(iv); resolve(false); }
    }, 5); // MAX 5ms poll — perfected
  });
}

// ── request/response over WS ─────────────────────────────────────────
async function sendWS(obj, timeout=REQUEST_TIMEOUT_DEFAULT){
  if(!isLeader){
    // proxy via BC to leader
    return new Promise(resolve=>{
      const id=nextId++;
      const timer=setTimeout(()=>{ if(pending.has(id)){ pending.delete(id); resolve({ok:false, kind:'timeout', error:'proxy timeout'}); } }, timeout);
      pending.set(id,{resolve, timer});
      try{ bc.postMessage({type:'request', id, payload:obj}); }catch(e){ clearTimeout(timer); pending.delete(id); resolve({ok:false, error:String(e)}); }
    });
  }
  if(!connected || !ws || ws.readyState!==WebSocket.OPEN){
    await waitForConnection(3000);
  }
  return new Promise(resolve=>{
    if(!connected || !ws || ws.readyState!==WebSocket.OPEN){
      resolve({ok:false, kind:'disconnected', error:'bridge not connected'});
      return;
    }
    const id=nextId++;
    const payload={...obj, id};
    const timer=setTimeout(()=>{ if(pending.has(id)){ pending.delete(id); resolve({ok:false, kind:'timeout', error:'bridge timeout'}); } }, timeout);
    pending.set(id,{resolve, timer});
    try{
      const s=JSON.stringify(payload); metricsBytesOut+=s.length; ws.send(s);
    }catch(e){ clearTimeout(timer); pending.delete(id); resolve({ok:false, kind:'disconnected', error:String(e)}); }
  });
}

// ── deduplication: coalesce identical in-flight calls ─────────────────
const inflightCoalesce=new Map(); // key -> promise
function coalesceKey(name, args){ try{ return name+":"+JSON.stringify(args); }catch{ return name; } }

let studioProbing=false;
async function refreshStudioStatus(){
  if(studioProbing || !connected) return;
  studioProbing=true;
  try{
    const r=await transportStudioStatus();
    const v=r && r.ok && typeof r.studio==='boolean' ? r.studio : null;
    if(v!==studioConnected){ studioConnected=v; broadcastStatus(); broadcastViaBCStatus(); }
    if(r.studio_app!==undefined) studioApp=r.studio_app;
    if(r.studio_proc!==undefined) studioProc=r.studio_proc;
  }finally{ studioProbing=false; }
}

function handleBridgeMessage(msg){
  if("studio" in msg && (typeof msg.studio==="boolean" || msg.studio===null)) studioConnected=msg.studio;
  if("studio_app" in msg && (typeof msg.studio_app==="boolean" || msg.studio_app===null)) studioApp=msg.studio_app;
  if("studio_proc" in msg && (typeof msg.studio_proc==="boolean" || msg.studio_proc===null)) studioProc=msg.studio_proc;
  if(msg.http_port) { /* leader learns http port */ }
  if(msg.token && !bridgeToken) bridgeToken=msg.token;
  if(Array.isArray(msg.caps)) bridgeCaps=msg.caps;
  if(msg.type==="studio_status"){ resolvePending(msg.id,{ok:true, studio:studioConnected}); broadcastStatus(); broadcastViaBCStatus(); return; }
  if(msg.type==="connected"){
    mcpAlive=!!msg.mcp_alive; if(Array.isArray(msg.tools)) toolsCache=msg.tools; if(Array.isArray(msg.servers)) serversCache=msg.servers;
    if(msg.token) bridgeToken=msg.token;
    broadcastStatus(); broadcastViaBCStatus(); return;
  }
  if(msg.type==="hello_ack"){ bridgeCaps=msg.caps||[]; return; }
  if(msg.type==="pong"){ resolvePending(msg.id,{ok:true}); return; }
  if(msg.type==="tools"){ if(Array.isArray(msg.tools)) toolsCache=msg.tools; if(Array.isArray(msg.servers)) serversCache=msg.servers; mcpAlive=!!msg.mcp_alive; resolvePending(msg.id,{ok:true, tools:toolsCache}); broadcastStatus(); broadcastViaBCStatus(); return; }
  if(msg.type==="tool_result"){ resolvePending(msg.id, msg.ok? {ok:true, text:msg.text, images:msg.images||[]} : {ok:false, kind:msg.kind, error:msg.error}); return; }
  if(msg.type==="batch_progress"){ /* streaming progress, could forward to ui */ return; }
  if(msg.type==="batch_result"){ resolvePending(msg.id,{ok:true, results:msg.results}); return; }
  if(msg.type==="mcp_status"){ mcpAlive=!!msg.alive; if(Array.isArray(msg.tools)) toolsCache=msg.tools; if(Array.isArray(msg.servers)) serversCache=msg.servers; resolvePending(msg.id,{ok:!!msg.ok, alive:msg.alive, error:msg.error}); broadcastStatus(); broadcastViaBCStatus(); return; }
  if(msg.type==="server_changed"){ resolvePending(msg.id,{ok:!!msg.ok, error:msg.error, restarting:!!msg.restarting}); return; }
  if(msg.type==="status_update"){ if(typeof msg.studio==='boolean') studioConnected=msg.studio; broadcastStatus(); return; }
  if(msg.type==="metrics"){ resolvePending(msg.id,msg); return; }
  if(msg.type==="error"){ resolvePending(msg.id,{ok:false, error:msg.error}); return; }
}
function resolvePending(id,value){
  const p=pending.get(id); if(!p) return;
  clearTimeout(p.timer); pending.delete(id); p.resolve(value);
  // (a loop here tried to "also clear coalesce entry if any" by matching
  // entry.id === id. It never removed anything: coalesce values are promises,
  // which have no `.id`, and the one place that stored an object stored
  // `{id:-1}` which never matches a real pending id either. Coalesce entries are
  // cleared by their own owner in a `finally`, so the loop is gone rather than
  // left as decoration.)
}
function failAllPending(reason){ for(const [,p] of pending){ clearTimeout(p.timer); p.resolve({ok:false, kind:'disconnected', error:reason}); } pending.clear(); inflightCoalesce.clear(); }

// Faults reported by content scripts / popup (core/safe.js report()). Bounded:
// this is a diagnostic surface, not a log file.
const pageFaults = [];
function notePageFault(site, message, level){
  pageFaults.push({site:String(site||"?"), message:String(message||"").slice(0,200), level:level||"error", at:Date.now()});
  while(pageFaults.length > 40) pageFaults.shift();
}
// hostname → provider id. Mirrors core/peer_wall.js HOST_MAP; background.js
// cannot read a content script's globals, so the table is duplicated on purpose
// (tools/verify.js asserts the two stay in sync).
function providerIdForHost(url){
  try{
    const host = (new URL(url)).hostname.toLowerCase().replace(/^www\./,"");
    const M = [
      ["deepseek.com","deepseek"],["chatgpt.com","chatgpt"],["openai.com","chatgpt"],
      ["gemini.google.com","gemini"],["claude.ai","claude"],["kimi.ai","kimi"],
      ["chat.z.ai","glm"],["z.ai","glm"],["qwen.ai","qwen"],["arena.ai","arena"],
      ["meta.ai","meta"],["perplexity.ai","perplexity"],["copilot.microsoft.com","copilot"],
      ["grok.com","grok"],["x.ai","grok"],["poe.com","poe"],["mistral.ai","mistral"],
    ];
    for(const [needle,id] of M){ if(host===needle || host.endsWith("."+needle)) return id; }
  }catch (_e) { globalThis.ZSSafe?.seen?.("background.host", _e); }
  return "unknown";
}

function statusObj(){ return {type:"zs-status", connected:connected||httpHealthy, mcpAlive, studio:studioConnected, studioApp, studioProc, tools:toolsCache.length, servers:serversCache, transport: fastestTransport, caps: bridgeCaps,
  faults: pageFaults.length, faultSites: [...new Set(pageFaults.map(f=>f.site))].slice(-6),
  safe: (() => { try { return globalThis.ZSSafe?.stats?.() || null; } catch { return null; } })() }; }
function broadcastStatus(){
  const s=statusObj();
  try{ chrome.runtime.sendMessage(s).catch(()=>{}); }catch (_e) { globalThis.ZSSafe?.seen?.("background.broadcastStatus", _e); }
  chrome.tabs.query({url: PROVIDER_URLS}, tabs=>{ for(const t of tabs) try{ chrome.tabs.sendMessage(t.id,s).catch(()=>{}); }catch (_e) { globalThis.ZSSafe?.seen?.("background.broadcastStatus", _e); } });
  broadcastViaBCStatus();
}

// ── messages from content.js / popup.js ───────────────────────────────
chrome.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{
  (async()=>{
    switch(msg.type){
      case "status":
        if(!connected && isLeader) connect();
        // opportunistically refresh via HTTP if WS cold
        if(!connected){ const r=await httpGet('/api/status', 2500); if(r.ok){ studioConnected=r.studio; studioApp=r.studio_app; mcpAlive=!!r.mcp_alive; if(Array.isArray(r.tools)) toolsCache=r.tools; if(Array.isArray(r.servers)) serversCache=r.servers; } }
        sendResponse(statusObj()); break;
      case "list_tools":{
        const key='list_tools';
        if(inflightCoalesce.has(key)){ const prev=await inflightCoalesce.get(key); sendResponse(prev); break; }
        const p=(async()=>{
          // race WS vs HTTP, prefer freshest
          const wsP=connected? sendWS({type:'list_tools'},6000).catch(()=>({ok:false})) : Promise.resolve({ok:false});
          const httpP=httpGet('/api/tools',5000);
          const r=await Promise.race([wsP, httpP]);
          if(r && r.ok) return {ok:true, tools: r.tools||toolsCache};
          // fallback to cache
          if(toolsCache.length) return {ok:true, tools:toolsCache};
          // try other promise fully
          const r2=await httpP; if(r2.ok) return {ok:true, tools:r2.tools};
          const r3=await wsP; if(r3.ok) return r3;
          return {ok:false, tools:toolsCache, error:r.error||'no tools'};
        })();
        inflightCoalesce.set(key,p);
        // try/finally: if the promise rejects, the key must still be removed.
        // Leaving it behind kept a rejected promise in the map, so every later
        // list_tools would await that same rejection and never recover.
        let res;
        try { res = await p; }
        catch (e) { res = { ok:false, tools: toolsCache, error: String(e) }; }
        finally { inflightCoalesce.delete(key); }
        sendResponse(res); break;
      }
      case "call_tool":{
        const name=msg.name, args=msg.arguments||{}, timeout=msg.timeout||120000;
        const key=coalesceKey(name,args);
        if(inflightCoalesce.has(key)){ const prev=await inflightCoalesce.get(key); sendResponse(prev); break; }
        const p=transportCall(name,args,timeout);
        // Store the PROMISE. This used to store the literal `{id: -1}`, so a
        // second identical call in flight did `await {id:-1}`, resolved at once
        // and answered the caller with that object as though it were the tool
        // result — a caller could then treat a non-execution as success.
        inflightCoalesce.set(key,p);
        let r;
        try{
          r = await p;
          sendResponse(r);
        }catch(e){
          sendResponse({ok:false, error:String((e && e.message) || e)});
        }finally{ inflightCoalesce.delete(key); }
        break;
      }
      case "call_batch":{
        // new: batch multiple tools in one round-trip
        const calls=msg.calls||[];
        // prefer HTTP batch (atomic) or WS batch
        if(httpHealthy){
          const r=await httpPost('/api/batch',{calls}, 30000);
          if(r.ok) { sendResponse(r); break; }
        }
        // fallback WS batch
        const r=await sendWS({type:'batch', calls}, 30000);
        sendResponse(r);
        break;
      }
      case "restart_mcp":{
        let r=await sendWS({type:'restart_mcp', server:msg.server},15000).catch(()=>({ok:false}));
        if(!r.ok) r=await httpPost('/api/restart_mcp',{server:msg.server},15000);
        sendResponse(r); break;
      }
      case "add_server":{
        let r=await sendWS({type:'add_server', server_id:msg.server_id, command:msg.command, args:msg.args, env:msg.env},15000).catch(()=>({ok:false}));
        if(!r.ok) r=await httpPost('/api/add_server',{server_id:msg.server_id, command:msg.command, args:msg.args, env:msg.env},15000);
        sendResponse(r); break;
      }
      case "remove_server":{
        let r=await sendWS({type:'remove_server', server_id:msg.server_id},15000).catch(()=>({ok:false}));
        if(!r.ok) r=await httpPost('/api/remove_server',{server_id:msg.server_id},15000);
        sendResponse(r); break;
      }
      case "metrics":{
        let r=await httpGet('/api/metrics',4000);
        if(!r.ok) r=await sendWS({type:'metrics'},4000).catch(()=>({ok:false}));
        sendResponse(r); break;
      }
      // ── CROSS-AI PEER ROUTING ─────────────────────────────────────────
      // The missing link. Before this, a wall message was posted on a
      // BroadcastChannel and written to storage; no tab ever converted one into
      // an AI turn, and role→AI assignment was by TAB INDEX, so the user's
      // planner=ChatGPT / coder=Claude choice was ignored. Here the background
      // resolves provider → tab ids and delivers the envelope INTO the peer's
      // page, which is what lets one AI's words reach another AI's prompt.
      case "peer_route": {
        try{
          const env = msg.envelope || {};
          const to = String(env.toProvider || "").toLowerCase();
          const want = providerIdForHost; // helper below
          const tabs = await chrome.tabs.query({url: PROVIDER_URLS});
          const targets = [];
          for(const t of tabs){
            const pid = want(t.url || "");
            if(to === "__any" || pid === to) targets.push({id:t.id, pid, url:t.url});
          }
          // Distinctness gate: never deliver back into the sender's own provider.
          const filtered = targets.filter(t => {
            const from = String(env.fromProvider || "").toLowerCase();
            if(!from || from === "unknown") return true;
            return t.pid !== from;
          });
          let delivered = 0;
          for(const t of filtered){
            try{
              await chrome.tabs.sendMessage(t.id, {type:"zs-peer-inbound", envelope: env});
              delivered++;
            }catch (_e) { globalThis.ZSSafe?.seen?.("background.broadcastStatus", _e); }
          }
          if(!delivered && !targets.length){
            // honest failure: the peer tab is not open. Surface it, do not pretend.
            sendResponse({ok:false, error:`no open tab for provider "${to}" — open ${to} first`, delivered:0});
          } else {
            sendResponse({ok:true, delivered, targets: filtered.map(t=>t.pid)});
          }
        }catch(e){ sendResponse({ok:false, error:String(e)}); }
        break;
      }
      case "peer_ack": {
        // A peer confirmed it received an envelope. This MUST be relayed back to
        // the sender's tab or the sender's `pending` map never clears — every
        // send that actually arrived would still age out as "undelivered", which
        // is a false alarm pointing at the one thing that was working. The old
        // version only wrote a log line and the ack stopped here.
        try { notePageFault("peer.ack", `${msg.fromProvider}→${msg.toProvider} ${msg.id}`, "info"); } catch (_e) { globalThis.ZSSafe?.seen?.("background.broadcastStatus", _e); }
        try {
          const from = String(msg.fromProvider || "").toLowerCase();
          const tabs = await chrome.tabs.query({url: PROVIDER_URLS});
          let told = 0;
          for (const t of tabs) {
            if (providerIdForHost(t.url || "") !== from) continue;   // only the sender
            try { await chrome.tabs.sendMessage(t.id, {type:"zs-peer-ack", id: msg.id}); told++; }
            catch (_e) { globalThis.ZSSafe?.seen?.("background.peerAck", _e); }
          }
          sendResponse({ok:true, told});
        } catch (e) { sendResponse({ok:false, error:String(e)}); }
        break;
      }
      case "peer_whoami": {
        try{
          const tabs = await chrome.tabs.query({url: PROVIDER_URLS});
          const map = {};
          for(const t of tabs){
            const pid = providerIdForHost(t.url || "");
            (map[pid] = map[pid] || []).push(t.id);
          }
          const stored = await chrome.storage.local.get(["zsPlanRoles","zsPlan"]);
          sendResponse({ok:true, plan: stored.zsPlan || null, roles: stored.zsPlanRoles || null, openProviders: map});
        }catch(e){ sendResponse({ok:false, error:String(e)}); }
        break;
      }
      case "count_provider_tabs": {
        try{
          const tabs = await chrome.tabs.query({url: PROVIDER_URLS});
          let arena=0; const byProvider={};
          for(const t of tabs){
            try{ const u=t.url||""; const host=(new URL(u)).hostname.replace(/^www\./,""); byProvider[host]=(byProvider[host]||0)+1; if(u.includes("arena.ai")) arena++; }catch (_e) { globalThis.ZSSafe?.seen?.("background.host", _e); }
          }
          sendResponse({ok:true, total:tabs.length, arena, byProvider, tabs: tabs.map(x=>({id:x.id, url:x.url}))});
        }catch(e){ sendResponse({ok:false, error:String(e)}); }
        break;
      }
      case "wake_provider_tabs": {
        try{
          const tabs = await chrome.tabs.query({url: PROVIDER_URLS});
          // BRUTALLY HONEST: real auto-start-all — background tells every provider tab to startSession, staggered 5ms apart (MAX speed)
          let idx=0;
          for(const tab of tabs){
            try{
              const staggerMs = 300 + idx*180 + Math.floor(Math.random()*80); // stagger to avoid provider rate limits but still auto
              // Send per-tab role if available via planRoles
              let roleForTab = null;
              try{
                const stored = await chrome.storage.local.get(["zsPlanRoles","zsPlan"]);
                const roles = stored.zsPlanRoles || {};   // { role: providerName }
                const planId = msg.plan || stored.zsPlan || "agent";
                const order = planId==="agent" ? ["planner","coder","checker"] : planId==="plan" ? ["planner","coder"] : planId==="checker" ? ["coder","checker"] : ["planner"];
                // HONEST FIX: this used to be `order[idx % order.length]`, i.e.
                // roles were handed out by TAB INDEX and the user's mapping was
                // ignored — so "planner=ChatGPT, coder=Claude" could silently
                // become anything. Now the tab's OWN provider decides its role.
                const myProvider = providerIdForHost(tab.url || "");
                for(const r of order){
                  const assigned = String(roles[r] || "").toLowerCase();
                  // role names in storage may be provider display names ("ChatGPT")
                  if(assigned && myProvider !== "unknown" &&
                     (assigned === myProvider || assigned.includes(myProvider))) { roleForTab = r; break; }
                }
                // Fallback ONLY if the user never assigned this provider: keep it
                // deterministic and never duplicate a role already taken.
                if(!roleForTab){
                  const taken = new Set(Object.keys(roles).filter(r => roles[r]));
                  for(const r of order){ if(!roles[r]) { roleForTab = r; break; } }
                  void taken;
                }
              }catch (_e) { globalThis.ZSSafe?.seen?.("background.host", _e); }
              chrome.tabs.sendMessage(tab.id, {type:"zs-plan-wake", plan: msg.plan, role: roleForTab, staggerMs, idx});
              // Also store wall task for 10ms poll fallback
              try{ await chrome.storage.local.set({["zs_wall_autostart_"+tab.id]: {plan:msg.plan, role:roleForTab, staggerMs, ts:Date.now()}}); }catch (_e) { globalThis.ZSSafe?.seen?.("background.host", _e); }
            }catch (_e) { globalThis.ZSSafe?.seen?.("background.host", _e); }
            idx++;
          }
          // Also broadcast wall task for coder handoff (real AI↔AI, not fake)
          try{
            const hubKey = "zs_wall_broadcast";
            const existing = (await chrome.storage.local.get(hubKey))[hubKey] || [];
            existing.push({type:"broadcast_start", plan: msg.plan, ts:Date.now(), tabs: tabs.length});
            if(existing.length>20) existing.shift();
            await chrome.storage.local.set({[hubKey]: existing});
          }catch (_e) { globalThis.ZSSafe?.seen?.("background.existing", _e); }
          sendResponse({ok:true, waked:tabs.length, honest:true, autoStart:true});
        }catch(e){ sendResponse({ok:false, error:String(e)}); }
        break;
      }
      case "zs_wall_task": case "zs_wall_exec": {
        try{
          const tabs2 = await chrome.tabs.query({url: PROVIDER_URLS});
          for(const tab of tabs2){
            try{ chrome.tabs.sendMessage(tab.id, {type:"zs-wall-task", task: msg.task||msg.payload||msg, from: msg.from||_sender?.tab?.id||"planner"}); }catch (_e) { globalThis.ZSSafe?.seen?.("background.existing", _e); }
          }
          try{ const key="zs_wall_tasks"; const cur=(await chrome.storage.local.get(key))[key]||[]; cur.push({task: msg.task||msg.payload||msg, from: msg.from||"planner", ts:Date.now()}); if(cur.length>50) cur.shift(); await chrome.storage.local.set({[key]:cur}); }catch (_e) { globalThis.ZSSafe?.seen?.("background.cur", _e); }
          sendResponse({ok:true, forwarded:tabs2.length, honest:true});
        }catch(e){ sendResponse({ok:false, error:String(e)}); }
        break;
      }
      case "agent_temp_write": {
        try{ const k=String(msg.key||""); const exp=Date.now()+(msg.ttl||120000); agentTemp.set(k,{value:msg.value, from:msg.from||"planner", t:Date.now(), ttl:msg.ttl||120000, exp}); // also propagate to bridge HTTP if available (fire-and-forget)
        // Was fire-and-forget with `.catch(()=>{})`: a bridge hiccup silently
        // dropped a temp-agent value. Now retried, and a persistent failure is a
        // recorded fault instead of nothing. The in-memory map is still the
        // source of truth for this tab, so a failure is not fatal — but it is
        // no longer invisible.
        globalThis.ZSSafe?.retry?.("background.agentTempPost", () => fetch(`${HTTP_BASE}/api/agent_temp`,{method:"POST", headers:{"Content-Type":"application/json", ...(bridgeToken?{"X-ZS-Token":bridgeToken}:{})}, body:JSON.stringify({key:k, value:msg.value, from:msg.from}), cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error(`agent_temp http ${r.status}`); return r; }), {tries:3, baseMs:150});
        sendResponse({ok:true, key:k}); }catch(e){ sendResponse({ok:false, error:String(e)}); }
        break;
      }
      case "agent_temp_read": {
        try{ const k=String(msg.key||""); let v=agentTemp.get(k); if(v && v.exp && Date.now()>v.exp){ agentTemp.delete(k); v=null; } if(v) sendResponse({ok:true, payload:v}); else { // try HTTP fallback
        try{
          const rr=await fetch(`${HTTP_BASE}/api/agent_temp?key=${encodeURIComponent(k)}`,{headers:{...(bridgeToken?{"X-ZS-Token":bridgeToken}:{})}, cache:"no-store"});
          if(rr.ok){
            const jj=await rr.json();
            if(jj && jj.value!==undefined){
              // Normalise into the SAME shape agent_temp_write stores. The real
              // defect here was the missing `exp`: the raw bridge JSON {{key,
              // value, from, ttl}} was cached as-is, the 1s sweeper skips entries
              // without `exp`, so every distinct key read over HTTP stayed in
              // memory for the life of the service worker.
              //
              // Note for the record: the SHAPE happened to work — the consumer
              // (agent_hub.js) reads payload.value, and the raw object carried
              // .value, so it resolved correctly. I first wrote that a reader got
              // `payload.value.value`; that was wrong, and the test above proves
              // it. This normalisation is for consistency with the write path and
              // to give the entry a TTL, not to fix a wrong value.
              const ttl=jj.ttl||120000;
              const entry={value:jj.value, from:jj.from||"bridge", t:jj.t||Date.now(), ttl, exp:Date.now()+ttl};
              agentTemp.set(k,entry);
              sendResponse({ok:true, payload:entry});
              break;
            }
          }
        }catch (_e) { globalThis.ZSSafe?.seen?.("background.agentTempReadHttp", _e); }
        sendResponse({ok:false, error:"not found"}); } }catch(e){ sendResponse({ok:false, error:String(e)}); }
        break;
      }
      case "agent_temp_list": {
        try{ const keys=[...agentTemp.keys()]; sendResponse({ok:true, keys}); }catch(e){ sendResponse({ok:false, error:String(e)}); }
        break;
      }
      case "zs_fault": {
        // core/safe.js already throttles these, so this is low-volume by design.
        notePageFault(msg.site, msg.message, msg.level);
        sendResponse({ok:true});
        break;
      }
      case "zs_faults": {
        sendResponse({ok:true, faults: pageFaults.slice(-40), safe: statusObj().safe});
        break;
      }
      case "reconnect":
        reconnectDelay=RECONNECT_MIN; httpHealthy=false; connect();
        Promise.resolve().then(fetchToken).catch((e) => globalThis.ZSSafe?.seen?.("background.cur", e));
        sendResponse({ok:true}); break;
      case "ping":
        // ultra-fast health ping
        if(connected) sendResponse({ok:true, transport:'ws'});
        else { const r=await httpGet('/health',1200); sendResponse(r.ok? {ok:true, transport:'http'}:{ok:false}); }
        break;
      default: sendResponse({ok:false, error:'unknown message'});
    }
  })(); return true;
});

chrome.runtime.onStartup.addListener(()=>{ Promise.resolve().then(fetchToken).catch((e)=>globalThis.ZSSafe?.seen?.("background.cur", e)); connect(); });
chrome.runtime.onInstalled.addListener(()=>{ Promise.resolve().then(fetchToken).catch((e)=>globalThis.ZSSafe?.seen?.("background.cur", e)); connect(); });
// keep alive via alarms (MV3 SWS may suspend)
try{
  chrome.alarms.create('zs-keepalive',{periodInMinutes: 0.5}); // BRUTAL HONEST: chrome.alarms clamps to 1m minimum — 0.02 ignored, using 30s + setInterval fallback
  chrome.alarms.onAlarm.addListener(()=>{ if(!connected && isLeader) connect(); });
}catch (_e) { globalThis.ZSSafe?.seen?.("background.cur", _e); }
// initial
connect();
// pre-warm HTTP
httpGet('/api/status',2000).then(r=>{
  if(r.ok){ mcpAlive=!!r.mcp_alive; if(Array.isArray(r.tools)) toolsCache=r.tools; if(Array.isArray(r.servers)) serversCache=r.servers; studioConnected=r.studio; httpHealthy=true; broadcastStatus(); }
});
