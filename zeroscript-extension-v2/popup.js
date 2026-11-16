// SPDX-License-Identifier: GPL-3.0-or-later
const VERSION = "4.7.0";
const KOFI_URL = "https://ko-fi.com/sebattfg";
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "gemini.google.com", "claude.ai",
  "www.kimi.ai", "kimi.ai",
  "chat.z.ai", "z.ai", "chat.qwen.ai", "qwen.ai", "arena.ai", "lmarena.ai", "www.meta.ai", "meta.ai",
  "perplexity.ai", "www.perplexity.ai", "copilot.microsoft.com",
  "grok.com", "x.ai", "poe.com", "chat.mistral.ai", "mistral.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";
function isSupportedUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const bare = h.replace(/^www\./, "");
    return SUPPORTED_HOSTS.some((sh) => h === sh || bare === sh || bare.endsWith("." + sh));
  } catch (_e) { globalThis.ZSSafe?.seen?.("popup.isSupportedUrl", _e); return false; }
}

function safeVer() {
  try { if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) return "v" + chrome.runtime.getManifest().version; } catch (_e) { globalThis.ZSSafe?.seen?.("popup.safeVer", _e); }
  return "v" + VERSION;
}
try { document.getElementById("ver").textContent = safeVer(); } catch (_e) { globalThis.ZSSafe?.seen?.("popup.safeVer", _e); }

function render(s) {
  if (!s) return;
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  if (!dot || !state) return;
  renderFaults(s);
  const list = s.servers || [];
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
  const studioOff = mcpOk && s.studio === false;
  const ok = mcpOk && s.studio === true;
  dot.className = "dot " + (s.connected ? (ok ? "on" : "warn") : "");
  // `note` is an explicit "this reading is not live" marker (e.g. the popup was
  // opened as a plain file). Without it the offline branch below tells a user to
  // run start.py when in fact the popup could never have talked to anything.
  state.textContent = s.note
    ? s.note
    : s.connected
      ? (ok ? "Connected · Roblox Studio ready"
          : studioOff ? "Studio not connected · enable the MCP server in Studio"
          : "Bridge OK · open Roblox Studio")
      : "Bridge offline — run start.py";
  if (tools) tools.textContent = s.connected ? `${s.tools || 0} tools available` : "Run bridge.py (start.py)";
  if (servers) servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
  const roster = document.getElementById("team-roster");
  if (roster) {
    const tb = Array.isArray(s.teamBindings) ? s.teamBindings : [];
    roster.textContent = tb.length
      ? "Bound tabs: " + tb.map((b) => `${b.role}=${b.name}`).join(" · ")
      : "";
  }
}

function renderFaults(s) {
  const el = document.getElementById("faults");
  if (!el) return;
  const n = (s && s.faults) || 0;
  if (!n) { el.style.display = "none"; el.textContent = ""; return; }
  const sites = (s.faultSites || []).join(", ");
  el.style.display = "block";
  el.textContent = "⚠ " + n + " error" + (n === 1 ? "" : "s") + " recorded" + (sites ? ": " + sites : "");
  el.onclick = () => {
    try {
      chrome.runtime.sendMessage({ type: "zs_faults" }, (r) => {
        const diag = JSON.stringify({ status: s, faults: r && r.faults, safe: r && r.safe }, null, 2);
        try { navigator.clipboard.writeText(diag).then(()=>{el.textContent="✓ diagnostics copied";}).catch(()=>{el.textContent="⚠ copy failed";}); }
        catch (_e) { globalThis.ZSSafe?.seen?.("popup.sites", _e); el.textContent = "⚠ copy failed"; }
      });
    } catch (_e) { globalThis.ZSSafe?.seen?.("popup.sites", _e); }
  };
}


function refresh() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      render({ connected: false, tools: 0, servers: [] });
      return;
    }
    chrome.runtime.sendMessage({ type: "status" }, (s) => s && render(s));
  } catch (_e) { globalThis.ZSSafe?.seen?.("popup.refresh", _e); render({ connected: false, tools: 0, servers: [] }); }
}

function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", fn);
}

bind("reconnect", () => {
  try { chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600)); } catch (_e) { globalThis.ZSSafe?.seen?.("popup.bind", _e); }
});
bind("restart", (e) => {
  const t = e.target; t.textContent = "Restarting…";
  try { chrome.runtime.sendMessage({ type: "restart_mcp" }, () => { t.textContent = "⟳ Restart Roblox server"; setTimeout(refresh, 600); }); } catch (_e) { globalThis.ZSSafe?.seen?.("popup.restart", _e); t.textContent = "⟳ Restart Roblox server"; }
});
bind("kofi", () => { try { chrome.tabs.create({ url: KOFI_URL }); } catch (_e) { globalThis.ZSSafe?.seen?.("popup.kofi", _e); window.open(KOFI_URL, "_blank"); } });
bind("settings", () => {
  try {
    if (typeof chrome === "undefined" || !chrome.tabs) { window.open(DEFAULT_AI_URL, "_blank"); return; }
    chrome.tabs.query({}, (tabs) => {
      const active = tabs.find((t) => t.active && t.url && isSupportedUrl(t.url));
      const anySupported = active || tabs.find((t) => t.url && isSupportedUrl(t.url));
      if (anySupported) {
        chrome.tabs.sendMessage(anySupported.id, { type: "zs-open-menu" });
        chrome.tabs.update(anySupported.id, { active: true });
      } else {
        chrome.tabs.create({ url: DEFAULT_AI_URL });
      }
    });
  } catch (_e) { globalThis.ZSSafe?.seen?.("popup.settings", _e); window.open(DEFAULT_AI_URL, "_blank"); }
});

