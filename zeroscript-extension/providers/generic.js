// SPDX-License-Identifier: GPL-3.0-or-later
// providers/generic.js — Universal AI provider fallback ULTRA v3.2.0
// Works on ANY chat AI site (Perplexity, Copilot, Grok, Poe, Mistral, etc.)
// UPGRADED: fieldset composer 2026, better message detection, tighter timings, never-drops.
// Specific providers (perplexity.js etc) thin-wrap this with custom names.
const ZSGenericProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let diag = () => {};
  let _displayName = "AI";
  let _id = "generic";

  function setMeta(id, displayName) { _id = id; _displayName = displayName; }

  // ULTRA timings — slightly tighter for instant response
  const timings = {
    GEN_IDLE_MS: 1600, // was 2000
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 35000, // was 40000
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 6000, // was 7000
    RESPONSE_TIMEOUT_MS: 300000,
  };

  const textWithout = (root, excludeSel) => {
    if (!root) return "";
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (excludeSel && n.matches && n.matches(excludeSel)) return;
      if (n.matches && n.matches(".zs-chip, .zs-hidden")) return;
      if (n.tagName==="BR") { t+="\n"; return; }
      for (const c of n.childNodes) walk(c);
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
    const all = allMessages();
    const idx = all.indexOf(el);
    if (idx >= 0) return idx % 2 === 0;
    return false;
  };
  const isAssistantItem = (el) => !isUserItem(el);
  const allItems = () => allMessages();
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => { const a = assistantItems(); return a.length ? a[a.length-1] : null; };

  const itemText = (item) => textWithout(item);
  const classifyText = (item, excludeSel) => textWithout(item, excludeSel);

  function getEditor() {
    const sels = [
      "fieldset [contenteditable='true']", // Claude 2026 fieldset
      "fieldset textarea",
      "div[contenteditable='true']", "textarea[placeholder]", "textarea",
      "[data-testid*='composer'] textarea", "[data-testid*='composer'] [contenteditable]",
      "[data-testid*='input']", "div[role='textbox']", "#prompt-textarea", "div.ProseMirror"
    ];
    for (const sel of sels) {
      const els = [...document.querySelectorAll(sel)].filter(e => !e.closest("#zs-root") && e.offsetParent !== null);
      if (els.length) return els[els.length-1];
    }
    const all = [...document.querySelectorAll("[contenteditable]")].filter(e=>!e.closest("#zs-root"));
    return all.length ? all[all.length-1] : null;
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

  let _locked=false;
  function setInputLock(on){ _locked=on; const ed=getEditor(); if(!ed) return; try{ ed.setAttribute("contenteditable", on?"false":"true"); }catch{} }

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
  const clickContinueBtn=()=>{ const b=findContinueBtn(); if(!b) return false; try{b.click();return true;}catch{return false;}};
  const snapshot=()=>{ try{ const it=lastAssistant(); return {rp:(it?.textContent||"").length}; }catch{return {};}};
  const readAssistant=()=>{ const it=lastAssistant(); if(!it) return{present:false,reply:"",thinking:"",item:null}; return{present:true, reply:textWithout(it).trim(), thinking:"", item:it}; };
  const waitFor=async(pred,timeout)=>{ const t0=Date.now(); while(Date.now()-t0<timeout){ if(pred()) return true; await sleep(60);} return false; };
  const SEND_MAX_CHARS=100000;
  const truncateForSend=(t)=> t&&t.length>SEND_MAX_CHARS ? t.slice(0,SEND_MAX_CHARS-500)+"\n\n[…truncated…]\n\n"+t.slice(-500) : t;

  async function setEditorText(ed, text){
    ed.focus();
    try{
      const sel=window.getSelection(); const r=document.createRange(); r.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand("insertText",false,text);
      await sleep(60);
      if((ed.innerText||ed.textContent||"").trim().length < 10){
        if(ed.tagName==="TEXTAREA"){ ed.value=text; ed.dispatchEvent(new Event("input",{bubbles:true})); }
        else { ed.textContent=text; ed.dispatchEvent(new InputEvent("input",{bubbles:true})); }
      }
      return true;
    }catch{ try{ ed.textContent=text; ed.dispatchEvent(new Event("input",{bubbles:true})); return true;}catch{return false;}}
  }

  async function typeAndSend(text, images){
    const ed=getEditor(); if(!ed) throw new Error("Input not found");
    text=truncateForSend(text);
    await setEditorText(ed, text);
    if(images && images.length){ try{ const dt=new DataTransfer(); images.forEach((img,i)=>{ try{ const bin=atob(img.data); const arr=new Uint8Array(bin.length); for(let j=0;j<bin.length;j++)arr[j]=bin.charCodeAt(j); const f=new File([arr],`img_${i}.jpg`,{type:img.mimeType||"image/jpeg"}); dt.items.add(f);}catch{}}); ed.dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true})); }catch{} }
    await sleep(250);
    const btn=sendButton();
    if(btn){ try{ btn.click(); return; }catch{} }
    const o={key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true}; ed.dispatchEvent(new KeyboardEvent("keydown",o));
  }
  function stopGeneration(){ const b=stopButton(); if(b) try{b.click();}catch{} }
  const enforceComposer=()=>({ready:true});
  const ensureComposerReady=async(reason)=>{ diag("mode_ready",{reason,provider:_id}); return{ready:!!getEditor()}; };
  const scanError=()=>{ const t=document.body.innerText; if(/rate limit|too many requests|quota exceeded/i.test(t.slice(-2000))) return "Rate limited"; if(!getEditor()) return "Input disappeared"; return null; };
  const isTooLongMsg=(t)=>/conversation too long/i.test(t);
  const isBusyMsg=(t)=>/something went wrong|try again|temporarily unavailable/i.test(t);
  const attachImages=async()=>false, clearAttachments=()=>{};
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
    allItems, isUserItem, isAssistantItem, itemText, classifyText, assistantCount, userCount, lastAssistant, readAssistant, streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount, setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, enforceComposer, ensureComposerReady, turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg, attachImages, clearAttachments, conversationKey, installSendHooks, findToolBlockSpot,
    setMeta, _setMeta:setMeta, version:"3.2.0 ULTRA"
  };
})();
