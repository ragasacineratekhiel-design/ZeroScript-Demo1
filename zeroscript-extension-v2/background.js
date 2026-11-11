// SPDX-License-Identifier: GPL-3.0-or-later
// One service worker already serves every tab. Mutations are sent ONCE: never
// hedge/replay them across transports after an ambiguous timeout.
const WS_URL = 'ws://127.0.0.1:17613';
const HTTP_BASE = 'http://127.0.0.1:17614';
const HOST_NAMES = {
  'chat.deepseek.com':'DeepSeek', 'chatgpt.com':'ChatGPT', 'chat.openai.com':'ChatGPT',
  'gemini.google.com':'Gemini', 'claude.ai':'Claude', 'kimi.ai':'Kimi', 'www.kimi.ai':'Kimi',
  'chat.z.ai':'GLM', 'chat.qwen.ai':'Qwen', 'arena.ai':'Arena', 'meta.ai':'Meta AI',
  'www.meta.ai':'Meta AI', 'perplexity.ai':'Perplexity', 'www.perplexity.ai':'Perplexity',
  'copilot.microsoft.com':'Copilot', 'grok.com':'Grok', 'x.ai':'Grok', 'poe.com':'Poe',
  'chat.mistral.ai':'Mistral'
};
let ws=null, connected=false, bridgeToken=null, tokenPromise=null, nextId=1;
let reconnectTimer=null, reconnectDelay=250, lastMessageAt=0, httpHealthy=false;
let toolsCache=[], serversCache=[], studio=null, studioApp=null, studioProc=null, mcpAlive=false;
const pending=new Map(), reads=new Map();
let bindings={};
const storageReady=(async()=>{
  try { const saved=await chrome.storage.session.get('zsTeamBindings'); bindings=saved.zsTeamBindings||{}; } catch {}
})();
function saveBindings(){ chrome.storage.session.set({zsTeamBindings:bindings}).catch(console.error); }
function providerName(url){ try { const u=new URL(url); return u.protocol==='https:' ? (HOST_NAMES[u.hostname]||null) : null; } catch { return null; } }
function trusted(sender){ return sender.id===chrome.runtime.id && (!sender.tab || !!providerName(sender.tab.url||sender.url)); }
function statusObj(){ return {type:'zs-status',connected:connected||httpHealthy,mcpAlive,studio,studioApp,studioProc,tools:toolsCache.length,servers:serversCache,transport:connected?'ws':'http'}; }
function updateStatus(r){
  if('mcp_alive' in r) mcpAlive=!!r.mcp_alive;
  if('studio' in r) studio=r.studio;
  if('studio_app' in r) studioApp=r.studio_app;
  if('studio_proc' in r) studioProc=r.studio_proc;
  if(Array.isArray(r.tools)) toolsCache=r.tools;
  if(Array.isArray(r.servers)) serversCache=r.servers;
}
async function broadcastStatus(){
  const s=statusObj();
  try { await chrome.runtime.sendMessage(s); } catch {}
  try { for(const t of await chrome.tabs.query({})) if(providerName(t.url)) chrome.tabs.sendMessage(t.id,s).catch(()=>{}); } catch {}
}
async function fetchToken(){
  if(tokenPromise) return tokenPromise;
  tokenPromise=(async()=>{
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),3000);
    try {
      const response=await fetch(HTTP_BASE+'/api/token',{headers:{'X-ZS-Client':'extension'},signal:controller.signal,cache:'no-store'});
      if(!response.ok) throw new Error('Extension pairing refused: HTTP '+response.status);
      const data=await response.json();
      if(!data.token) throw new Error('Bridge did not provide a token');
      bridgeToken=data.token; return bridgeToken;
    } finally { clearTimeout(timer); }
  })().finally(()=>{tokenPromise=null;});
  return tokenPromise;
}
async function http(path, body, timeout=5000){
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeout);
  try {
    if(!bridgeToken) await fetchToken();
    const response=await fetch(HTTP_BASE+path,{method:body===undefined?'GET':'POST',headers:{'X-ZS-Token':bridgeToken,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal,cache:'no-store'});
    if(response.status===401){ bridgeToken=null; return {ok:false,kind:'auth',error:'Bridge restarted or pairing expired. Reconnect; this operation was not retried.'}; }
    const data=await response.json(); httpHealthy=response.ok;
    return response.ok?data:{...data,ok:false,error:data.error||'HTTP '+response.status};
  } catch(e){ httpHealthy=false; return {ok:false,kind:'disconnected',error:String(e.message||e)+'; outcome may be unknown. Inspect state before retrying a mutation.'}; }
  finally { clearTimeout(timer); }
}
function failPending(reason){ for(const p of pending.values()){clearTimeout(p.timer);p.resolve({ok:false,kind:'disconnected',error:reason+'; outcome unknown, not retried'});} pending.clear(); }
function sendWS(obj, timeout=128000){
  return new Promise(resolve=>{
    if(!ws || ws.readyState!==WebSocket.OPEN){resolve({ok:false,kind:'disconnected',error:'No WebSocket connection; request not sent'});return;}
    const id=nextId++;
    const timer=setTimeout(()=>{pending.delete(id);resolve({ok:false,kind:'timeout',error:'Bridge timeout; outcome unknown, not retried'});},timeout);
    pending.set(id,{resolve,timer});
    try{ws.send(JSON.stringify({...obj,id}));}catch(e){clearTimeout(timer);pending.delete(id);resolve({ok:false,error:String(e)});}
  });
}
function scheduleReconnect(){
  clearTimeout(reconnectTimer);
  reconnectTimer=setTimeout(()=>connect().catch(()=>{}),reconnectDelay);
  reconnectDelay=Math.min(5000,reconnectDelay*1.7);
}
async function connect(){
  if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
  try {
    await fetchToken();
    // Another caller may have completed pairing while we waited.
    if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
    const socket=new WebSocket(WS_URL+'/?token='+encodeURIComponent(bridgeToken)); ws=socket;
    socket.onopen=()=>{ if(ws!==socket)return; connected=true;lastMessageAt=Date.now();reconnectDelay=250;broadcastStatus(); };
    socket.onmessage=ev=>{
      if(ws!==socket)return;
      lastMessageAt=Date.now(); let msg;try{msg=JSON.parse(ev.data);}catch{return;}
      updateStatus(msg);
      const p=pending.get(msg.id);
      if(p){
        clearTimeout(p.timer);pending.delete(msg.id);
        if(msg.type==='error') p.resolve({ok:false,error:msg.error});
        else if(msg.type==='tool_result') p.resolve(msg);
        else p.resolve({ok:msg.ok!==false,...msg});
      }
      if(['connected','tools','mcp_status','studio_status'].includes(msg.type))broadcastStatus();
    };
    socket.onclose=()=>{if(ws!==socket)return;ws=null;connected=false;studio=null;studioApp=null;mcpAlive=false;failPending('WebSocket closed');broadcastStatus();scheduleReconnect();};
    socket.onerror=()=>socket.close();
  } catch {scheduleReconnect();}
}
async function readOnce(key, fn){
  if(reads.has(key))return reads.get(key);
  const p=Promise.resolve().then(fn);reads.set(key,p);
  try{return await p;}finally{reads.delete(key);}
}
async function refreshStatus(){
  return readOnce('status',async()=>{
    // Cached handshake is immediate; slow MCP health probes run on the bridge's
    // existing monitor instead of blocking every startup and popup request.
    if(connected)return statusObj();
    const r=await http('/api/status');if(r.ok)updateStatus(r);
    connect().catch(()=>{});return statusObj();
  });
}
async function teamRequest(msg,sender){
  await storageReady;
  const tabId=sender.tab?.id;
  if(msg.type==='team_register'){
    if(tabId===undefined) return {ok:false,error:'Join from an AI tab'};
    const name=providerName(sender.tab.url||sender.url);
    const session=String(msg.session_id||'').replace(/[^a-zA-Z0-9-]/g,'').slice(0,80);
    if(!name||!session)return {ok:false,error:'Invalid provider or document session'};
    const member_id=`tab-${tabId}-${session}`;
    const r=await http('/api/team/register',{member_id,name,role:msg.role,team:msg.team||'studio'});
    if(r.ok){bindings[tabId]={member_id,name,role:msg.role,team:msg.team||'studio'};saveBindings();}
    return r;
  }
  if(msg.type==='team_start'){
    const team=msg.team||'studio';
    const r=await http('/api/team/start',{team});if(!r.ok)return r;
    if(!Array.isArray(r.members))return {ok:false,error:'Bridge did not return registered members'};
    const members=Object.entries(bindings).filter(([,m])=>m.team===team && r.members.some(peer=>peer.id===m.member_id));
    const results=await Promise.all(members.map(async([id])=>{
      try{return {tab:Number(id),...await chrome.tabs.sendMessage(Number(id),{type:'zs-team-start'})};}
      catch(e){return {tab:Number(id),ok:false,error:String(e)};}
    }));
    if(results.length!==3 || results.some(r=>!r.ok)){await http('/api/team/stop',{team});for(const [id] of members)chrome.tabs.sendMessage(Number(id),{type:'zs-team-stop'}).catch(()=>{});return {ok:false,error:'One or more tabs failed to start. Team stopped; inspect tab errors.',results};}
    return {ok:true,results,note:'Role prompts submitted concurrently. Real introductions are ordered by the bridge.'};
  }
  if(msg.type==='team_stop'){
    const team=msg.team||'studio', r=await http('/api/team/stop',{team});
    for(const [id,b] of Object.entries(bindings))if(b.team===team)chrome.tabs.sendMessage(Number(id),{type:'zs-team-stop'}).catch(()=>{});
    return r;
  }
  const binding=bindings[tabId];
  if(!binding)return {ok:false,error:'Join this tab to a team first using the extension popup'};
  if(msg.type==='team_leave'){delete bindings[tabId];saveBindings();return http('/api/team/leave',{member_id:binding.member_id});}
  const action={team_status:'status',team_inbox:'inbox',team_ack:'ack',team_send:'send',team_ready:'ready'}[msg.type];
  if(!action)return {ok:false,error:'Unknown team action'};
  return http('/api/team/'+action,{member_id:binding.member_id,...(action==='send'?{to:msg.to||'all',text:msg.text,message_id:msg.message_id}:{}),...(action==='ack'?{ids:msg.ids}:{})});
}
async function handle(msg,sender){
  if(!msg || typeof msg!=='object' || !trusted(sender))return {ok:false,error:'Untrusted extension message'};
  if(msg.type==='zs-status')return statusObj();
  if(msg.type.startsWith('team_'))return teamRequest(msg,sender);
  switch(msg.type){
    case 'status':return refreshStatus();
    case 'list_tools':return readOnce('tools:'+!!msg.force,async()=>{
      if(!msg.force && toolsCache.length)return {ok:true,tools:toolsCache};
      const r=await http('/api/tools'+(msg.force?'?refresh=1':''));if(r.ok)updateStatus(r);return r;
    });
    case 'call_tool':{
      const timeout=Number(msg.timeout||120000);
      if(!Number.isFinite(timeout)||timeout<=0||timeout>120000)return {ok:false,error:'Invalid timeout'};
      const payload={type:'call_tool',name:msg.name,arguments:msg.arguments||{},timeout};
      return connected?sendWS(payload,timeout+8000):http('/api/call',payload,timeout+8000);
    }
    case 'call_batch':return http('/api/batch',{calls:msg.calls},125000); // no replay
    case 'restart_mcp':return http('/api/restart_mcp',{server:msg.server},20000);
    case 'add_server':return http('/api/add_server',{server_id:msg.server_id,command:msg.command,args:msg.args,env:msg.env},10000);
    case 'remove_server':return http('/api/remove_server',{server_id:msg.server_id},10000);
    case 'metrics':return http('/api/metrics');
    case 'ping':return {ok:connected||httpHealthy};
    case 'reconnect':{
      const old=ws;ws=null;connected=false;if(old)old.close();failPending('User reconnected');bridgeToken=null;reconnectDelay=250;
      await connect();return {ok:true};
    }
    default:return {ok:false,error:'Unknown message'};
  }
}
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  handle(msg,sender).then(respond).catch(e=>respond({ok:false,error:String(e.message||e)}));return true;
});
async function leaveTab(id){await storageReady;const b=bindings[id];delete bindings[id];saveBindings();if(b)await http('/api/team/leave',{member_id:b.member_id});}
chrome.tabs.onRemoved.addListener(id=>leaveTab(id).catch(console.error));
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='loading')leaveTab(id).catch(console.error);});
let heartbeatBusy=false;
async function heartbeat(){
  if(heartbeatBusy)return;heartbeatBusy=true;
  try{
    if(connected){if(Date.now()-lastMessageAt>12000)ws?.close();else sendWS({type:'ping'},5000);}
    else await connect();
    await storageReady;
    const tabs=await chrome.tabs.query({});
    await Promise.all(Object.entries(bindings).map(async([id,b])=>{
      if(!tabs.some(t=>t.id===Number(id)&&providerName(t.url))){delete bindings[id];return;}
      const status=await http('/api/team/status',{member_id:b.member_id});
      if(!status.ok)await http('/api/team/register',{member_id:b.member_id,name:b.name,role:b.role,team:b.team});
    }));
  }finally{heartbeatBusy=false;}
}
setInterval(heartbeat,10000);
chrome.alarms.create('zs-keepalive',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(()=>heartbeat().catch(console.error));
chrome.runtime.onStartup.addListener(()=>connect().catch(console.error));
chrome.runtime.onInstalled.addListener(()=>connect().catch(console.error));
connect().catch(console.error);