try {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage)
    chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "zs-status") render(msg); else if (msg && msg.type === "zs-team-status") { refresh(); tabControl().catch(() => {}); } });
} catch (_e) { globalThis.ZSSafe?.seen?.("popup.bind", _e); }

// ── refresh cadence (4.7.0) ────────────────────────────────────────────────
// 4.6.0 polled `refresh()` every 2 s unconditionally. Three problems:
//   1. the popup already receives pushed `zs-status` frames from background.js
//      (the listener above), so the poll usually re-fetched identical state;
//   2. a 2 s timer kept a suspended popup doing work while it was hidden
//      (a popup is destroyed when it closes, but not while its window is
//      behind another one);
//   3. the very first paint waited for the timer only if the push was missed.
// Now: refresh once on open, then a SLOW safety poll that is skipped while the
// document is hidden and resumes the moment it is shown again.
const SLOW_POLL_MS = 8000;
let refreshTimer = 0;

function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    refresh();
  }, SLOW_POLL_MS);
}

refresh();
scheduleRefresh();
try {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();      // catch up immediately on return
  });
} catch (_e) { globalThis.ZSSafe?.seen?.("popup.visibility", _e); }
window.addEventListener("pagehide", () => clearInterval(refreshTimer), { once: true });

// Opened as plain file:// HTML (not an extension popup) there is no `chrome`
// runtime, so nothing can be measured. 4.6.0 rendered `tools: 14` here — a
// fabricated number in a diagnostic panel, which is worse than showing nothing
// because it looks like a real reading. Show an explicit not-connected state.
try {
  if (location.protocol === "file:") {
    render({ connected: false, tools: 0, servers: [], demo: false, note: "opened outside the extension — no live status available" });
  }
} catch (_e) { globalThis.ZSSafe?.seen?.("popup.bind", _e); }

async function teamAction(type) {
  const result=document.getElementById('team-result');
  const buttons=['team-join','team-start','team-stop','team-leave'].map(id=>document.getElementById(id));
  buttons.forEach(b=>b.disabled=true);result.textContent='Working…';
  try {
    const team=document.getElementById('team-name').value.trim()||'studio';
    await chrome.storage?.local?.set?.({zsTeamName:team});
    let r;
    if(type==='join' || type==='leave'){
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(!tab || !isSupportedUrl(tab.url))throw new Error('Select a supported AI chat tab first');
      r=await chrome.tabs.sendMessage(tab.id,{type:'zs-team-'+type,role:document.getElementById('team-role').value,team});
    } else r=await new Promise(resolve=>chrome.runtime.sendMessage({type:'team_'+type,team},resolve));
    const joinedRole=r?.self?.role||document.getElementById('team-role').value;
    result.textContent=r?.ok?(type==='join'?`Joined as ${joinedRole}. Join the other two roles, then Start.`:type==='leave'?'Left this tab. Rejoin with a new role when ready.':r.note||r.phrase||'Team stopped.'):(r?.error||'No response');
    if(r?.results?.some(x=>!x.ok))result.textContent+='\n'+r.results.filter(x=>!x.ok).map(x=>`Tab ${x.tab}: ${x.error}`).join('\n');
  }catch(e){result.textContent=String(e.message||e);}
  finally{buttons.forEach(b=>b.disabled=false);}
}
bind('team-join',()=>teamAction('join'));
bind('team-start',()=>teamAction('start'));
bind('team-stop',()=>teamAction('stop'));
bind('team-leave',()=>teamAction('leave'));
chrome.storage?.local?.get?.('zsTeamName',r=>{if(r&&r.zsTeamName)document.getElementById('team-name').value=r.zsTeamName;});

// Shared, explicit controls for the active tab. No page text/drafts in reports.
async function tabRequest(tabId,type,timeout=5000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(()=>chrome.tabs.sendMessage(tabId,{type})),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Tab did not respond in time. No automatic retry; a requested action may still complete. Bring the tab forward and refresh status.')),timeout);})
    ]);
  }finally{clearTimeout(timer);}
}
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
    try {r=await tabRequest(tab.id,type);}
    catch(e) {if(String(e.message||e).includes('No automatic retry'))throw e;throw new Error('No ZeroScript adapter responding. Open a supported chat, reload the extension and refresh that tab.');}
    if(!r?.ok)throw new Error(r?.error||'No adapter response.');
    const mutLabel=r.team?.role?(r.team.can_mutate?'mutates Studio':'read-only'):'';
    const commLabel=r.team?.active?(r.team.communication_confirmed?' · verified peer link':' · awaiting ack'):'';
    output.textContent=`${r.name} · ${r.version}\nComposer: ${r.composer?'detected':'not detected'}\nToolbar: ${r.toolbarVisible?'visible':r.toolbar?'present but hidden':'missing'}\nLoop: ${r.running?'running':r.starting?'starting':'idle'} · Model generation: ${r.generating?'detected':'not detected'}\nTeam: ${r.team.active?'active':r.team.joined?'joined, inactive':'not joined'}${r.team.role?' / '+r.team.role+(mutLabel?' ('+mutLabel+')':''):''}${commLabel}`+`\nPage: ${r.background?'background (may be throttled)':'foreground'}${r.draftPresent?' · draft present; automatic sends wait':''}\nChecked: ${new Date().toLocaleTimeString()}`+(r.note?'\n'+r.note:'');
  }catch(e){output.textContent=String(e.message||e);}
  finally {tabControlBusy=false;buttons.forEach(b=>b.disabled=false);}
}
bind('tab-refresh',()=>tabControl());
bind('tab-recover',()=>tabControl('zs-recover-toolbar'));
bind('tab-stop',()=>tabControl('zs-stop-tab'));
tabControl().catch(console.error);
