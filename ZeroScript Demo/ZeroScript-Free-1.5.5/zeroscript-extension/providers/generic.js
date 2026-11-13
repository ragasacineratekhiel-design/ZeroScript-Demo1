// SPDX-License-Identifier: GPL-3.0-or-later
// providers/generic.js — universal provider fallback (the thin providers/*.js alias this)
// Works on ANY chat AI site (Perplexity, Copilot, Grok, Poe, Mistral, etc.)
// UPGRADED: fieldset composer 2026, better message detection, tighter timings, never-drops.
// Specific providers (perplexity.js etc) thin-wrap this with custom names.
const ZSGenericProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let diag = () => {};
  let _displayName = "AI";
  let _id = "generic";

  // ── HONEST FIX (audit #9) ─────────────────────────────────────────────────
  // The five "thin" providers used to call `setMeta()` on the SHARED generic
  // object, mutating closure state (`_id`, `_displayName`). Whichever provider
  // file ran last won the identity for the whole page, so e.g. copilot.js could
  // end up announcing itself as "Poe". `makeMeta` returns a fresh, immutable
  // identity and is what every alias must use now; `setMeta` is kept for
  // back-compat but only affects this singleton.
  function makeMeta(id, displayName) { return Object.freeze({ id: String(id), displayName: String(displayName) }); }
  function setMeta(id, displayName) { _id = id; _displayName = displayName; }

  // ULTRA timings — slightly tighter for instant response
  const timings = {
    GEN_IDLE_MS: 1600, // was 2000
    REASON_IDLE_MS: 6000,
    WARMUP_MS: 20000, // was 40000
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 3000, // was 7000
    RESPONSE_TIMEOUT_MS: 180000,
  };

  const textWithout = (root, excludeSel) => {
    if (!root) return "";
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (excludeSel && n.matches && n.matches(excludeSel)) return;
      if (n.matches && n.matches(".zs-chip")) return;
      if(n.tagName==='BR'){t+='\n';return;}
      const block=/^(P|DIV|PRE|LI|SECTION|ARTICLE|TR|H[1-6])$/.test(n.tagName);
      if(block && t && !t.endsWith('\n'))t+='\n';
      for (const c of n.childNodes) walk(c);
      if(block && !t.endsWith('\n'))t+='\n';
    };
    walk(root);
    return t;
  };

  function allMessages() {
    const selectors = [
      "[data-message-id]", "[data-testid*='message']", "[data-test*='message']",
      "[data-message-author-role]", "[data-is-user-message]",
      "[role='article']", "[class*='message-']", "div[class*='conversation'] > div",
      "main div[class*='group']", "main ol > li", "main ol > div"
    ];
    for (const sel of selectors) {
      const els = [...document.querySelectorAll(sel)].filter(e => !e.closest("#zs-root") && (e.innerText||"").trim().length > 15);
      if (els.length >= 2) return els;
    }
    const main = document.querySelector("main, [role='main'], #__next, .conversation-container, [data-testid='conversation']");
    if (main) {
      const kids = [...main.querySelectorAll("div")].filter(d => !d.closest("#zs-root") && (d.innerText||"").trim().length > 30 && d.children.length < 8);
      if (kids.length) return kids.slice(-30);
    }
    return [];
  }

  const isUserItem = (el) => {
    if (!el) return false;
    if (el.matches("[data-is-user='true'], [data-author='user'], [class*='user-message'], [data-is-user-message='true'], [data-message-author-role='user']")) return true;
    if (el.matches("[data-is-user='false'], [data-author='assistant'], [data-is-user-message='false'], [data-message-author-role='assistant']")) return false;
    return false;
  };
  const isAssistantItem = (el) => !!el && el.matches("[data-is-user='false'], [data-author='assistant'], [data-is-user-message='false'], [data-message-author-role='assistant'], [class*='assistant-message']");
  const allItems = () => allMessages();
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => { const a = assistantItems(); return a.length ? a[a.length-1] : null; };
  const _idMap = new WeakMap();
  let _idSeq = 0;
  function itemKey(it) {
    if (!it) return null;
    const attr = it.getAttribute && (it.getAttribute("data-message-id") || it.getAttribute("data-testid"));
    if (attr) return attr;
    let id = _idMap.get(it);
    if (!id) { id = "gen-" + (++_idSeq); _idMap.set(it, id); }
    return id;
  }
  const lastAssistantId = () => itemKey(lastAssistant());

  const itemText = (item) => textWithout(item);
  const classifyText = (item, excludeSel) => textWithout(item, excludeSel);

  let _edCache = null, _edAt = 0;
  function getEditor() {
    const now = Date.now();
    if (_edCache && _edCache.isConnected && _edCache.offsetParent !== null && now - _edAt < 80) return _edCache;
    const sels = [
      "fieldset [contenteditable='true']", // Claude 2026 fieldset
      "fieldset textarea",
      "div[contenteditable='true']", "textarea[placeholder]", "textarea",
      "[data-testid*='composer'] textarea", "[data-testid*='composer'] [contenteditable]",
      "[data-testid*='input']", "div[role='textbox']", "#prompt-textarea", "div.ProseMirror"
    ];
    for (const sel of sels) {
      const els = [...document.querySelectorAll(sel)].filter(e => !e.closest("#zs-root") && e.offsetParent !== null);
      if (els.length) { _edCache = els[els.length-1]; _edAt = now; return _edCache; }
    }
    const all = [...document.querySelectorAll("[contenteditable]")].filter(e=>!e.closest("#zs-root"));
    _edCache = all.length ? all[all.length-1] : null; _edAt = now; return _edCache;
  }
  const editorText = () => { const e=getEditor(); return e ? (e.innerText||e.value||e.textContent||"") : ""; };
  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();
  const composerFrame = () => { const ed=getEditor(); return ed ? (ed.closest("form")||ed.closest("fieldset")||ed.closest("div[class*='composer']")||ed.parentElement) : null; };
  function barMount() {
    const ed=getEditor();
    if(!ed) return null;
    // ULTRA: try fieldset first (Claude 2026), then form, then card
    const fs = ed.closest("fieldset");
    if(fs) return { parent: fs, before: fs.firstChild, inside: true };
    const card = ed.closest("form") || ed.closest("div");
    if(card) return { parent: card, before: card.firstChild, inside: true };
    return null;
  }

  function setInputLock(on){ const ed=getEditor(); if(!ed) return; try{ ed.setAttribute("contenteditable", on?"false":"true"); }catch (_e) { globalThis.ZSSafe?.seen?.("generic.setInputLock", _e); } }

  function sendButton(){
    const sels=["fieldset button[type='submit']", "button[aria-label*='Send' i]", "button[data-testid*='send' i]", "button[type='submit']", "form button"];
    for(const s of sels){ const b=document.querySelector(s); if(b && b.offsetParent!==null) return b; }
    return null;
  }
  function stopButton(){
    const sels=["button[aria-label*='Stop' i]", "button[aria-label*='Cancel' i]", "button[data-testid*='stop' i]"];
    for(const s of sels){ const b=document.querySelector(s); if(b && b.offsetParent!==null) return b; }
    return null;
  }

  const streamText = (item) => item ? textWithout(item) : "";
  const streamLen = (item) => streamText(item===undefined?lastAssistant():item).length;
  let _sMax=-1,_sAt=0,_sItem=null;
  function sampleStream(){ const it=lastAssistant(); const len=streamText(it).length; const now=Date.now(); if(it!==_sItem||len<_sMax-400){_sItem=it;_sMax=len;_sAt=now;return;} if(len>_sMax){_sMax=len;_sAt=now;}}
  function grewWithin(ms){ return _sMax>1 && Date.now()-_sAt<ms; }
  function genActive(){ sampleStream(); const stop=!!stopButton(); if(stop) return true; return grewWithin(timings.GEN_IDLE_MS); }
  const isGenerating=genActive, isBusyNow=genActive, isHardGenerating=genActive;
  const turnHalted=()=>false;
  const findContinueBtn=()=>{ for(const b of document.querySelectorAll("button")) if(/continue/i.test(b.innerText||"") && b.offsetParent!==null) return b; return null; };
  const clickContinueBtn=()=>{ const b=findContinueBtn(); if(!b) return false; try{b.click();return true;}catch(_e){globalThis.ZSSafe?.seen?.("generic.continue",_e);return false;}};
  const snapshot=()=>{ try{ const it=lastAssistant(); return {rp:(it?.textContent||"").length}; }catch(_e){globalThis.ZSSafe?.seen?.("generic.snapshot",_e);return {};}};
  const readAssistant=()=>{ const it=lastAssistant(); if(!it) return{present:false,reply:"",thinking:"",item:null}; return{present:true, reply:textWithout(it).trim(), thinking:"", item:it}; };
  const SEND_MAX_CHARS=100000;
  const truncateForSend=(t)=> t&&t.length>SEND_MAX_CHARS ? t.slice(0,SEND_MAX_CHARS-500)+"\n\n[…truncated…]\n\n"+t.slice(-500) : t;

  async function setEditorText(ed, text){
    ed.focus();
    try{
      const sel=window.getSelection(); const r=document.createRange(); r.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand("insertText",false,text);
      await sleep(15);
      if((ed.innerText||ed.textContent||"").trim().length < 10){
        if(ed.tagName==="TEXTAREA"){ ed.value=text; ed.dispatchEvent(new Event("input",{bubbles:true})); }
        else { ed.textContent=text; ed.dispatchEvent(new InputEvent("input",{bubbles:true})); }
      }
      return true;
    }catch(_e){ globalThis.ZSSafe?.seen?.("generic.setEditorText",_e); try{ ed.textContent=text; ed.dispatchEvent(new Event("input",{bubbles:true})); return true;}catch(_e2){globalThis.ZSSafe?.seen?.("generic.setEditorText2",_e2);return false;}}
  }

  async function typeAndSend(text, images){
    const ed=getEditor(); if(!ed) throw new Error("Input not found");
    text=truncateForSend(text);
    await setEditorText(ed, text);
    if(images && images.length){ try{ ed.dispatchEvent(new ClipboardEvent("paste",{clipboardData:_imagesToDataTransfer(images),bubbles:true})); }catch (_e) { globalThis.ZSSafe?.seen?.("generic.typeAndSend", _e); } }
    await sleep(8);  // recovery poll (was 62ms)
    const btn=sendButton();
    if(btn){ try{ btn.click(); return; }catch (_e) { globalThis.ZSSafe?.seen?.("generic.typeAndSend", _e); } }
    const o={key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true}; ed.dispatchEvent(new KeyboardEvent("keydown",o));
  }
  function stopGeneration(){ const b=stopButton(); if(b) try{b.click();}catch (_e) { globalThis.ZSSafe?.seen?.("generic.stopGeneration", _e); } }
  const enforceComposer=()=>({ready:true});
  const ensureComposerReady=async(reason)=>{ diag("mode_ready",{reason,provider:_id}); return{ready:!!getEditor()}; };
  // Shown in the bar before a session starts when the site cannot be driven.
  // (audit: main.js calls P.modeWarning() guarded, but only generic/aliases had it,
  // so bespoke providers silently never surfaced the reason.)
  const modeWarning=()=>{
    try{
      if(!getEditor()) return "Composer not found on this page — open a new chat";
      // HONEST: this used to read `captchaPresent && captchaPresent()` — a name
      // that exists nowhere in this file. Guarding an UNDECLARED variable is a
      // ReferenceError, not a null check, so every generic-driver site threw
      // here and the warning silently degraded to nothing (caught by the
      // no-undef pass in tools/verify.js).
      const signIn = document.querySelector(
        'iframe[src*="captcha" i], iframe[src*="challenges" i], #challenge-form, [data-testid*="captcha" i], .cf-turnstile');
      if (signIn) return "Captcha / verification in the way — solve it first";
      if (/verify you are human|unusual traffic/i.test((document.body.innerText || "").slice(0, 1500)))
        return "Captcha / verification in the way — solve it first";
      return null;
    }catch(_e){ globalThis.ZSSafe?.seen?.("generic.modeWarning",_e); return null; }
  };
  const scanError=()=>{ const t=document.body.innerText; if(/rate limit|too many requests|quota exceeded/i.test(t.slice(-2000))) return "Rate limited"; if(!getEditor()) return "Input disappeared"; return null; };
  const isTooLongMsg=(t)=>/conversation too long/i.test(t);
  const isBusyMsg=(t)=>/something went wrong|try again|temporarily unavailable/i.test(t);
  // Images: typeAndSend() below already stages attachments by dispatching a
  // synthetic paste carrying the files, and the core only ever asks for images
  // through typeAndSend(text, images). This used to be `async()=>false`, which a
  // caller would read as "attachment failed" while nothing was attempted. Share
  // the working paste path instead of keeping a stub that reports failure.
  const _imagesToDataTransfer=(images)=>{
    const dt=new DataTransfer();
    images.forEach((img,i)=>{
      try{
        const bin=atob(img.data); const arr=new Uint8Array(bin.length);
        for(let j=0;j<bin.length;j++) arr[j]=bin.charCodeAt(j);
        dt.items.add(new File([arr],`img_${i}.jpg`,{type:img.mimeType||"image/jpeg"}));
      }catch (_e) { globalThis.ZSSafe?.seen?.("generic.attachImages", _e); }
    });
    return dt;
  };
  const attachImages=async(images)=>{
    if(!images || !images.length) return true;   // nothing to attach is not a failure
    const ed=getEditor(); if(!ed) return false;
    try{
      ed.dispatchEvent(new ClipboardEvent("paste",{clipboardData:_imagesToDataTransfer(images),bubbles:true}));
      return true;
    }catch (_e) { globalThis.ZSSafe?.seen?.("generic.attachImages", _e); return false; }
  };
  const clearAttachments=()=>{};
  const conversationKey=()=> location.pathname + location.search;
  const installSendHooks=(handlers)=>{
    document.addEventListener("keydown",e=>{ if(e.key!=="Enter"||e.shiftKey) return; const ed=getEditor(); if(!ed||!ed.contains(e.target)) return; if(editorText().trim()==="") return; if(handlers.isBlocked()) return; if(!handlers.isStarted()){ if(!chatIsEmpty()) return; handlers.onBlockedAttempt(); return;} handlers.onUserMessage(assistantCount()); },true);
    document.addEventListener("click",e=>{ const btn=e.target?.closest?.("button"); if(!btn) return; if(btn.closest("#zs-root")) return; if(/stop|cancel/i.test(btn.getAttribute("aria-label")||btn.innerText||"")) handlers.onNativeStop(); else if(/send/i.test(btn.getAttribute("aria-label")||"")){ if(handlers.isBlocked()) return; if(!handlers.isStarted() && !chatIsEmpty()){ handlers.onBlockedAttempt(); return;} handlers.onUserMessage(assistantCount());}},true);
  };
  const findToolBlockSpot=(item)=>{
    const blocks=[...item.querySelectorAll("pre, code, [class*='code']")];
    let hid=null;
    for(const b of blocks){ if(/(?:\"command\"|###LUA###|###MCP_TOOL###)/i.test(b.textContent||"")){ b.classList.add("zs-tool-hide"); hid=hid||{parent:b.parentElement, ref:b}; } }
    return hid;
  };

  return {
    get id(){ return _id; }, get displayName(){ return _displayName; },
    timings, supportsVision: true, chipAtItemLevel: true,
    init({diag:d}={}){ if(d) diag=d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText, assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant, streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount, setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, enforceComposer, ensureComposerReady, turnHalted, findContinueBtn, clickContinueBtn,
    scanError, modeWarning, isTooLongMsg, isBusyMsg, attachImages, clearAttachments, conversationKey, installSendHooks, findToolBlockSpot,
    setMeta, _setMeta:setMeta, makeMeta, version:"4.8.0"
  };
})();
