// SPDX-License-Identifier: GPL-3.0-or-later
// core/agent_stability.js — ZeroScript MAX Agent Stability Layer v3.0.0 MAX
// Makes ALL 14 agents (DeepSeek, ChatGPT, Gemini, Claude MAX, Kimi, GLM, Qwen, Arena, Meta, Perplexity, Copilot, Grok, Poe, Mistral)
// super compatible, never lose connections, super stable during Roblox Studio at MAX speed.
// Logic-only upgrade: no GUI/text changes. MAX hedging.
// eslint-disable-next-line no-unused-vars
const ZSAgentStability = (() => {
  "use strict";
  function makeEditorHelper(getEditorFn, fallbacks = []) {
    let lastGood = null, lastGoodAt = 0;
    return function hardenedGetEditor() {
      const now = Date.now();
      if (lastGood && now - lastGoodAt < 3000 && document.contains(lastGood)) return lastGood; // MAX 3s tighter
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
    const { idleMs = 900, streamCheck = null } = opts; // MAX 900ms tighter
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
  async function hardenedSend(typeAndSendFn, text, images, maxRetries = 5) { // MAX 5
    let lastErr = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        await typeAndSendFn(text, images);
        await new Promise(r => setTimeout(r, 200)); // MAX faster verify
        return true;
      } catch (e) { lastErr = e; }
      await new Promise(r => setTimeout(r, 120 * (i+1))); // MAX faster backoff
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
          if (Date.now() - dropSince > 3000 && onStudioDrop) try { onStudioDrop(s); } catch {} // MAX 3s faster
          try { diag("studio.drop", {studio, since: Date.now()-dropSince}); } catch {}
        } else if (studio === true) { dropSince = 0; lastStudio = true; }
        if (studio !== null) lastStudio = studio;
      } catch {}
    }, 1800); // MAX 1.8s poll
    return () => clearInterval(iv);
  }
  function startKeepalive(getEditor) {
    const iv = setInterval(() => {
      try { chrome.runtime.sendMessage({type:"ping"}, ()=>{}); } catch {}
      try { if (getEditor && document.hasFocus()) { /* keep alive */ } } catch {}
      try { chrome.runtime.sendMessage({type:"status"}, ()=>{}); } catch {}
    }, 12000); // MAX 12s keepalive
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
    claude: ["div[contenteditable='true']", "div.ProseMirror", "div[data-placeholder]", "textarea", "[role=textbox]"], // MAX Claude
    gemini: [".ql-editor", "[contenteditable=true]", "textarea", "div[role=textbox]", "rich-textarea"],
    kimi: [".chat-input-editor", "[data-lexical-editor]", "[contenteditable=true]", "textarea"],
    glm: ["#chat-input", "textarea", "[contenteditable=true]", "div[role=textbox]"],
    qwen: [".message-input-textarea", "textarea", "[contenteditable=true]", ".qwen-composer-editor"],
    meta: ["[data-testid=composer-input]", "textarea", "[contenteditable=true]", "div[contenteditable]"],
    arena: ["textarea", "form textarea", "[contenteditable=true]", "div[role=textbox]"],
    generic: ["textarea", "[contenteditable=true]", "[role=textbox]", "div.ProseMirror", "div[contenteditable]"],
  };

  let _patched = false;
  function tryPatch() {
    if (_patched) return true;
    const P = (typeof ZSProvider !== "undefined" ? ZSProvider : (typeof window !== "undefined" && window.ZSProvider) ? window.ZSProvider : null);
    if (!P || !P.getEditor || !P.isGenerating) return false;
    try {
      const origGetEditor = P.getEditor.bind(P);
      const fb = FALLBACKS[P.id] || FALLBACKS.deepseek;
      const hardGet = makeEditorHelper(origGetEditor, fb);
      P.getEditor = hardGet;
      if (P.editorText) {
        const origET = P.editorText.bind(P);
        P.editorText = function() { try { return origET(); } catch { const e = hardGet(); return e ? (e.value||e.textContent||"") : ""; } };
      }
      const origGen = P.isGenerating.bind(P);
      const streamCheck = P.streamLen ? (()=>{ try { const la=P.lastAssistant(); return la? P.streamLen(la):0; } catch { return 0; } }) : null;
      P.isGenerating = makeGenerationHelper(origGen, { idleMs: 900, streamCheck });

      if (!P._zsStabilityPatched) {
        P._zsStabilityPatched = true;
        const stopKA = startKeepalive(hardGet);
        const stopMon = startStudioMonitor(()=>{}, (s)=>{
          try { console.log("[zs-max] Studio dropped, keeping MAX alive", s); } catch {}
        });
        installVisibilityHandler(()=>{ try { P._wasHidden=false; } catch {} }, ()=>{ try { P._wasHidden=true; } catch {} });
        P._zsKeepaliveStop = stopKA;
        P._zsStudioMonStop = stopMon;
        if (P.init) {
          const origInit = P.init;
          P.init = function(opts){ try { origInit.call(P, opts); } catch(e){ try{ diag("stability.init",{err:String(e)});}catch{} } };
        }
      }
      _patched = true;
      try { console.log("[zs-max] hardened provider", P.id, "MAX"); } catch {}
      return true;
    } catch(e){ try{ console.log("[zs-max] patch failed", e);}catch{} return false; }
  }
  try { setTimeout(tryPatch, 50); } catch {}
  try { setTimeout(tryPatch, 300); } catch {}
  try { setTimeout(tryPatch, 800); } catch {}
  try {
    let tries=0;
    const iv=setInterval(()=>{ if (tryPatch() || ++tries>40) clearInterval(iv); }, 180);
  } catch {}
  try {
    let _ZS = typeof ZSProvider !== "undefined" ? ZSProvider : null;
    if (typeof Object.defineProperty === "function" && typeof window !== "undefined") {
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
