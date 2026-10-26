// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude.js — Anthropic Claude (claude.ai) provider.
// Exports ZSProvider interface matching deepseek/chatgpt/gemini.
// Claude DOM notes (claude.ai, 2026 — SPA, React + ProseMirror-like editor):
// - Conversations at /chat/<uuid> or /new . Each turn has data-testid roles
// - Assistant turns carry markdown with <pre> code blocks; reasoning (extended thinking) in separate collapsible
// - Composer is contenteditable ProseMirror-like: div[contenteditable=true] with placeholder
// - Send button has aria-label Send / Stop via SVG. Stop appears while streaming.
// - Code blocks are <pre> with .code-block style, markers survive in textContent
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    container: "[data-testid='conversation'], main, [role='main']",
    userItem: "[data-testid='user-message'], [data-is-user-message='true']",
    assistantItem: "[data-testid='assistant-message'], [data-is-user-message='false']",
    anyMessage: "[data-testid='user-message'], [data-testid='assistant-message'], [data-is-user-message]",
    reply: "[data-testid='assistant-message'] .markdown, [data-testid='assistant-message'] [class*='markdown'], .font-claude-response, [data-is-user-message='false']",
    thinking: "[data-testid='thinking'], [class*='thinking'], details.thinking",
    editor: "div[contenteditable='true']",
    sendBtn: "button[aria-label='Send message'], button[aria-label*='Send'], button[data-testid='send-button']",
    stopBtn: "button[aria-label*='Stop'], button[aria-label*='Cancel'], button[data-testid='stop-button']",
    codeWrap: "pre",
    errorSurfaces: "[data-testid*='error'], [role='alert'], .error, [class*='error-message']",
  };

  const RE = {
    contextLimit: new RegExp(["conversation.{0,20}(too long|trop long)","context.{0,20}(limit|exceeded)","maximum.{0,20}(context|length)","(token|context).{0,10}limit"].join("|"),"i"),
    tooLong: /conversation .{0,20}(too long|trop longue)/i,
    busy: /something went wrong|try again|temporarily unavailable|overloaded|high demand|usage limit|rate limit/i,
    continueBtn: /continue|continuer/i,
    paused: /limit|quota|rate.?limit/i,
  };

  const timings = {
    GEN_IDLE_MS: 2000,
    REASON_IDLE_MS: 15000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 8000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  function allMessages(){ return [...document.querySelectorAll(S.anyMessage)]; }
  function isUserItem(el){ return !!el && (el.matches(S.userItem) || el.getAttribute('data-is-user-message')==='true' || el.querySelector("[data-testid='user-message']")); }
  function isAssistantItem(el){ return !!el && !isUserItem(el); }

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

  const allItems = () => {
    let items = allMessages();
    if(!items.length){
      // fallback: generic message containers
      items = [...document.querySelectorAll("div[data-test-render-count], div[class*='message']")].filter(e=>e.textContent.trim().length>0 && !e.closest("#zs-root"));
      // last resort: group by conversation container children
      if(!items.length){
        const c = document.querySelector(S.container);
        if(c) items = [...c.children].filter(ch=> ch.textContent.trim().length>10);
      }
    }
    return items.filter(el=> !el.closest("#zs-root") && el.textContent.trim().length>0);
  };
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  function getEditor(){
    const candidates = [...document.querySelectorAll(S.editor)].filter(e=> !e.closest("#zs-root"));
    // Prefer visible, bottom-most composer (last in DOM is usually composer)
    for(let i=candidates.length-1;i>=0;i--){
      const e=candidates[i];
      if(e.offsetParent!==null || e.getBoundingClientRect().height>0) return e;
    }
    // fallback: any contenteditable with placeholder
    const alt = document.querySelector("[contenteditable='true'][data-placeholder], div[contenteditable][role='textbox']");
    if(alt && !alt.closest("#zs-root")) return alt;
    return candidates[0]||null;
  }
  const editorText = () => { const e=getEditor(); return e? (e.innerText||e.textContent||""):""; };
  const lastAssistant = () => { const a=assistantItems(); return a.length? a[a.length-1]: null; };
  const chatIsEmpty = () => allItems().length===0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor() && !/\/chat\/[a-f0-9-]+/i.test(location.pathname);

  const composerFrame = () => {
    const ed=getEditor();
    return ed? (ed.closest("form")||ed.closest("[data-testid='composer']")||ed.parentElement): null;
  };
  function barMount(){
    const ed=getEditor();
    if(!ed) return null;
    // Try to mount inside composer card like ChatGPT
    const card = ed.closest("form") || ed.closest("div[class*='bg-']");
    if(card){
      let before=card.firstElementChild;
      if(before && before.id==="zs-bar") before=before.nextElementSibling;
      return {parent: card, before, inside: true};
    }
    const frame=composerFrame();
    if(!frame) return null;
    let before=frame.firstElementChild;
    if(before && before.id==="zs-bar") before=before.nextElementSibling;
    return {parent: frame, before, inside: true};
  }
  const coverTarget = () => {
    const ed=getEditor();
    if(!ed) return null;
    return ed.closest("div[class*='relative']")||ed;
  };

  let _locked=false;
  function setInputLock(on){
    _locked=on;
    const ed=getEditor();
    if(!ed) return;
    ed.setAttribute("contenteditable", on?"false":"true");
    if(on) ed.setAttribute("data-zs-locked","1"); else ed.removeAttribute("data-zs-locked");
  }

  function sendButton(){
    const b=document.querySelector(S.sendBtn);
    if(b && b.offsetParent!==null) return b;
    // fallback: any button with Send icon near composer
    const all=[...document.querySelectorAll("button")].filter(x=>!x.closest("#zs-root"));
    return all.find(btn=>{
      const t=(btn.getAttribute("aria-label")||btn.textContent||"").toLowerCase();
      return t.includes("send") && btn.offsetParent!==null;
    })||null;
  }
  function stopButton(){
    const b=document.querySelector(S.stopBtn);
    if(b && b.offsetParent!==null) return b;
    const all=[...document.querySelectorAll("button")].filter(x=>!x.closest("#zs-root"));
    return all.find(btn=>{
      const t=(btn.getAttribute("aria-label")||"").toLowerCase();
      return t.includes("stop")||t.includes("cancel");
    })||null;
  }
  const isStopBtn = (b)=> !!b && /stop|cancel/i.test(b.getAttribute("aria-label")||b.textContent||"");

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

  const turnHalted=()=>false;
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
    return{present:true, reply: textWithout(it,".zs-chip").trim(), thinking:"", item:it};
  }
  async function waitFor(pred, timeout){
    const t0=Date.now();
    while(Date.now()-t0<timeout){ if(pred()) return true; await sleep(120); }
    return false;
  }

  const SEND_HARD_CAP=150000, SEND_MAX_CHARS=120000, SEND_MAX_LINES=800, INSERT_CHUNK_LINES=40;
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
    const sel=window.getSelection(); const r=document.createRange();
    r.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(r);
  }
  async function setEditorText(ed, text){
    ed.focus();
    selectAll(ed);
    // Try modern insert: execCommand
    let ok=false;
    try{ ok=document.execCommand("insertText",false,text); }catch{ ok=false; }
    if(!ok){
      // Fallback: InputEvent / beforeinput
      try{
        document.execCommand("selectAll",false,null);
        const dt=new DataTransfer(); dt.setData("text/plain", text);
        ed.dispatchEvent(new ClipboardEvent("paste",{clipboardData: dt, bubbles:true, cancelable:true}));
        ok=true;
      }catch{}
    }
    if(!ok){
      // Last resort: set via innerText then dispatch input
      try{ ed.innerText=text; ed.dispatchEvent(new InputEvent("input",{bubbles:true})); ok=true;}catch{}
    }
    await sleep(100);
    return ok;
  }

  async function typeAndSend(text, images){
    const ed=getEditor();
    if(!ed) throw new Error("Claude input not found — open claude.ai/chat");
    text=truncateForSend(text);
    const relock=_locked;
    if(relock) ed.setAttribute("contenteditable","true");
    try{
      await setEditorText(ed, text);
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
      if(btn && btn.disabled){ diag("send.disabled",{}); return; }
      if(btn){ btn.click(); return; }
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
    return{ready: !!getEditor()};
  }

  function scanError(){
    try{
      for(const el of document.querySelectorAll(S.errorSurfaces)){
        if(el.offsetParent===null) continue;
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
      return !!(box && box.querySelector("img, [class*='preview'], [class*='thumbnail']"));
    },15000);
  }
  function clearAttachments(){
    try{
      const box=composerFrame(); if(!box) return;
      box.querySelectorAll("[aria-label*='Remove'], [class*='delete'], [class*='remove']").forEach(d=>{try{d.click();}catch{}});
    }catch{}
  }

  const conversationKey = ()=> location.pathname.startsWith("/chat/")? location.pathname : "";

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

  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  const CMD_OPEN = /###\s*(?:LUA|MCP_TOOL)\s*###/i;
  const CMD_CLOSE = /###\s*END_(?:LUA|MCP_TOOL)\s*###/i;
  function findToolBlockSpot(item){
    // Claude renders code as <pre> inside assistant message
    const pres=[...item.querySelectorAll(S.codeWrap)];
    let hidAny=null;
    const hide=(el,mc)=>{
      el.classList.add("zs-tool-hide");
      if(mc) mc.classList.add("zs-cmd-mask");
      hidAny=hidAny||{parent: el.parentElement, ref: el};
    };
    // Scan all message containers
    const containers=[...item.querySelectorAll("[data-testid='assistant-message'], div")].filter(c=>c!==item);
    containers.push(item);
    for(const mc of containers){
      if(!mc.querySelectorAll) continue;
      mc.querySelectorAll(S.codeWrap).forEach(pre=>{
        if(pre.closest(".zs-chip")) return;
        if(CMD_SHAPE.test(pre.textContent||"")) hide(pre, mc);
      });
    }
    // Also bare blocks
    const kids=[...item.children];
    kids.forEach(el=>{
      if(el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
      const t=el.textContent||"";
      if(t.length<800 && CMD_SHAPE.test(t)) hide(el,null);
    });
    // Ranged unfenced blocks
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

  const PROMPT_EXTRA = `- CLAUDE EXECUTION FOCUS: Prefer ANALYTICAL, STEP-BY-STEP reasoning. When the user wants you to change game settings (Lighting, Workspace, ReplicatedStorage, ServerScriptService, StarterGui, HttpService etc.) ALWAYS use execute_luau with direct Instance property manipulation — never describe it in text. For Play/Stop, call start_stop_play. You excel at structured, complex builds — use the OP blueprint methods below.`;

  return {
    id: "claude",
    displayName: "Claude",
    timings,
    supportsVision: true,
    chipAtItemLevel: true,
    reliableCounts: false,
    coverTarget,
    coverMaxH: 300,
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
    itemKey: (it)=> it? (it.getAttribute("data-message-id")||null): null,
    readAssistant, streamLen, snapshot,
  };
})();
