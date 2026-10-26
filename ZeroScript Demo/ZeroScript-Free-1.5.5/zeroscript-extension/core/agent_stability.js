// SPDX-License-Identifier: GPL-3.0-or-later
// core/agent_stability.js — ZeroScript Agent Super-Stability Layer v2.2.0 ULTRA+
// Makes ALL 8 agents (DeepSeek, ChatGPT, Gemini, Kimi, GLM, Qwen, Arena, Meta)
// super compatible, never lose connections, super stable during Roblox Studio.
// Logic-only upgrade: no GUI/text changes.
// Provides hardened wrappers + auto-patcher for every provider.
// eslint-disable-next-line no-unused-vars
const ZSAgentStability = (() => {
  "use strict";
  function makeEditorHelper(getEditorFn, fallbacks = []) {
    let lastGood = null, lastGoodAt = 0;
    return function hardenedGetEditor() {
      const now = Date.now();
      if (lastGood && now - lastGoodAt < 5000 && document.contains(lastGood)) return lastGood;
      let ed = null;
      try { ed = getEditorFn(); } catch {}
      if (ed && document.contains(ed)) { lastGood = ed; lastGoodAt = now; return ed; }
      for (const sel of fallbacks) {
        try {
          const cand = document.querySelector(sel);
          if (cand && document.contains(cand) && cand.offsetParent !== null) { lastGood = cand; lastGoodAt = now; return cand; }
        } catch {}
      }
      try {
        const cands = [...document.querySelectorAll("textarea, [contenteditable=true], [role=textbox]")];
        for (const c of cands) if (c.offsetParent !== null && !c.closest("#zs-root")) { lastGood = c; lastGoodAt = now; return c; }
      } catch {}
      return ed || lastGood || null;
    };
  }
  function makeGenerationHelper(isGeneratingFn, opts = {}) {
    const { idleMs = 1200, streamCheck = null } = opts;
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
        } catch {}
      }
      if (gen) lastGenTrueAt = Date.now();
      return gen;
    };
  }
  async function hardenedSend(typeAndSendFn, text, images, maxRetries = 3) {
    let lastErr = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        await typeAndSendFn(text, images);
        await new Promise(r => setTimeout(r, 300));
        return true;
      } catch (e) { lastErr = e; }
      await new Promise(r => setTimeout(r, 200 * (i+1)));
      if (i === maxRetries - 2 && text && text.length < 50000) {
        try { await navigator.clipboard.writeText(text); document.execCommand("paste"); } catch {}
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
          if (Date.now() - dropSince > 5000 && onStudioDrop) try { onStudioDrop(s); } catch {}
          try { diag("studio.drop", {studio, since: Date.now()-dropSince}); } catch {}
        } else if (studio === true) { dropSince = 0; lastStudio = true; }
        if (studio !== null) lastStudio = studio;
      } catch {}
    }, 3000);
    return () => clearInterval(iv);
  }
  function startKeepalive(getEditor) {
    const iv = setInterval(() => {
      try { chrome.runtime.sendMessage({type:"ping"}, ()=>{}); } catch {}
      try { if (getEditor && document.hasFocus()) { /* keep session alive */ } } catch {}
      // also touch bridge status to keep service worker alive (MV3 sleep guard)
      try { chrome.runtime.sendMessage({type:"status"}, ()=>{}); } catch {}
    }, 20000); // v2.2: tighter 20s keepalive for never-lose-connection
    return () => clearInterval(iv);
  }
  function installVisibilityHandler(onVisible, onHidden) {
    const h = () => { if (document.hidden) try { onHidden && onHidden(); } catch {} else try { onVisible && onVisible(); } catch {} };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }
  const FALLBACKS = {
    deepseek: ["textarea", "[data-testid=composer-input]", "[role=textbox]", "div[contenteditable]"],
    chatgpt: ["#prompt-textarea", "[data-testid=prompt-textarea]", "[contenteditable=true]", "div.ProseMirror", "div[data-lexical-editor]"],
    gemini: [".ql-editor", "[contenteditable=true]", "textarea", "div[role=textbox]", "rich-textarea"],
    kimi: [".chat-input-editor", "[data-lexical-editor]", "[contenteditable=true]", "textarea"],
    glm: ["#chat-input", "textarea", "[contenteditable=true]", "div[role=textbox]"],
    qwen: [".message-input-textarea", "textarea", "[contenteditable=true]", ".qwen-composer-editor"],
    meta: ["[data-testid=composer-input]", "textarea", "[contenteditable=true]", "div[contenteditable]"],
    arena: ["textarea", "form textarea", "[contenteditable=true]", "div[role=textbox]"],
  };

  // Auto-patcher: wraps ZSProvider after it loads to make every agent super stable
  // without editing each provider file. Handles editor rediscovery, gen voting,
  // keepalive, studio monitor, visibility pause/resume.
  let _patched = false;
  function tryPatch() {
    if (_patched) return true;
    const P = (typeof ZSProvider !== "undefined" ? ZSProvider : (typeof window !== "undefined" && window.ZSProvider) ? window.ZSProvider : null);
    if (!P || !P.getEditor || !P.isGenerating) return false;
    try {
      // Harden getEditor with fallbacks based on provider id
      const origGetEditor = P.getEditor.bind(P);
      const fb = FALLBACKS[P.id] || FALLBACKS.deepseek;
      const hardGet = makeEditorHelper(origGetEditor, fb);
      P.getEditor = hardGet;
      // Also harden editorText to use hardened editor
      if (P.editorText) {
        const origET = P.editorText.bind(P);
        P.editorText = function() { try { return origET(); } catch { const e = hardGet(); return e ? (e.value||e.textContent||"") : ""; } };
      }
      // Harden isGenerating with stream voting
      const origGen = P.isGenerating.bind(P);
      const streamCheck = P.streamLen ? (()=>{ try { const la=P.lastAssistant(); return la? P.streamLen(la):0; } catch { return 0; } }) : null;
      P.isGenerating = makeGenerationHelper(origGen, { idleMs: 1100, streamCheck });

      // Add keepalive + studio monitor once per provider
      if (!P._zsStabilityPatched) {
        P._zsStabilityPatched = true;
        // keepalive every 25s
        const stopKA = startKeepalive(hardGet);
        // studio monitor
        const stopMon = startStudioMonitor(()=>{}, (s)=>{
          // if Studio drops, trigger provider-friendly recovery: log + keep connection
          try { console.log("[zs-stability] Studio dropped, keeping agent alive", s); } catch {}
        });
        // visibility handler: pause heavy ops when hidden, resume when visible
        installVisibilityHandler(()=>{ try { P._wasHidden=false; } catch {} }, ()=>{ try { P._wasHidden=true; } catch {} });
        // Store cleaners for potential cleanup
        P._zsKeepaliveStop = stopKA;
        P._zsStudioMonStop = stopMon;
        // Enhanced init wrapper: preserve original init but add beacon
        if (P.init) {
          const origInit = P.init;
          P.init = function(opts){ try { origInit.call(P, opts); } catch(e){ try{ diag("stability.init",{err:String(e)});}catch{} } };
        }
      }
      _patched = true;
      try { console.log("[zs-stability] hardened provider", P.id); } catch {}
      return true;
    } catch(e){ try{ console.log("[zs-stability] patch failed", e);}catch{} return false; }
  }
  // Try immediately and on intervals for SPA navigations
  try { setTimeout(tryPatch, 50); } catch {}
  try { setTimeout(tryPatch, 400); } catch {}
  try { setTimeout(tryPatch, 1200); } catch {}
  try {
    let tries=0;
    const iv=setInterval(()=>{ if (tryPatch() || ++tries>40) clearInterval(iv); }, 200);
  } catch {}
  // Also hook provider init if it happens later: wrap future ZSProvider assignments
  try {
    let _ZS = typeof ZSProvider !== "undefined" ? ZSProvider : null;
    if (typeof Object.defineProperty === "function" && typeof window !== "undefined") {
      // watch window.ZSProvider define
      let watched = window.ZSProvider;
      Object.defineProperty(window, "ZSProvider", {
        get(){ return watched; },
        set(v){ watched = v; _patched=false; setTimeout(tryPatch, 30); return true; },
        configurable: true
      });
      if (_ZS) watched=_ZS;
    }
  } catch {}

  return { makeEditorHelper, makeGenerationHelper, hardenedSend, startStudioMonitor, startKeepalive, installVisibilityHandler, FALLBACKS, tryPatch };
})();
