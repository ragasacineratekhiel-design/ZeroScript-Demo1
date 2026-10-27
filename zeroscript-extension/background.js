// SPDX-License-Identifier: GPL-3.0-or-later
// background.js — ZeroScript MAX Service Worker v3.2.0 ULTRA
// UPGRADED EVERYTHING: no GUI change, pure logic MAX. Hedge now uses HEDGE_MS (80ms), not hardcoded 280.
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

const RECONNECT_MIN = 80;    // MAX 80ms ultra
const RECONNECT_MAX = 2500;
const HEARTBEAT_MS = 2800;   // MAX 2.8s — instant drop
const STALE_SOCKET_MS = 5000;// MAX 5s — instant half-open catch
const REQUEST_TIMEOUT_DEFAULT = 130000;
const HTTP_TIMEOUT = 5000;   // MAX 5s tight
const HEDGE_MS = 80;         // ULTRA 80ms hedge — matches config TRANSPORT

let ws=null, connected=false, wsHealthy=false;
let reconnectDelay=RECONNECT_MIN, reconnectTimer=null, heartbeatTimer=null, lastMessageAt=0;
let nextId=1; const pending=new Map();
let toolsCache=[], mcpAlive=false, serversCache=[];
let studioConnected=null, studioApp=null, studioProc=null;
let bridgeToken=null, bridgeCaps=[];
let sseAbort=null, bc=null, isLeader=false, leaderId=Math.random().toString(36).slice(2);
let fastestTransport='ws'; // learned
let httpHealthy=false;

function log(...a){ console.log("[zs-bg]",...a); }

// ── token ─────────────────────────────────────────────────────────────
async function fetchToken(){
  try{
    const r=await fetch(`${HTTP_BASE}/api/token`,{method:'GET',cache:'no-store'});
    if(r.ok){ const j=await r.json(); if(j.token) bridgeToken=j.token; }
  }catch{}
}
fetchToken();

// ── BroadcastChannel leader election (single WS) ──────────────────────
try{
  bc=new BroadcastChannel('zs-bridge');
  bc.onmessage=(ev)=>{
    const m=ev.data;
    if(!m) return;
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
      handleProxyRequest(m);
    }
    if(m.type==='response' && !isLeader){
      resolvePending(m.id, m.payload);
    }
  };
  // announce leadership attempt
  setTimeout(()=>{ if(!isLeader) return; bc.postMessage({type:'leader-announce',leaderId}); }, 100);
  // periodic leader ping
  setInterval(()=>{ if(isLeader) try{ bc.postMessage({type:'leader-ping',leaderId}); }catch{} }, 3000);
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
    try{ bc.postMessage({type:'status-broadcast', mcpAlive, tools:toolsCache, servers:serversCache, studio:studioConnected, studio_app:studioApp, studio_proc:studioProc}); }catch{}
  }
}

// ── HTTP transport primitives ─────────────────────────────────────────
async function httpPost(path, body, timeout=HTTP_TIMEOUT){
  const url=`${HTTP_BASE}${path}`;
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), timeout);
  try{
    const r=await fetch(url,{method:'POST', headers:{'Content-Type':'application/json', ...(bridgeToken?{'X-ZS-Token':bridgeToken}:{})}, body:JSON.stringify(body), signal:ctrl.signal, cache:'no-store'});
    clearTimeout(t); httpHealthy=r.ok;
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
    try{ const a=await wsPromise; if(a && a.ok) return a; }catch{}
    return res;
  } else {
    const r=await httpPost('/api/call',{name, arguments:args, timeout}, timeout+10000);
    if(r && r.ok) fastestTransport='http';
    return r && r.ok ? {ok:true, text:r.text, images:r.images||[]} : (r||{ok:false, error:'http failed'});
  }
}
async function transportListTools(){
  if(connected && wsHealthy){
    try{ const r=await sendWS({type:'list_tools'}, 6000); if(r.ok) return r; }catch{}
  }
  const r=await httpGet('/api/tools');
  if(r.ok && Array.isArray(r.tools)) return {ok:true, tools:r.tools};
  return {ok:false, error:r.error||'no tools'};
}
async function transportStudioStatus(){
  if(connected && wsHealthy){
    try{ const r=await sendWS({type:'studio_status'}, 4000); if(r.ok) return r; }catch{}
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
    try{ ws.send(JSON.stringify({type:'hello', id: nextId++, caps:['ws','http','sse','batch','binary']})); }catch{}
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
  ws.onerror=()=>{ try{ ws.close(); }catch{} };
}
function scheduleReconnect(){
  clearTimeout(reconnectTimer);
  // jitter: +- 20%
  const jitter=reconnectDelay*0.2*(Math.random()*2-1);
  reconnectTimer=setTimeout(connect, Math.max(50, reconnectDelay+jitter));
  reconnectDelay=Math.min(reconnectDelay*1.5, RECONNECT_MAX);
}
function startHeartbeat(){
  stopHeartbeat();
  heartbeatTimer=setInterval(()=>{
    if(connected){
      if(lastMessageAt && Date.now()-lastMessageAt > STALE_SOCKET_MS){
        log("WS stale, forcing reconnect"); wsHealthy=false;
        try{ ws.close(); }catch{}; return;
      }
      // adaptive: active vs idle
      sendWS({type:'ping'}, 4000).catch(()=>{});
      refreshStudioStatus();
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
              }catch{}
            }
          }
        }
      }
    }).catch(()=>{});
  }catch{}
}
function stopSSE(){ if(sseCtrl) try{ sseCtrl.abort(); }catch{} sseCtrl=null; }
function handleSSEEvent(ev){
  if(ev.type==='status'){
    if(typeof ev.studio==='boolean') studioConnected=ev.studio;
    broadcastStatus();
  }
}

