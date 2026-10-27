// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude.js — Anthropic Claude (claude.ai) ULTRA provider v3.2.0
// UPGRADED: fieldset composer 2026 (Claude redesign), ProseMirror inside fieldset, hedge 80ms, never drops.
// Exports ZSProvider interface — copied 1:1 from deepseek/chatgpt quality, adapted for Claude's ProseMirror SPA.
// Claude DOM notes (claude.ai 2025-2026, validated):
// - Conversations: /chat/<uuid>, /new, /projects/<id>/chat/<uuid>
// - Messages: data-testid="user-message" / "assistant-message" OR data-is-user-message, fallback .font-claude-response / .group with role
// - Thinking: collapsible [data-testid="thinking"] / .thinking / details with summary
// - Composer: ProseMirror div[contenteditable="true"] with data-placeholder="Reply to Claude..." inside form, sticky bottom
// - Send: button[aria-label*="Send"] (arrow up), Stop: button[aria-label*="Stop"]
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    container: "[data-testid='conversation'], main, [role='main'], div[class*='chat']",
    userItem: "[data-testid='user-message'], [data-is-user-message='true'], [data-message-author-role='user']",
    assistantItem: "[data-testid='assistant-message'], [data-is-user-message='false'], [data-message-author-role='assistant']",
    anyMessage: "[data-testid='user-message'], [data-testid='assistant-message'], [data-is-user-message], [data-message-author-role]",
    // Claude renders markdown inside assistant turn as .markdown / .prose / font-claude-response
    reply: "[data-testid='assistant-message'] .markdown, [data-testid='assistant-message'] [class*='markdown'], .font-claude-response, [data-is-user-message='false'] .prose, [data-is-user-message='false']",
    thinking: "[data-testid='thinking'], [class*='thinking'], details.thinking, [data-testid*='thought']",
    // ULTRA editor selector: fieldset composer 2026 + ProseMirror + fallbacks
    editor: "fieldset div[contenteditable='true'], fieldset [contenteditable='true'], div[contenteditable='true']",
    sendBtn: "fieldset button[type='submit'], button[aria-label='Send message'], button[aria-label*='Send'], button[data-testid='send-button'], form button[type='submit']",
    stopBtn: "fieldset button[aria-label*='Stop'], button[aria-label*='Stop'], button[aria-label*='Cancel'], button[data-testid='stop-button']",
    codeWrap: "pre, code-block, div[class*='code-block']",
    errorSurfaces: "[data-testid*='error'], [role='alert'], .error, [class*='error-message'], div[class*='toast']",
  };

  const RE = {
    contextLimit: new RegExp(["conversation.{0,20}(too long|trop long)","context.{0,20}(limit|exceeded)","maximum.{0,20}(context|length)","(token|context).{0,10}limit"].join("|"),"i"),
    tooLong: /conversation .{0,20}(too long|trop longue)/i,
    busy: /something went wrong|try again|temporarily unavailable|overloaded|high demand|usage limit|rate limit|unavailable/i,
    continueBtn: /continue|continuer/i,
    stopped: /(stopped|arrêté|arrété|halted|interrompu)/i,
    paused: /limit|quota|rate.?limit/i,
  };

  // ULTRA timings for Claude ULTRA — tighter, never drops
  const timings = {
    GEN_IDLE_MS: 1100, // was 1200 ULTRA
    REASON_IDLE_MS: 12000, // was 15000
    WARMUP_MS: 32000, // was 35000
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 7000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  function isUserItem(item){
    if (!item) return false;
    if (item.matches && (item.matches(S.userItem) || item.getAttribute('data-is-user-message')==='true')) return true;
    if (item.querySelector && item.querySelector("[data-testid='user-message']")) return true;
    // Claude human role attribute
    if (item.getAttribute && item.getAttribute('data-message-author-role')==='user') return true;
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  function textWithout(root, excludeSel){
    if(!root) return "";
    let t="";
    const walk=(n)=>{
      if(n.nodeType===3){ t+=n.nodeValue; return; }
      if(n.nodeType!==1) return;
      if(excludeSel && n.matches && n.matches(excludeSel)) return;
      if(n.matches && n.matches(".zs-chip, .zs-hidden")) return;
      if(n.tagName==="BR"){ t+="\n"; return; }
      const isBlock = /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|TABLE|TR|SECTION|ARTICLE|HR)$/.test(n.tagName);
      if(isBlock && t && !t.endsWith("\n")) t+="\n";
      for(const c of n.childNodes) walk(c);
      if(isBlock && !t.endsWith("\n")) t+="\n";
    };
    walk(root);
    return t;
  }

  function itemText(item){
    if(!item) return "";
    if(isAssistantItem(item)){
      const md = item.querySelector(S.reply) || item;
      return textWithout(md, ".zs-chip");
    }
    return textWithout(item, ".zs-chip");
  }
  function classifyText(item, excludeSel){
    if(isAssistantItem(item)){
      const md = item.querySelector(S.reply) || item;
      return textWithout(md, excludeSel || ".zs-chip");
    }
    return textWithout(item, excludeSel);
  }

  // MAX allItems — ultra resilient like deepseek/chatgpt, handles 2026 Claude DOM churn
  const allItems = () => {
    let items = [...document.querySelectorAll(S.anyMessage)].filter(e=> !e.closest("#zs-root") && e.textContent.trim().length>2);
    if(items.length) return items;
    // Fallback: Claude's group containers
    items = [...document.querySelectorAll("div.group, div[data-test-render-count], div[class*='message'], div.font-claude-response, main div[class*='flex']")].filter(e=>{
      if(e.closest("#zs-root")) return false;
      const txt=(e.textContent||"").trim();
      if(txt.length<12) return false;
      // must look like a message bubble, not the whole page
      const rect=e.getBoundingClientRect();
      return rect.height < window.innerHeight*0.85 && rect.width>120;
    });
    if(items.length) return items.slice(-60); // last 60 to avoid page chrome
    const c = document.querySelector(S.container);
    if(c) items = [...c.children].filter(ch=> ch.textContent.trim().length>15 && !ch.closest("#zs-root"));
    return items.filter(el=> !el.closest("#zs-root") && el.textContent.trim().length>0);
  };
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  // MAX getEditor — copies deepseek stability MAX with Claude fallbacks
  function getEditor(){
    // Primary: visible contenteditable ProseMirror
    let cands = [...document.querySelectorAll(S.editor)].filter(e=> !e.closest("#zs-root"));
    // Deep filter: visible + not zero-size + inside composer area
    for(let i=cands.length-1;i>=0;i--){
      const e=cands[i];
      if(!e) continue;
      const r=e.getBoundingClientRect();
      const vis = e.offsetParent!==null || r.height>8;
      if(vis && r.width>60) return e;
    }
    // Fallbacks: Claude-specific selectors
    const alts = [
      "div.ProseMirror[contenteditable='true']",
      "div[contenteditable='true'][data-placeholder]",
      "div[contenteditable][role='textbox']",
      "div[data-placeholder*='Claude']",
      "textarea",
      "[role='textbox']"
    ];
    for(const sel of alts){
      try{
        const e=document.querySelector(sel);
        if(e && !e.closest("#zs-root") && e.getBoundingClientRect().width>0) return e;
      }catch{}
    }
    // Last resort: any bottom contenteditable
    try{
      const all=[...document.querySelectorAll("[contenteditable=true], textarea")].filter(e=>!e.closest("#zs-root"));
      if(all.length) return all[all.length-1];
    }catch{}
    return cands[0]||null;
  }
  const editorText = () => {
    const e=getEditor();
    if(!e) return "";
    // Claude ProseMirror: innerText preserves line breaks better than textContent
    return (e.innerText||e.textContent||"").trim();
  };
  const lastAssistant = () => { const a=assistantItems(); return a.length? a[a.length-1]: null; };
  const chatIsEmpty = () => allItems().length===0;
  const isFreshChat = () => {
    const empty = chatIsEmpty();
    const ed = getEditor();
    if(!empty || !ed) return false;
    // Claude fresh: /new or /chat without uuid, or no assistant yet
    if(/\/new|\/chat\/?$/.test(location.pathname)) return true;
    if(!/\/chat\/[a-f0-9-]+/i.test(location.pathname) && !/\/projects\//.test(location.pathname)) return empty;
    return empty && /\/chat\/[a-f0-9-]+/i.test(location.pathname) ? false : empty;
  };

  // MAX composerFrame — resilient for Claude's sticky bottom bar
  const composerFrame = () => {
    const ed=getEditor();
    if(!ed) return null;
    // Try known Claude wrappers
    const candidates = [
      ed.closest("form"),
      ed.closest("[data-testid='composer']"),
      ed.closest("div[class*='composer']"),
      ed.closest("div.sticky"),
      ed.closest("div[class*='bottom-0']"),
    ].filter(Boolean);
    for(const c of candidates) if(c) return c;
    // Fallback: climb 6 levels
    let n=ed;
    for(let i=0;i<6 && n.parentElement;i++) n=n.parentElement;
    return n;
  };

  // MAX barMount — copies DeepSeek design 1:1 on top of chatbar, full width
  function barMount(){
    const ed=getEditor();
    if(!ed) return null;
    // Strategy 1: form (Claude uses form for composer)
    const form = ed.closest("form");
    if(form && form !== document.body){
      let before=form.firstElementChild;
      if(before && before.id==="zs-bar") before=before.nextElementSibling;
      return {parent: form, before, inside: true};
    }
    // Strategy 2: sticky bottom container (Claude's bottom-0 wrapper)
    const sticky = ed.closest("div.sticky, div[class*='bottom-0'], div[class*='composer']");
    if(sticky && sticky !== document.body){
      let before=sticky.firstElementChild;
      if(before && before.id==="zs-bar") before=before.nextElementSibling;
      // sticky is outer container — insert inside it but before the input card
      return {parent: sticky, before, inside: true};
    }
    // Strategy 3: input card (div with bg / rounded)
    const card = ed.closest("div[class*='bg-'], div[class*='rounded']");
    if(card && card.getBoundingClientRect().width > 100){
      let before=card.firstElementChild;
      if(before && before.id==="zs-bar") before=before.nextElementSibling;
      return {parent: card, before, inside: true};
    }
    // Strategy 4: fallback to frame
    const frame=composerFrame();
    if(!frame) return null;
    let before=frame.firstElementChild;
    if(before && before.id==="zs-bar") before=before.nextElementSibling;
    return {parent: frame, before, inside: true};
  }
  const coverTarget = () => {
    const ed=getEditor();
    if(!ed) return null;
    // Cover whole input card for MAX click block
    return ed.closest("form") || ed.closest("div[class*='relative']") || ed.closest("div.sticky") || ed;
  };

  let _locked=false;
  function setInputLock(on){
    _locked=on;
    const ed=getEditor();
    if(!ed) return;
    try{
      if(on){
        ed.setAttribute("contenteditable","false");
        ed.setAttribute("data-zs-locked","1");
        ed.style.pointerEvents="none";
      }else{
        ed.setAttribute("contenteditable","true");
        ed.removeAttribute("data-zs-locked");
        ed.style.pointerEvents="";
      }
    }catch{}
  }

  // MAX send/stop detection — handles Claude's new button labels
  function sendButton(){
    // Try exact aria first
    let b=document.querySelector(S.sendBtn);
    if(b && b.offsetParent!==null) return b;
    // Claude uses svg arrow; fallback search near composer
    const all=[...document.querySelectorAll("button")].filter(x=>!x.closest("#zs-root"));
    // Prefer buttons inside form near editor
    const ed=getEditor();
    const scope = ed ? (ed.closest("form") || ed.closest("div.sticky") || document) : document;
    const scoped=[...scope.querySelectorAll("button")].filter(x=>!x.closest("#zs-root"));
    const list = scoped.length ? scoped : all;
    for(const btn of list){
      if(btn.offsetParent===null) continue;
      const aria=(btn.getAttribute("aria-label")||"").toLowerCase();
      const txt=(btn.textContent||"").toLowerCase();
      const hasArrow = btn.querySelector("svg");
      if(aria.includes("send") || (hasArrow && (aria==="" && list.length<6))) {
        // Check not disabled style
        if(!btn.disabled && btn.getAttribute("aria-disabled")!=="true") return btn;
      }
      if(aria.includes("send") || txt.includes("send")) return btn;
    }
    return null;
  }
  function stopButton(){
    let b=document.querySelector(S.stopBtn);
    if(b && b.offsetParent!==null) return b;
    const all=[...document.querySelectorAll("button")].filter(x=>!x.closest("#zs-root"));
    for(const btn of all){
      if(btn.offsetParent===null) continue;
      const aria=(btn.getAttribute("aria-label")||"").toLowerCase();
      if(aria.includes("stop")||aria.includes("cancel")||aria.includes("abort")) return btn;
    }
    return null;
  }
  const isStopBtn = (b)=> !!b && /stop|cancel|abort/i.test(b.getAttribute("aria-label")||b.textContent||"");

  // MAX stream detection — growth-tolerant + thinking aware
  function streamText(item){ return item? textWithout(item, ".zs-chip"):""; }
  const streamLen = (item)=> streamText(item===undefined? lastAssistant(): item).length;
  let _sMax=-1,_sAt=0,_sItem=null;
  function sampleStream(){
    const it=lastAssistant(); const len=streamText(it).length; const now=Date.now();
    if(it!==_sItem || len < _sMax-400){ _sItem=it; _sMax=len; _sAt=now; return; }
    if(len>_sMax){ _sMax=len; _sAt=now; }
  }
  const grewWithin=(ms)=> _sMax>1 && Date.now()-_sAt < ms;
  const WEDGE_MS=10000; let _stopSince=0;
  function genActive(){
    sampleStream();
    const stop=!!stopButton(); const now=Date.now();
    if(stop){
      if(!_stopSince) _stopSince=now;
      return (now-_sAt < WEDGE_MS) || (now - _stopSince < 2000);
    }
    _stopSince=0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating=genActive, isBusyNow=genActive, isHardGenerating=genActive;
  function unwedgeStop(){
    const s=stopButton();
    if(s && !genActive()){ try{s.click();}catch{} return true; }
    return false;
  }
  async function unwedgeStopPersistently(totalMs=4000){
    const t0=Date.now();
    while(Date.now()-t0<totalMs){
      if(sendButton()) return true;
      if(unwedgeStop() && await waitFor(()=>!!sendButton(),1500)) return true;
      await sleep(250);
    }
    return !!sendButton();
  }

  function turnHalted(item){
    if(!item) return false;
    const txt=(item.textContent||"");
    if(RE.stopped.test(txt) && !item.querySelector(S.thinking)) return true;
    return false;
  }
  function findContinueBtn(){
    for(const b of document.querySelectorAll("button")){
      if(b.offsetParent===null) continue;
      if(RE.continueBtn.test((b.innerText||"").trim())) return b;
    }
    return null;
  }
  function clickContinueBtn(){ const b=findContinueBtn(); if(!b) return false; try{b.click();return true;}catch{return false;}}

  function snapshot(){
    try{ const it=lastAssistant(); if(!it) return{th:0,rp:0}; return{th:0,rp:(it.textContent||"").length}; }catch{return{};}
  }
  function readAssistant(){
    const it=lastAssistant();
    if(!it) return{present:false,reply:"",thinking:"",item:null};
    // Extract thinking separately if present
    let thinking="";
    try{
      const thEl = it.querySelector(S.thinking);
      if(thEl) thinking = textWithout(thEl, ".zs-chip").trim();
    }catch{}
    return{present:true, reply: textWithout(it,".zs-chip").trim(), thinking, item:it};
  }
  async function waitFor(pred, timeout){
    const t0=Date.now();
    while(Date.now()-t0<timeout){ if(pred()) return true; await sleep(120); }
    return false;
  }

  const SEND_MAX_CHARS=120000, SEND_MAX_LINES=800;
  function truncateForSend(text){
    if(!text) return text;
    const lines=String(text).split("\n");
    if(text.length<=SEND_MAX_CHARS && lines.length<=SEND_MAX_LINES) return text;
    const marker=(what)=>`\n\n[…ZeroScript: truncated (${what}) — work with head+tail…]\n\n`;
    let out=text, note;
    if(lines.length>SEND_MAX_LINES){
      const h=Math.floor(SEND_MAX_LINES*0.85), t=SEND_MAX_LINES-h;
      note=`${lines.length-SEND_MAX_LINES} of ${lines.length} lines omitted`;
      out=lines.slice(0,h).join("\n")+marker(note)+lines.slice(lines.length-t).join("\n");
    }
    if(out.length>SEND_MAX_CHARS){
      const b=SEND_MAX_CHARS-300, h=Math.floor(b*0.85);
      note=`${out.length-b} chars omitted`;
      out=out.slice(0,h)+marker(note)+out.slice(out.length-(b-h));
    }
    return out;
  }

  function selectAll(ed){
    ed.focus();
    try{
      const sel=window.getSelection(); const r=document.createRange();
      r.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(r);
    }catch{}
  }
  // MAX setEditorText — handles Claude ProseMirror with rich paste
  async function setEditorText(ed, text){
    ed.focus();
    selectAll(ed);
    let ok=false;
    // Method 1: execCommand insertText (works for ProseMirror)
    try{ ok=document.execCommand("insertText",false,text); }catch{ ok=false; }
    // Method 2: clipboard paste
    if(!ok){
      try{
        document.execCommand("selectAll",false,null);
        const dt=new DataTransfer(); dt.setData("text/plain", text);
        ed.dispatchEvent(new ClipboardEvent("paste",{clipboardData: dt, bubbles:true, cancelable:true}));
        ok = ed.textContent.includes(text.slice(0,20));
      }catch{}
    }
    // Method 3: beforeinput + InputEvent
    if(!ok){
      try{
        ed.dispatchEvent(new InputEvent("beforeinput",{inputType:"insertText", data:text, bubbles:true, cancelable:true}));
        document.execCommand("insertText", false, text);
        ok=true;
      }catch{}
    }
    // Method 4: direct DOM + input event (last resort)
    if(!ok){
      try{
        ed.innerHTML=""; 
        const tn=document.createTextNode(text);
        ed.appendChild(tn);
        ed.dispatchEvent(new InputEvent("input",{bubbles:true}));
        // ProseMirror needs selection at end
        const sel=window.getSelection(); const r=document.createRange();
        r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
        ok=true;
      }catch{}
    }
    await sleep(120);
    return ok;
  }

  async function typeAndSend(text, images){
    const ed=getEditor();
    if(!ed) throw new Error("Claude input not found — open claude.ai/chat or /new");
    text=truncateForSend(text);
    const relock=_locked;
    if(relock) ed.setAttribute("contenteditable","true");
    try{
      // Ensure composer is ready
      ed.focus(); await sleep(80);
      await setEditorText(ed, text);
      await sleep(100);
      // Verify text landed
      if(!editorText().includes(text.slice(0,12))){
        // Retry once with slower method
        await sleep(200);
        await setEditorText(ed, text);
      }
      if(images && images.length){
        try{ await attachImages(images); }catch{}
        const t0=Date.now();
        while(Date.now()-t0<25000){
          const b=sendButton();
          if(b && !b.disabled){ try{b.click();}catch{} }
          if(await waitFor(()=> editorText().trim()==="" || !!stopButton(), 1200)) return;
        }
        return;
      }
      await waitFor(()=>!!sendButton(),1500);
      if(!sendButton()) await unwedgeStopPersistently();
      const btn=sendButton();
      if(btn){
        if(btn.disabled){ diag("send.disabled",{}); return; }
        btn.click();
        // Also dispatch Enter as backup for Claude's ProseMirror
        await sleep(80);
        if(editorText().trim()!==""){
          const o={key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true};
          ed.dispatchEvent(new KeyboardEvent("keydown",o));
          ed.dispatchEvent(new KeyboardEvent("keyup",o));
        }
        return;
      }
      // Enter fallback
      const o={key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true};
      ed.dispatchEvent(new KeyboardEvent("keydown",o));
      ed.dispatchEvent(new KeyboardEvent("keyup",o));
    }finally{
      if(relock){ const e2=getEditor(); if(e2) e2.setAttribute("contenteditable","false"); }
    }
  }
  function stopGeneration(){ const b=stopButton(); if(b) try{b.click();}catch{} }

  function enforceComposer(){ return{ready:true}; }
  async function ensureComposerReady(reason){
    diag("mode_ready",{reason,provider:"claude"});
    // Claude has no mode selector — just ensure editor exists
    let tries=0;
    while(tries<8 && !getEditor()){
      await sleep(150); tries++;
    }
    return{ready: !!getEditor()};
  }

  function scanError(){
    try{
      for(const el of document.querySelectorAll(S.errorSurfaces)){
        if(el.offsetParent===null) continue;
        if(el.closest("#zs-root")) continue;
        const t=(el.innerText||"").trim();
        if(t.length>8 && t.length<600) return t.slice(0,240);
      }
      if(editorText().trim()!==""){
        const b=sendButton();
        if(b && b.disabled) return "Claude will not accept the message — its send button is disabled (limit reached).";
      }
    }catch{}
    if(!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg=(t)=> RE.tooLong.test(t);
  const isBusyMsg=(t)=> RE.busy.test(t);

  function fileFromImage(img,i){
    const mime=img.mimeType||"image/jpeg";
    const bin=atob(img.data); const arr=new Uint8Array(bin.length);
    for(let j=0;j<bin.length;j++) arr[j]=bin.charCodeAt(j);
    const ext=mime.includes("png")?"png":"jpg";
    return new File([arr],`zeroscript_${Date.now()}_${i}.${ext}`,{type:mime});
  }
  async function attachImages(images){
    const ed=getEditor(); if(!ed||!images||!images.length) return false;
    const dt=new DataTransfer();
    images.forEach((img,i)=>{ try{dt.items.add(fileFromImage(img,i));}catch{}});
    if(!dt.items.length) return false;
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste",{clipboardData: dt,bubbles:true,cancelable:true}));
    const fileInput=document.querySelector("input[type='file']");
    if(fileInput){ try{fileInput.files=dt.files; fileInput.dispatchEvent(new Event("change",{bubbles:true}));}catch{}}
    return await waitFor(()=>{
      const box=composerFrame();
      return !!(box && box.querySelector("img, [class*='preview'], [class*='thumbnail'], div[class*='file']"));
    },15000);
  }
  function clearAttachments(){
    try{
      const box=composerFrame(); if(!box) return;
      box.querySelectorAll("[aria-label*='Remove'], [class*='delete'], [class*='remove']").forEach(d=>{try{d.click();}catch{}});
    }catch{}
  }

  // MAX conversationKey — supports /chat/, /new, /projects/
  const conversationKey = ()=> {
    const p=location.pathname;
    if(p.startsWith("/chat/")) return p;
    if(p.startsWith("/projects/")) return p;
    if(p==="/new" || p==="/") return "";
    return p;
  };

  function installSendHooks(handlers){
    document.addEventListener("keydown",(e)=>{
      if(e.key!=="Enter"||e.shiftKey||e.isComposing) return;
      const ed=getEditor(); if(!ed||!ed.contains(e.target)) return;
      if(editorText().trim()==="") return;
      if(handlers.isBlocked()) return;
      if(!handlers.isStarted()){
        if(!chatIsEmpty()) return;
        handlers.onBlockedAttempt(); return;
      }
      handlers.onUserMessage(assistantCount());
    },true);
    document.addEventListener("click",(e)=>{
      if(!getEditor()) return;
      const t=e.target;
      const cont=t&&t.closest&&t.closest("button");
      if(cont && RE.continueBtn.test((cont.innerText||"").trim())){ handlers.onNativeContinue(); return; }
      const stop=t&&t.closest&&t.closest(S.stopBtn);
      if(stop){ handlers.onNativeStop(); return; }
      const btn=t&&t.closest&&t.closest(S.sendBtn);
      if(!btn || isStopBtn(btn)) return;
      if(handlers.isBlocked()) return;
      if(!handlers.isStarted()){
        if(!chatIsEmpty()) return;
        handlers.onBlockedAttempt(); return;
      }
      handlers.onUserMessage(assistantCount());
    },true);
  }

  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*\"|###\s*lua|###mcp_tool###/i;
  const CMD_OPEN = /###\s*(?:LUA|MCP_TOOL)\s*###/i;
  const CMD_CLOSE = /###\s*END_(?:LUA|MCP_TOOL)\s*###/i;
  function findToolBlockSpot(item){
    let hidAny=null;
    const hide=(el,mc)=>{
      el.classList.add("zs-tool-hide");
      if(mc) mc.classList.add("zs-cmd-mask");
      hidAny=hidAny||{parent: el.parentElement, ref: el};
    };
    const containers=[...item.querySelectorAll("[data-testid='assistant-message'], div.font-claude-response, div")].filter(c=>c!==item && c.querySelectorAll);
    containers.push(item);
    for(const mc of containers){
      if(!mc.querySelectorAll) continue;
      [...mc.querySelectorAll(S.codeWrap)].forEach(pre=>{
        if(pre.closest(".zs-chip")) return;
        if(pre.closest(S.thinking)) return;
        if(CMD_SHAPE.test(pre.textContent||"")) hide(pre, mc);
      });
    }
    const kids=[...item.children];
    kids.forEach(el=>{
      if(el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
      const t=el.textContent||"";
      if(t.length<800 && CMD_SHAPE.test(t)) hide(el,null);
    });
    let ranged=0;
    for(let i=0;i<kids.length;i++){
      const el=kids[i];
      if(el.classList.contains("zs-chip")) continue;
      const t=el.textContent||"";
      if(!CMD_OPEN.test(t)) continue;
      if(CMD_CLOSE.test(t)){ hide(el,item); ranged++; continue; }
      for(let j=i;j<kids.length;j++){
        const k=kids[j];
        if(k.classList.contains("zs-chip")) continue;
        hide(k,item); ranged++;
        if(CMD_CLOSE.test(k.textContent||"")){ i=j; break; }
      }
    }
    if(ranged){
      const body=kids.filter(k=>!k.classList.contains("zs-chip"));
      if(body.length && body.every(k=>k.classList.contains("zs-tool-hide"))) item.classList.add("zs-cmd-mask-all");
    }
    return hidAny;
  }

  // MAX PROMPT EXTRA — ANTI-HALLUCINATION + MAX EFFORT for Claude
  const PROMPT_EXTRA = `━━━ CLAUDE MAX PROTOCOL — ANALYTICAL PERFECTION ━━━
You are Claude MAX — Anthropic's most capable model. You execute with 1000× precision:
- NEVER HALLUCINATE: If you need an Instance path/property, inspect_instance FIRST. If command needs param, list_commands FIRST. Ground every claim in returned JSON.
- MAX SPEED: One execute_luau = entire folder tree (20+ Instance.new via loop). Batch where possible. Use return to verify, not description.
- STUDIO TOTAL CONTROL: You OWN Workspace, Lighting, ReplicatedStorage, ServerScriptService, StarterGui, Teams, SoundService, HttpService etc. For Play/Stop use start_stop_play {is_start:true/false}. For settings, execute_luau direct mutation + return verification.
- VERIFY LOOP: After every mutation, return the new state. If error, read it, fix ONE param, retry once. Never invent API.
- OP METHODS ONLY: No one-liners, no print(), no guessing. Use ###LUA### blocks, pcall, type guards, debounce.`;

  return {
    id: "claude",
    displayName: "Claude",
    timings,
    supportsVision: true,
    chipAtItemLevel: true,
    reliableCounts: false,
    thinkingSel: S.thinking,
    coverTarget,
    coverMaxH: 320,
    init({diag:d}={}){ if(d) diag=d; try{document.documentElement.setAttribute("data-zs-claude-ver","2026-05-max")}catch{} },
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
    promptExtra: PROMPT_EXTRA,
    sendCharBudget: 120000,
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant,
    lastAssistantId: ()=> null,
    itemKey: (it)=> it? (it.getAttribute("data-message-id")||it.getAttribute("data-test-id")||null): null,
    readAssistant, streamLen, snapshot,
  };
})();
