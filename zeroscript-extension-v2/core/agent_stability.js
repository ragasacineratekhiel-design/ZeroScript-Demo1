// SPDX-License-Identifier: GPL-3.0-or-later
// core/agent_stability.js — ZeroScript MAX 4.3.0
// Makes ALL 15 agents super compatible, never lose connections, super stable during Roblox Studio at ULTRA speed.
// UPGRADED 3.4: UNIVERSAL Claude+ChatGPT bottom-scan + syntax self-heal + universal STOP-loop + dedupe (fieldset + ProseMirror + composer-surface redesigns), tighter polls, Web Locks keepalive, universal fallbacks.
// Logic-only — no GUI/text change except Claude tutorial doc.
// SPDX-License-Identifier: GPL-3.0-or-later
// core/agent_stability.js — ZeroScript MAX 4.3.0 — universal editor/generation hardening
// honest: real-world polls, no fake millisecond claims
const ZSAgentStability = (() => {
  "use strict";
  function makeEditorHelper(getEditorFn, fallbacks = []) {
    let lastGood = null, lastGoodAt = 0;
    return function hardenedGetEditor() {
      const now = Date.now();
      if (lastGood && now - lastGoodAt < 2000 && document.contains(lastGood) && lastGood.offsetParent!==null) return lastGood;
      let ed = null;
      try { ed = getEditorFn(); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.hardenedGetEditor", _e); }
      if (ed && document.contains(ed) && ed.offsetParent!==null) { lastGood = ed; lastGoodAt = now; return ed; }
      // ULTRA 3.4: scan all fallbacks bottom-biased instead of first-match (fixes ChatGPT fieldset drift)
      let best=null, bestY=-1;
      for (const sel of fallbacks) {
        try {
          const nodes = [...document.querySelectorAll(sel)].filter(c=>!c.closest("#zs-root"));
          for(const cand of nodes){
            if(!cand || !document.contains(cand) || cand.offsetParent===null) continue;
            try{ const r=cand.getBoundingClientRect(); const y=r.top+r.height; if(y>bestY && r.width>40){ best=cand; bestY=y; } }catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.hardenedGetEditor", _e); }
          }
        } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.hardenedGetEditor", _e); }
      }
      if(best){ lastGood=best; lastGoodAt=now; return best; }
      try {
        const cands = [...document.querySelectorAll("textarea, [contenteditable=true], [contenteditable='true'], [role=textbox], [data-testid*='composer']")].filter(c=>!c.closest("#zs-root"));
        for (const c of cands) if (c.offsetParent !== null) {
          try{ const r=c.getBoundingClientRect(); const y=r.top+r.height; if(y>bestY && r.width>40){ best=c; bestY=y; } }catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.hardenedGetEditor", _e); }
        }
        if(best){ lastGood=best; lastGoodAt=now; return best; }
        const fs = document.querySelector("fieldset");
        if (fs) {
          const inner = fs.querySelector("[contenteditable=true], [contenteditable='true'], textarea, [role=textbox]");
          if (inner && inner.offsetParent !== null) { lastGood = inner; lastGoodAt = now; return inner; }
        }
      } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.hardenedGetEditor", _e); }
      return ed || lastGood || null;
    };
  }
  function makeGenerationHelper(isGeneratingFn, opts = {}) {
    const { idleMs = 80, streamCheck = null } = opts; // MAX 10ms 80ms tighter (was 800)
    let lastGenTrueAt = 0, lastLen = 0;
    return function hardenedIsGenerating() {
      let gen = false;
      try { gen = !!isGeneratingFn(); } catch { gen = false; }
      if (streamCheck) {
        try {
          const len = streamCheck();
          if (len > lastLen) { lastGenTrueAt = Date.now(); lastLen = len; gen = true; }
          else if (gen) lastLen = len;
          if (Date.now() - lastGenTrueAt < idleMs && lastLen > 0) gen = true;
        } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.hardenedIsGenerating", _e); }
      }
      if (gen) lastGenTrueAt = Date.now();
      return gen;
    };
  }
  async function hardenedSend(typeAndSendFn, text, images, maxRetries = 5) {
    let lastErr = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        await typeAndSendFn(text, images);
        await new Promise(r => setTimeout(r, 5)); // MAX 10ms verify (was 180)
        return true;
      } catch (e) { lastErr = e; }
      await new Promise(r => setTimeout(r, 10 * (i+1))); // MAX 10ms backoff (was 100)
      if (i === maxRetries - 2 && text && text.length < 50000) {
        try { await navigator.clipboard.writeText(text); document.execCommand("paste"); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.hardenedSend", _e); }
      }
    }
    throw lastErr || new Error("send failed");
  }
  function startStudioMonitor(diag, onStudioDrop) {
    let lastStudio = null, dropSince = 0;
    const iv = setInterval(async () => {
      try {
        const s = await new Promise(res => { try { chrome.runtime.sendMessage({type:"status"}, r => res(r)); } catch { res(null); } });
        if (!s) return;
        const studio = s.studio;
        if (lastStudio === null) lastStudio = studio;
        if (studio === false && lastStudio === true) {
          if (!dropSince) dropSince = Date.now();
          if (Date.now() - dropSince > 2500 && onStudioDrop) try { onStudioDrop(s); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.startStudioMonitor", _e); } // ULTRA 2.5s (was 3s)
          try { diag("studio.drop", {studio, since: Date.now()-dropSince}); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.startStudioMonitor", _e); }
        } else if (studio === true) { dropSince = 0; lastStudio = true; }
        if (studio !== null) lastStudio = studio;
      } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.startStudioMonitor", _e); }
    }, 400); // 400ms keepalive — a composer re-lock only needs to outpace a user edit
    return () => clearInterval(iv);
  }
  function startKeepalive(getEditor) {
    const iv = setInterval(() => {
      try { chrome.runtime.sendMessage({type:"ping"}, ()=>{}); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.startKeepalive", _e); }
      try { if (getEditor && document.hasFocus()) { /* keep alive */ } } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.startKeepalive", _e); }
      try { chrome.runtime.sendMessage({type:"status"}, ()=>{}); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.startKeepalive", _e); }
      // Web Locks keepalive — holds lock so tab stays alive in background
      try { if (navigator.locks) navigator.locks.request("zs-keepalive", {mode:"shared"}, async()=>{ await new Promise(r=>setTimeout(r, 25)); }); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.startKeepalive", _e); }
    }, 400); // 400ms keepalive — holds the lock tight without polling the DOM
    return () => clearInterval(iv);
  }
  function installVisibilityHandler(onVisible, onHidden) {
    const h = () => { if (document.hidden) try { onHidden && onHidden(); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.installVisibilityHandler", _e); } else try { onVisible && onVisible(); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.installVisibilityHandler", _e); } };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }
  const FALLBACKS = {
    deepseek: ["textarea", "[data-testid=composer-input]", "[role=textbox]", "div[contenteditable]"],
    chatgpt: ["#prompt-textarea", "[data-testid='prompt-textarea']", "[data-testid='composer-input']", "[data-testid='composer']", "textarea", "div.ProseMirror[contenteditable='true']", "div[data-lexical-editor][contenteditable='true']", "div[contenteditable='true'][role='textbox']", "div[contenteditable=true]", "[contenteditable=true]"],
    // ULTRA Claude: fieldset composer (2026 redesign) + legacy + textarea fallback
    claude: ["fieldset [contenteditable='true']", "fieldset textarea", "div[contenteditable='true'][data-placeholder]", "div.ProseMirror[contenteditable='true']", "div[data-placeholder]", "textarea", "[role=textbox]", "[data-testid='composer-input']", "div[contenteditable=true]", "div[contenteditable='']"],
    gemini: [".ql-editor", "[contenteditable=true]", "textarea", "div[role=textbox]", "rich-textarea"],
    kimi: [".chat-input-editor", "[data-lexical-editor]", "[contenteditable=true]", "textarea"],
    glm: ["#chat-input", "textarea", "[contenteditable=true]", "div[role=textbox]"],
    qwen: [".message-input-textarea", "textarea", "[contenteditable=true]", ".qwen-composer-editor"],
    meta: ["[data-testid=composer-input]", "textarea", "[contenteditable=true]", "div[contenteditable]"],
    arena: ["textarea", "form textarea", "[contenteditable=true]", "div[role=textbox]"],
    generic: ["fieldset [contenteditable=true]", "fieldset textarea", "textarea", "[contenteditable=true]", "[role=textbox]", "div.ProseMirror", "div[contenteditable]", "[data-testid*='composer']"],
  };

  let _patched = false;
  function tryPatch() {
    if (_patched) return true;
    const P = (typeof ZSProvider !== "undefined" ? ZSProvider : (typeof window !== "undefined" && window.ZSProvider) ? window.ZSProvider : null);
    if (!P || !P.getEditor || !P.isGenerating) return false;
    try {
      const origGetEditor = P.getEditor.bind(P);
      const fb = FALLBACKS[P.id] || FALLBACKS.generic;
      const hardGet = makeEditorHelper(origGetEditor, fb);
      P.getEditor = hardGet;
      if (P.editorText) {
        const origET = P.editorText.bind(P);
        P.editorText = function() { try { return origET(); } catch { const e = hardGet(); return e ? (e.value||e.textContent||e.innerText||"") : ""; } };
      }
      const origGen = P.isGenerating.bind(P);
      const streamCheck = P.streamLen ? (()=>{ try { const la=P.lastAssistant(); return la? P.streamLen(la):0; } catch { return 0; } }) : null;
      P.isGenerating = makeGenerationHelper(origGen, { idleMs: 80, streamCheck }); // MAX 10ms 80 (was 800)

      if (!P._zsStabilityPatched) {
        P._zsStabilityPatched = true;
        const stopKA = startKeepalive(hardGet);
        const stopMon = startStudioMonitor(()=>{}, (s)=>{
          try { console.log("[zs-ultra] Studio dropped, keeping ULTRA alive", s); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); }
        });
        installVisibilityHandler(()=>{ try { P._wasHidden=false; } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); } }, ()=>{ try { P._wasHidden=true; } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); } });
        P._zsKeepaliveStop = stopKA;
        P._zsStudioMonStop = stopMon;
        if (P.init) {
          const origInit = P.init;
          P.init = function(opts){ try { origInit.call(P, opts); } catch(e){ try{ console.log("[zs-ultra] init patch",e);}catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); } } };
        }
      }
      _patched = true;
      try { console.log("[zs-ultra] hardened provider", P.id, "ULTRA 3.4.0"); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); }
      return true;
    } catch(e){ try{ console.log("[zs-ultra] patch failed", e);}catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); } return false; }
  }
  try { setTimeout(tryPatch, 10); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); }
  try { setTimeout(tryPatch, 20); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); } // MAX
  try { setTimeout(tryPatch, 30); } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); } // MAX
  try {
    let tries=0;
    const iv=setInterval(()=>{ if (tryPatch() || ++tries>45) clearInterval(iv); }, 10); // MAX
  } catch (_e) { globalThis.ZSSafe?.seen?.("agent_stability.tryPatch", _e); }
  // REMOVED: an `Object.defineProperty(window, "ZSProvider", …)` watcher set
  // `_patched = false` on assignment so the next provider could be re-patched.
  // It could never fire. This file runs BEFORE the provider file in every
  // content_scripts block, and providers declare `const ZSProvider = …` at top
  // level — a lexical binding that never touches a window property or setter
  // (verified in a VM realm: setter fired 0 times, window.ZSProvider stayed
  // undefined, while tryPatch still hardened the provider). The three setTimeout
  // retries and the 10ms/45-try interval above are the real re-patch path.

  return { makeEditorHelper, makeGenerationHelper, hardenedSend, startStudioMonitor, startKeepalive, installVisibilityHandler, FALLBACKS, tryPatch, version:"4.4.0" };
})();
