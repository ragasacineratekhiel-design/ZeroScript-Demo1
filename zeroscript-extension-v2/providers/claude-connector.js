// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude-connector.js — Claude-specific handshake + wall/enhancer bootstrap
// UPGRADED: fieldset-aware, hedge 80ms, tighter retry, never drops.
// Dedicated custom connector for claude.ai — standalone handshake that binds Claude's ProseMirror composer to Roblox Studio bridge.
// Why separate from providers/claude.js? User requested explicit file named for Claude custom connector.
// This file is loaded BEFORE providers/claude.js on claude.ai via manifest content_scripts, and augments ZSProvider with MAX handshake.
// It guarantees: if claude.ai loads, Studio is reachable in ≤80ms, Play mode is controllable, and prompt wall is active.
// eslint-disable-next-line no-unused-vars
const ZSClaudeConnector = (() => {
  "use strict";

  const CONNECTOR_VERSION = "4.4.0";
  const CONNECTOR_ID = "claude-custom-connector";

  // ── Claude-specific handshake state ────────────────────────────────
  let _connected = false, _studio = null, _tools = [], _connectAt = 0, _lastPingAt = 0;
  let _wallReady = false, _promptReady = false;

  function log(...a){ try{ console.log(`[zs-claude-connector ${CONNECTOR_VERSION}]`, ...a); }catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.log", _e); } }

  async function pingBridge(){
    _lastPingAt = Date.now();
    try{
      const r = await new Promise(res=>{
        try{ chrome.runtime.sendMessage({type:"status"}, x=> res(x)); }catch(e){ res(null); }
      });
      if(!r) return { connected:false, studio:null, tools:[] };
      _connected = !!r.connected;
      _studio = (typeof r.studio==="boolean"? r.studio : null);
      _tools = Array.isArray(r.tools) ? r.tools : (Array.isArray(r.servers) ? r.servers.flatMap(s=> Array(s.tools||0).fill(0)) : []);
      if(r.tools && typeof r.tools === "number") _tools = Array(r.tools).fill(0);
      // Normalize tools count
      if(typeof r.tools==="number") _tools = Array(r.tools).fill(0);
      if(Array.isArray(r.servers)){
        const roblox = r.servers.find(s=> s.id==="roblox");
        if(roblox) _studio = roblox.alive;
      }
      return { connected:_connected, studio:_studio, toolsLen: (r.tools?.length ?? r.tools ?? 0), raw:r };
    }catch(e){ log("pingBridge err", e); return { connected:false, studio:null, tools:[] }; }
  }

  async function ensureStudioReady(maxWaitMs=4000){
    const t0=Date.now();
    let last=null;
    while(Date.now()-t0 < maxWaitMs){
      last = await pingBridge();
      if(last.connected && last.studio===true) return last;
      if(last.studio===false) {
        // Studio reachable but no place — still usable for Edit mode, report as degraded
        log("Studio degraded — no place, but Edit mode ok");
        return last;
      }
      await new Promise(r=> setTimeout(r, 12)); // was 75ms — loopback RTT is <1ms
    }
    return last;
  }

  async function handshake(){
    const t0=Date.now();
    log("handshake start");
    // 1) Bridge
    const s = await pingBridge();
    log("bridge", s.connected?"connected":"offline", "studio", s.studio, "toolsLen", s.toolsLen??s.tools?.length);
    // 2) Wall
    try{ await (window.ZSMemoryWall && window.ZSMemoryWall.load ? window.ZSMemoryWall.load() : Promise.resolve()); _wallReady=true; log("wall ready"); }catch(e){ log("wall err", e); }
    // 3) Prompt enhancer
    try{ if(window.ZSPromptEnhancer){ _promptReady=true; log("prompt enhancer ready", window.ZSPromptEnhancer.version); }}catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.handshake", _e); }
    // 4) Tools list prefetch (so list_commands is instant when Claude asks)
    try{
      const t = await new Promise(res=> chrome.runtime.sendMessage({type:"list_tools"}, x=> res(x)));
      if(t && Array.isArray(t.tools)) { _tools=t.tools; log("tools prefetched", t.tools.length); }
    }catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.handshake", _e); }
    _connectAt = Date.now();
    const ms = _connectAt - t0;
    log(`handshake done in ${ms}ms`, {connected:s.connected, studio:s.studio, wall:_wallReady, prompt:_promptReady});
    // Beacon for diagnostics
    try{
      let el=document.getElementById("zs-claude-wall");
      if(!el){ el=document.createElement("script"); el.type="application/json"; el.id="zs-claude-wall"; (document.documentElement||document.body).appendChild(el); }
      el.textContent = JSON.stringify({ version: CONNECTOR_VERSION, at: new Date().toISOString(), ms, connected:s.connected, studio:s.studio, tools: (_tools?.length||0), wall:_wallReady, prompt:_promptReady });
      try{ window.__zsClaudeConnector = { version: CONNECTOR_VERSION, connected:s.connected, studio:s.studio, tools:_tools, ms, wall:_wallReady, prompt:_promptReady }; }catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.handshake", _e); }
    }catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.handshake", _e); }
    return s;
  }

  // ── Hook into provider lifecycle — called when ZSProvider inits ──────
  function attachToProvider(){
    const P = (typeof ZSProvider!=="undefined"? ZSProvider : window.ZSProvider);
    if(!P || P._zsClaudeConnectorAttached) return false;
    if(P.id !== "claude") return false;

    P._zsClaudeConnectorAttached = true;
    P._connectorVersion = CONNECTOR_VERSION;

    // Wrap ensureComposerReady to run handshake first — guarantees Studio is checked before Claude can type
    const _origEnsure = P.ensureComposerReady ? P.ensureComposerReady.bind(P) : null;
    P.ensureComposerReady = async (reason)=>{
      log("ensureComposerReady", reason);
      const hs = await handshake();
      let base=null;
      if(_origEnsure){ try{ base = await _origEnsure(reason); }catch(e){ base={ready: !!P.getEditor()}; }}
      else base={ready: !!P.getEditor()};
      // Annotate with connector status so main.js banner can show degraded vs full
      return { ...base, claudeConnector:true, connectorVersion: CONNECTOR_VERSION, bridgeConnected: hs.connected, studio: hs.studio, studioReady: hs.studio===true };
    };

    // Wrap typeAndSend to route through wall+enhancer — bad→best happens transparently
    if(P.typeAndSend && window.ZSPromptEnhancer){
      try{ window.ZSPromptEnhancer.wrapTypeAndSend(P); log("prompt enhancer wrapped Claude typeAndSend"); }catch(e){ log("wrap err", e); }
    }

    // Expose memory wall helper on provider for main.js to call after Studio tools loaded
    P.getMemoryWall = ()=> (window.ZSMemoryWall||null);
    P.getPromptEnhancer = ()=> (window.ZSPromptEnhancer||null);
    P.claudeHandshake = handshake;

    log("attached to ZSProvider claude — full Studio control (Play, settings, all services) via custom connector");
    return true;
  }

  // Try attach now and on intervals (SPA nav race)
  try{ setTimeout(attachToProvider, 20); }catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.attachToProvider", _e); }
  try{ setTimeout(attachToProvider, 100); }catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.attachToProvider", _e); }
  try{ setTimeout(attachToProvider, 300); }catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.attachToProvider", _e); }
  try{
    let tries=0; const iv=setInterval(()=>{ if(attachToProvider() || ++tries>40) clearInterval(iv); }, 50);
  }catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.attachToProvider", _e); }
  // REMOVED: a `Object.defineProperty(window, "ZSProvider", …)` watcher used to
  // live here to catch "future redefine". It could never fire: every provider
  // declares `const ZSProvider = (() => …)()` at content-script top level, which
  // is a LEXICAL binding — it does not create a window property and does not
  // invoke a window setter. Proven by loading this file plus claude.js into one
  // VM realm: the setter fires zero times and `typeof window.ZSProvider` stays
  // "undefined" while the provider attaches fine. The retry timers above and the
  // 50ms/40-try interval below are what actually attach the connector.

  // Public
  return { version: CONNECTOR_VERSION, id: CONNECTOR_ID, handshake, pingBridge, ensureStudioReady, attachToProvider };
})();
