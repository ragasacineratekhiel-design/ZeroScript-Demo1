// SPDX-License-Identifier: GPL-3.0-or-later
const KOFI_URL = "https://ko-fi.com/sebattfg";
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "gemini.google.com", "claude.ai",
  "www.kimi.ai", "kimi.ai",
  "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.meta.ai", "meta.ai",
  "perplexity.ai", "www.perplexity.ai", "copilot.microsoft.com",
  "grok.com", "x.ai", "poe.com", "chat.mistral.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

function safeVer() {
  try { if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) return "v" + chrome.runtime.getManifest().version; } catch {}
  return "v3.1.0";
}
try { document.getElementById("ver").textContent = safeVer(); } catch {}

function render(s) {
  if (!s) return;
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  if (!dot || !state) return;
  const list = s.servers || [];
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
  const studioOff = mcpOk && s.studio === false;
  const ok = mcpOk && s.studio === true;
  dot.className = "dot " + (s.connected ? (ok ? "on" : "warn") : "");
  state.textContent = s.connected
    ? (ok ? "Connected · Roblox Studio ready"
        : studioOff ? "Studio not connected · enable the MCP server in Studio"
        : "Bridge OK · open Roblox Studio")
    : "Bridge offline — run start.py";
  if (tools) tools.textContent = s.connected ? `${s.tools || 0} tools available` : "Run bridge.py (start.py)";
  if (servers) servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
}

function refresh() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      render({ connected: false, tools: 0, servers: [] });
      return;
    }
    chrome.runtime.sendMessage({ type: "status" }, (s) => s && render(s));
  } catch { render({ connected: false, tools: 0, servers: [] }); }
}

function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", fn);
}

bind("reconnect", () => {
  try { chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600)); } catch {}
});
bind("restart", (e) => {
  const t = e.target; t.textContent = "Restarting…";
  try { chrome.runtime.sendMessage({ type: "restart_mcp" }, () => { t.textContent = "⟳ Restart Roblox server"; setTimeout(refresh, 600); }); } catch { t.textContent = "⟳ Restart Roblox server"; }
});
bind("kofi", () => { try { chrome.tabs.create({ url: KOFI_URL }); } catch { window.open(KOFI_URL, "_blank"); } });
bind("settings", () => {
  try {
    if (typeof chrome === "undefined" || !chrome.tabs) { window.open(DEFAULT_AI_URL, "_blank"); return; }
    chrome.tabs.query({}, (tabs) => {
      const active = tabs.find((t) => t.active && t.url && SUPPORTED_HOSTS.includes(new URL(t.url).hostname));
      const anySupported = active || tabs.find((t) => t.url && SUPPORTED_HOSTS.includes(new URL(t.url).hostname));
      if (anySupported) {
        chrome.tabs.sendMessage(anySupported.id, { type: "zs-open-menu" });
        chrome.tabs.update(anySupported.id, { active: true });
      } else {
        chrome.tabs.create({ url: DEFAULT_AI_URL });
      }
    });
  } catch { window.open(DEFAULT_AI_URL, "_blank"); }
});

try {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage)
    chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "zs-status") render(msg); });
} catch {}

refresh();
setInterval(refresh, 2000);

// If opened as plain file:// HTML (not extension popup), show demo state
try { if (location.protocol === "file:") setTimeout(() => render({ connected:false, tools:14, servers:[] }), 100); } catch {}

async function teamAction(type) {
  const result=document.getElementById('team-result');
  const buttons=['team-join','team-start','team-stop','team-leave'].map(id=>document.getElementById(id));
  buttons.forEach(b=>b.disabled=true);result.textContent='Working…';
  try {
    const team=document.getElementById('team-name').value.trim()||'studio';
    await chrome.storage.local.set({zsTeamName:team});
    let r;
    if(type==='join' || type==='leave'){
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(!tab || !SUPPORTED_HOSTS.includes(new URL(tab.url).hostname))throw new Error('Select a supported AI chat tab first');
      r=await chrome.tabs.sendMessage(tab.id,{type:'zs-team-'+type,role:document.getElementById('team-role').value,team});
    } else r=await chrome.runtime.sendMessage({type:'team_'+type,team});
    result.textContent=r?.ok?(type==='join'?`Joined as ${r.self.role}. Join the other two roles, then Start.`:type==='leave'?'Left this tab. Rejoin with a new role when ready.':r.note||'Team stopped.'):(r?.error||'No response');
    if(r?.results?.some(x=>!x.ok))result.textContent+='\n'+r.results.filter(x=>!x.ok).map(x=>`Tab ${x.tab}: ${x.error}`).join('\n');
  }catch(e){result.textContent=String(e.message||e);}
  finally{buttons.forEach(b=>b.disabled=false);}
}
bind('team-join',()=>teamAction('join'));
bind('team-start',()=>teamAction('start'));
bind('team-stop',()=>teamAction('stop'));
bind('team-leave',()=>teamAction('leave'));
chrome.storage.local.get('zsTeamName',r=>{if(r.zsTeamName)document.getElementById('team-name').value=r.zsTeamName;});

// Shared, explicit controls for the active tab. No page text/drafts in reports.
let tabControlBusy=false;
async function tabControl(type='zs-tab-status') {
  if(tabControlBusy)return;
  tabControlBusy=true;
  const output=document.getElementById('tab-result');
  const buttons=['tab-refresh','tab-recover','tab-stop'].map(id=>document.getElementById(id));
  buttons.forEach(b=>b.disabled=true);
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab)throw new Error('No active tab found.');
    let r;
    try {r=await chrome.tabs.sendMessage(tab.id,{type});}
    catch {throw new Error('No ZeroScript adapter responding. Open a supported chat, reload the extension and refresh that tab.');}
    if(!r?.ok)throw new Error(r?.error||'No adapter response.');
    output.textContent=`${r.name} · ${r.version}\nComposer: ${r.composer?'detected':'not detected'}\nToolbar: ${r.toolbarVisible?'visible':r.toolbar?'present but hidden':'missing'}\nLoop: ${r.running?'running':r.starting?'starting':'idle'} · Model generation: ${r.generating?'detected':'not detected'}\nTeam: ${r.team.active?'active':r.team.joined?'joined, inactive':'not joined'}${r.team.role?' / '+r.team.role:''}`+(r.note?'\n'+r.note:'');
  }catch(e){output.textContent=String(e.message||e);}
  finally {tabControlBusy=false;buttons.forEach(b=>b.disabled=false);}
}
bind('tab-refresh',()=>tabControl());
bind('tab-recover',()=>tabControl('zs-recover-toolbar'));
bind('tab-stop',()=>tabControl('zs-stop-tab'));
tabControl();