function metricsBytes(data){
  try{ if(typeof data==='string') metricsBytesIn+=data.length; else if(data instanceof ArrayBuffer) metricsBytesIn+=data.byteLength; }catch{}
}
let metricsBytesIn=0, metricsBytesOut=0;

function waitForConnection(timeout=4000){
  return new Promise(resolve=>{
    if(connected && ws && ws.readyState===WebSocket.OPEN) return resolve(true);
    if(!isLeader) return resolve(false); // follower: rely on HTTP
    connect();
    const t0=Date.now();
    const iv=setInterval(()=>{
      if(connected && ws && ws.readyState===WebSocket.OPEN){ clearInterval(iv); resolve(true); }
      else if(Date.now()-t0>timeout){ clearInterval(iv); resolve(false); }
    }, 40); // 40ms poll (was 100) — faster wake
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
function resolvePending(id,value){ const p=pending.get(id); if(!p) return; clearTimeout(p.timer); pending.delete(id); p.resolve(value); // also clear coalesce entry if any
  for(const [k,entry] of inflightCoalesce.entries()){ if(entry.id===id) inflightCoalesce.delete(k); }
}
function failAllPending(reason){ for(const [,p] of pending){ clearTimeout(p.timer); p.resolve({ok:false, kind:'disconnected', error:reason}); } pending.clear(); inflightCoalesce.clear(); }

function statusObj(){ return {type:"zs-status", connected:connected||httpHealthy, mcpAlive, studio:studioConnected, studioApp, studioProc, tools:toolsCache.length, servers:serversCache, transport: fastestTransport, caps: bridgeCaps}; }
function broadcastStatus(){
  const s=statusObj();
  try{ chrome.runtime.sendMessage(s).catch(()=>{}); }catch{}
  chrome.tabs.query({url: PROVIDER_URLS}, tabs=>{ for(const t of tabs) try{ chrome.tabs.sendMessage(t.id,s).catch(()=>{}); }catch{} });
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
        const res=await p; inflightCoalesce.delete(key); sendResponse(res); break;
      }
      case "call_tool":{
        const name=msg.name, args=msg.arguments||{}, timeout=msg.timeout||120000;
        const key=coalesceKey(name,args);
        if(inflightCoalesce.has(key)){ const prev=await inflightCoalesce.get(key); sendResponse(prev); break; }
        const p=transportCall(name,args,timeout);
        inflightCoalesce.set(key,{id: -1});
        // store promise for coalesce (simplified: no second pending race)
        try{
          const r=await p;
          sendResponse(r);
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
      case "reconnect":
        reconnectDelay=RECONNECT_MIN; httpHealthy=false; connect(); fetchToken(); sendResponse({ok:true}); break;
      case "ping":
        // ultra-fast health ping
        if(connected) sendResponse({ok:true, transport:'ws'});
        else { const r=await httpGet('/health',2000); sendResponse(r.ok? {ok:true, transport:'http'}:{ok:false}); }
        break;
      default: sendResponse({ok:false, error:'unknown message'});
    }
  })(); return true;
});

chrome.runtime.onStartup.addListener(()=>{ fetchToken(); connect(); });
chrome.runtime.onInstalled.addListener(()=>{ fetchToken(); connect(); });
// keep alive via alarms (MV3 SWS may suspend)
try{
  chrome.alarms.create('zs-keepalive',{periodInMinutes: 0.25});
  chrome.alarms.onAlarm.addListener(()=>{ if(!connected && isLeader) connect(); });
}catch{}
// initial
connect();
// pre-warm HTTP
httpGet('/api/status',3000).then(r=>{
  if(r.ok){ mcpAlive=!!r.mcp_alive; if(Array.isArray(r.tools)) toolsCache=r.tools; if(Array.isArray(r.servers)) serversCache=r.servers; studioConnected=r.studio; httpHealthy=true; broadcastStatus(); }
});
