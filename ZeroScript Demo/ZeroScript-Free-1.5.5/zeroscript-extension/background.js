// SPDX-License-Identifier: GPL-3.0-or-later
// One service worker already serves every tab. Mutations are sent ONCE: never
// hedge/replay them across transports after an ambiguous timeout.
const VERSION = '4.8.0';
const WS_URL = 'ws://127.0.0.1:17613';
const HTTP_BASE = 'http://127.0.0.1:17614';
const RECONNECT_MIN = 250;
const RECONNECT_MAX = 5000;
const HEARTBEAT_MS = 10000;
const HTTP_TIMEOUT = 5000;
const HOST_NAMES = {
  'chat.deepseek.com':'DeepSeek', 'deepseek.com':'DeepSeek', 'chatgpt.com':'ChatGPT', 'chat.openai.com':'ChatGPT',
  'gemini.google.com':'Gemini', 'claude.ai':'Claude', 'kimi.ai':'Kimi', 'www.kimi.ai':'Kimi',
  'chat.z.ai':'GLM', 'z.ai':'GLM', 'chat.qwen.ai':'Qwen', 'qwen.ai':'Qwen',
  'arena.ai':'Arena', 'lmarena.ai':'Arena', 'meta.ai':'Meta AI',
  'www.meta.ai':'Meta AI', 'perplexity.ai':'Perplexity', 'www.perplexity.ai':'Perplexity',
  'copilot.microsoft.com':'Copilot', 'grok.com':'Grok', 'x.ai':'Grok', 'poe.com':'Poe',
  'chat.mistral.ai':'Mistral', 'mistral.ai':'Mistral'
};
const HOST_SUFFIXES = [
  ['deepseek.com','DeepSeek'], ['chatgpt.com','ChatGPT'], ['openai.com','ChatGPT'],
  ['gemini.google.com','Gemini'], ['claude.ai','Claude'], ['kimi.ai','Kimi'],
  ['z.ai','GLM'], ['qwen.ai','Qwen'], ['arena.ai','Arena'], ['lmarena.ai','Arena'],
  ['meta.ai','Meta AI'], ['perplexity.ai','Perplexity'], ['copilot.microsoft.com','Copilot'],
  ['grok.com','Grok'], ['x.ai','Grok'], ['poe.com','Poe'], ['mistral.ai','Mistral']
];
const MUTATING_TOOLS = new Set([
  'execute_luau','multi_edit','generate_mesh','generate_procedural_model',
  'insert_from_creator_store','store_image','script_write','create_instance',
  'delete_instance','set_property','update_script'
]);
const READ_OR_TEAM_TOOLS = new Set([
  'list_commands','list_tools','list_mcp_servers','script_read','script_search',
  'script_grep','search_game_tree','inspect_instance','get_studio_state',
  'get_console_output','search_creator_store','list_roblox_studios',
  'team_status','team_read','team_send','verify_fact'
]);
function roleCheckTool(role, toolName){
  if(!role) return null;
  const bare = String(toolName||'').split('/').pop();
  if(READ_OR_TEAM_TOOLS.has(bare)) return null;
  if(bare === 'start_stop_play') return role === 'planner' ? 'planner may not start/stop Play — send the plan via team_send to the coder' : null;
  const mut = MUTATING_TOOLS.has(bare) || /^(generate_|insert_|create_|delete_)/.test(bare);
  if(mut || role !== 'coder'){
    if(role === 'coder') return null;
    if(role === 'planner') return 'planner may not mutate Studio — send your plan to the coder via team_send; only the coder calls execute_luau/multi_edit';
    if(role === 'checker') return 'checker may not mutate Studio — report defects to the coder via team_send; only the coder calls execute_luau/multi_edit';
    return role + ' may not mutate Studio';
  }
  return null;
}
let ws=null, connected=false, bridgeToken=null, tokenPromise=null, nextId=1;
let reconnectTimer=null, reconnectDelay=250, lastMessageAt=0, httpHealthy=false;
let toolsCache=[], serversCache=[], studio=null, studioApp=null, studioProc=null, mcpAlive=false;
const pending=new Map(), reads=new Map();
let bindings={};
const storageReady=(async()=>{
  try { const saved=await chrome.storage.session.get('zsTeamBindings'); bindings=saved.zsTeamBindings||{}; } catch (_e) { globalThis.ZSSafe?.seen?.("background.storageReady", _e); }
})();
function saveBindings(){ chrome.storage.session.set({zsTeamBindings:bindings}).catch(console.error); }
function providerName(url){
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    if (HOST_NAMES[h]) return HOST_NAMES[h];
    const bare = h.replace(/^www\./, '');
    if (HOST_NAMES[bare]) return HOST_NAMES[bare];
    for (const [suf, label] of HOST_SUFFIXES) {
      if (bare === suf || bare.endsWith('.' + suf)) return label;
    }
    return null;
  } catch (_e) { globalThis.ZSSafe?.seen?.("background.providerName", _e); return null; }
}
function trusted(sender){ return sender.id===chrome.runtime.id && (!sender.tab || !!providerName(sender.tab.url||sender.url)); }
function statusObj(){ return {type:'zs-status',version:VERSION,connected:connected||httpHealthy,mcpAlive,studio,studioApp,studioProc,tools:toolsCache.length,servers:serversCache,teamBindings:Object.values(bindings).map(b=>({name:b.name,role:b.role,team:b.team})),faults:pageFaults.length,faultSites:[...new Set(pageFaults.map(f=>f.site))].slice(-6),safe:globalThis.ZSSafe?.stats?.()||null,transport:connected?'ws':'http'}; }
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
  try { await chrome.runtime.sendMessage(s); } catch (_e) { globalThis.ZSSafe?.seen?.("background.broadcastStatus", _e); }
  try { for(const t of await chrome.tabs.query({})) if(providerName(t.url)) chrome.tabs.sendMessage(t.id,s).catch(()=>{}); } catch (_e) { globalThis.ZSSafe?.seen?.("background.broadcastStatus", _e); }
}
function fetchToken(){
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
async function http(path, body, timeout=HTTP_TIMEOUT){
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeout);
  try {
    if(!bridgeToken) await fetchToken();
    const response=await fetch(HTTP_BASE+path,{method:body===undefined?'GET':'POST',headers:{'X-ZS-Token':bridgeToken,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal,cache:'no-store'});
    if(response.status===401){ bridgeToken=null; return {ok:false,kind:'auth',error:'Bridge restarted or pairing expired. Reconnect; this operation was not retried.'}; }
    const data=await response.json(); httpHealthy=response.ok;
    return response.ok?data:{...data,ok:false,error:data.error||'HTTP '+response.status};
  } catch(e){ globalThis.ZSSafe?.seen?.("background.http", e); httpHealthy=false; return {ok:false,kind:'disconnected',error:String(e.message||e)+'; outcome may be unknown. Inspect state before retrying a mutation.'}; }
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
  reconnectDelay=Math.min(RECONNECT_MAX,reconnectDelay*1.7);
}
async function connect(){
  if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
  try {
    await fetchToken();
    // Another caller may have completed pairing while we waited.
    if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
    const socket=new WebSocket(WS_URL+'/?token='+encodeURIComponent(bridgeToken)); ws=socket;
    socket.onopen=()=>{ if(ws!==socket)return; connected=true;lastMessageAt=Date.now();reconnectDelay=RECONNECT_MIN;broadcastStatus().catch(console.error); };
    socket.onmessage=ev=>{
      if(ws!==socket)return;
      lastMessageAt=Date.now(); let msg;try{msg=JSON.parse(ev.data);}catch(_e){globalThis.ZSSafe?.seen?.("background.wsParse",_e);return;}
      if(msg.type==='team_event'){
        for(const id of Object.keys(bindings)){
          chrome.tabs.sendMessage(Number(id),{type:'zs-team-event',event:msg.event}).catch(()=>{});
        }
        try{chrome.runtime.sendMessage({type:'zs-team-status',event:msg.event}).catch(()=>{});}catch(_e){globalThis.ZSSafe?.seen?.("background.teamPush",_e);}
        return;
      }
      updateStatus(msg);
      const p=pending.get(msg.id);
      if(p){
        clearTimeout(p.timer);pending.delete(msg.id);
        if(msg.type==='error') p.resolve({ok:false,error:msg.error});
        else if(msg.type==='tool_result') p.resolve(msg);
        else p.resolve({ok:msg.ok!==false,...msg});
      }
      if(['connected','tools','mcp_status','studio_status'].includes(msg.type))broadcastStatus().catch(console.error);
    };
    socket.onclose=()=>{if(ws!==socket)return;ws=null;connected=false;studio=null;studioApp=null;mcpAlive=false;failPending('WebSocket closed');broadcastStatus().catch(console.error);scheduleReconnect();};
    socket.onerror=()=>socket.close();
  } catch(_e) {globalThis.ZSSafe?.seen?.("background.connect",_e);scheduleReconnect();}
}
async function readOnce(key, fn){
  if(reads.has(key))return reads.get(key);
  const p=Promise.resolve().then(fn);reads.set(key,p);
  try{return await p;}finally{reads.delete(key);}
}
function refreshStatus(){
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
    // 4.8.0: START ALL JOINED AGENTS. The team is whatever joined (two or
    // more); the old "exactly three" rule refused every smaller team and the
    // bridge had already started it by then.
    const need=r.members.length;
    const started=results.filter(x=>x.ok).length;
    if(started<2||started!==need||results.some(x=>!x.ok)){
      await http('/api/team/stop',{team});
      for(const [id] of members)chrome.tabs.sendMessage(Number(id),{type:'zs-team-stop'}).catch(()=>{});
      return {ok:false,error:`Started ${started} of ${need} joined agents. A team needs at least 2 tabs, and every joined tab must accept its role prompt; the team was stopped so nobody talks to a half-started team.`,results};
    }
    const roles=Array.isArray(r.roles)?r.roles:[];
    return {ok:true,results,started,
      members:(r.members||[]).map(m=>`${m.role}=${m.name}`),
      roles,
      note:`Started ${started} joined agents (${roles.join(' → ')||'unknown order'}). Role prompts submitted concurrently; the bridge orders the introductions and drives the plan → implement → review → fix collaboration.`};
  }
  if(msg.type==='team_stop'){
    const team=msg.team||'studio', r=await http('/api/team/stop',{team});
    for(const [id,b] of Object.entries(bindings))if(b.team===team)chrome.tabs.sendMessage(Number(id),{type:'zs-team-stop'}).catch(()=>{});
    return r;
  }
  const binding=bindings[tabId];
  if(!binding)return {ok:false,error:'Join this tab to a team first using the extension popup'};
  if(msg.type==='team_leave'){delete bindings[tabId];saveBindings();broadcastStatus().catch(()=>{});return http('/api/team/leave',{member_id:binding.member_id});}
  const action={team_status:'status',team_inbox:'inbox',team_ack:'ack',team_send:'send',team_ready:'ready'}[msg.type];
  if(!action)return {ok:false,error:'Unknown team action'};
  // 4.8.0: `kind` lets the extension relay the USER'S own request into the
  // team ("request") without pretending an agent spoke. The AI-facing
  // team_send tool never sets one, so an agent cannot skip the intro order.
  const body={member_id:binding.member_id,...(action==='send'?{to:msg.to||'all',text:msg.text,message_id:msg.message_id,...(msg.kind?{kind:msg.kind}:{})}:{}),...(action==='ack'?{ids:msg.ids}:{})};
  if(connected){
    const wr=await sendWS({type:'team_'+action,...body},5000);
    if(wr && wr.kind!=='disconnected') return wr;
  }
  return http('/api/team/'+action,body);
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
      await storageReady;
      const timeout=Number(msg.timeout||120000);
      if(!Number.isFinite(timeout)||timeout<=0||timeout>120000)return {ok:false,error:'Invalid timeout'};
      const binding=sender.tab?bindings[sender.tab.id]:null;
      const blocked=binding?roleCheckTool(binding.role,msg.name):null;
      if(blocked)return {ok:false,kind:'role_violation',error:blocked};
      const payload={type:'call_tool',name:msg.name,arguments:msg.arguments||{},timeout,...(binding?{member_id:binding.member_id}:{})};
      return connected?sendWS(payload,timeout+8000):http('/api/call',payload,timeout+8000);
    }
    case 'call_batch':{
      await storageReady;
      const binding=sender.tab?bindings[sender.tab.id]:null;
      if(binding && Array.isArray(msg.calls)){
        for(const c of msg.calls){
          const blocked=roleCheckTool(binding.role,c?.name||c?.tool||c?.command);
          if(blocked)return {ok:false,kind:'role_violation',error:blocked};
        }
      }
      return http('/api/batch',{calls:msg.calls,...(binding?{member_id:binding.member_id}:{})},125000); // no replay
    }
    case 'verify_fact':{
      const vpath=String(msg.path||''), vtool=String(msg.tool||'inspect_instance');
      if(connected){
        const wr=await sendWS({type:'verify',path:vpath,tool:vtool},12000);
        if(wr && wr.kind!=='disconnected') return wr;
      }
      return http('/api/verify',{path:vpath,tool:vtool},12000);
    }
    case 'team_summary':return http('/api/team/summary');
    case 'restart_mcp':return http('/api/restart_mcp',{server:msg.server},20000);
    case 'add_server':return http('/api/add_server',{server_id:msg.server_id,command:msg.command,args:msg.args,env:msg.env},10000);
    case 'remove_server':return http('/api/remove_server',{server_id:msg.server_id},10000);
    case 'metrics':return http('/api/metrics');
    case 'ping':return {ok:connected||httpHealthy};
    case 'reconnect':{
      const old=ws;ws=null;connected=false;if(old)old.close();failPending('User reconnected');bridgeToken=null;reconnectDelay=RECONNECT_MIN;
      await connect();return {ok:true};
    }
    default:return legacyMessage(msg,sender);
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
const heartbeatTimer=setInterval(heartbeat,HEARTBEAT_MS);
chrome.alarms.create('zs-keepalive',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(()=>heartbeat().catch(console.error));
chrome.runtime.onStartup.addListener(()=>connect().catch(console.error));
chrome.runtime.onInstalled.addListener(()=>connect().catch(console.error));

// Compatibility routing retained from main's wall/peer/temp implementation.
try { importScripts('core/safe.js'); } catch(e) { console.warn('[zs] safe worker import',e); }
const PROVIDER_URLS=Object.keys(HOST_NAMES).map(h=>'https://'+h+'/*');
const agentTemp=new Map();
const tempSweepTimer=setInterval(()=>{const now=Date.now();for(const [k,v] of agentTemp)if(v.exp<now)agentTemp.delete(k);while(agentTemp.size>500)agentTemp.delete(agentTemp.keys().next().value);},10000);
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
      ["chat.z.ai","glm"],["z.ai","glm"],["qwen.ai","qwen"],["arena.ai","arena"],["lmarena.ai","arena"],
      ["meta.ai","meta"],["perplexity.ai","perplexity"],["copilot.microsoft.com","copilot"],
      ["grok.com","grok"],["x.ai","grok"],["poe.com","poe"],["mistral.ai","mistral"],
    ];
    for(const [needle,id] of M){ if(host===needle || host.endsWith("."+needle)) return id; }
  }catch (_e) { globalThis.ZSSafe?.seen?.("background.host", _e); }
  return "unknown";
}


function legacyMessage(msg,_sender){
  return new Promise(sendResponse=>{(async()=>{switch(msg.type){
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
          } else if(!delivered){
            // Targets exist but the distinctness filter removed all of them (the
            // only tab of that provider IS us). The old code answered ok:true,
            // delivered:0 — so the sender acknowledged a message that reached
            // nobody, and the failure was invisible on both ends.
            sendResponse({ok:false, error:`the only "${to}" tab is the sender — a model cannot message itself`, delivered:0, targets: filtered.map(t=>t.pid)});
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

 default:sendResponse({ok:false,error:'Unknown message'});
 }})().catch(e=>sendResponse({ok:false,error:String(e)}));});
}

connect().catch(console.error);

// Worker teardown hook where supported; timers also end when MV3 terminates it.
if(typeof self!=="undefined" && self.addEventListener)self.addEventListener('unload',()=>{clearInterval(heartbeatTimer);clearInterval(tempSweepTimer);});
