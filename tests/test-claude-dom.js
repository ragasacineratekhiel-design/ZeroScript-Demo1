// Actual Claude adapter + shared interface, synthetic DOM only. No model involved.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.join(__dirname,'..','zeroscript-extension-v2');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
async function run(){
 const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM('<!doctype html><body><nav>Not an assistant reply</nav><main><div class="group">Not a message either</div><form data-testid="composer"><div class="ProseMirror" contenteditable="true" role="textbox"><p></p></div><button type="button" aria-label="Send message">Send</button></form></main></body>',{url:'https://claude.ai/new',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window;
 // JSDOM has no layout engine; supply explicit fixture geometry.
 w.HTMLElement.prototype.getBoundingClientRect=function(){return {x:0,y:500,top:500,left:0,right:600,bottom:620,width:600,height:120};};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.chrome={runtime:{id:'fixture',getManifest:()=>({version:'3.1.0'}),onMessage:{addListener(){}},sendMessage:(m,cb)=>queueMicrotask(()=>cb?.(m.type==='status'?{connected:false,tools:0,servers:[]}:{ok:false,error:'Mock bridge intentionally disconnected'}))},storage:{local:{get:(k,cb)=>queueMicrotask(()=>cb({})),set(){}}}};
 try{
  w.eval(read('core/config.js')+'\n'+read('core/agent_stability.js')+'\n'+read('core/transport.js')+'\n'+read('core/parser.js')+'\n'+read('providers/claude.js')+'\nwindow.adapter=ZSProvider;\n'+read('core/main.js'));
  const p=w.adapter;
  assert.equal(p.allItems().length,0,'layout is not assistant output');
  assert.equal(p.getEditor().getAttribute('role'),'textbox');
  assert.equal(p.barMount().parent.id,'zs-claude-toolbar-slot');
  assert.equal(p.barMount().parent.nextElementSibling,w.document.querySelector('form'));
  assert.equal(p.barMount().inside,false);
  const deadline=Date.now()+4000;
  while(!w.document.querySelector('#zs-bar')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
  const bar=w.document.querySelector('#zs-bar');assert.ok(bar,'actual shared toolbar must exist on Claude fixture');
  assert.ok(bar.querySelector('button'),'toolbar has actionable controls');
  p.setInputLock(true);assert.ok(p.getEditor(),'locked composer remains discoverable');p.setInputLock(false);
  const turn=w.document.createElement('div');turn.dataset.testid='assistant-message';turn.innerHTML='<div class="markdown">Actual fixture reply</div>';w.document.querySelector('main').prepend(turn);
  const nested=w.document.createElement('div');nested.dataset.messageAuthorRole='assistant';nested.textContent='nested';turn.appendChild(nested);
  assert.equal(p.assistantCount(),1,'nested message markers must not double-count one reply');assert.match(p.itemText(p.lastAssistant()),/Actual fixture reply/);
  // Simulate Claude replacing its entire composer during SPA rendering.
  const oldForm=w.document.querySelector('form');
  const replacement=oldForm.cloneNode(true);replacement.querySelector('#zs-bar')?.remove();
  oldForm.replaceWith(replacement);
  await new Promise(r=>setTimeout(r,180));
  assert.ok(w.document.querySelector('#zs-claude-toolbar-slot #zs-bar'),'toolbar must remount after composer replacement');
  assert.equal(w.document.querySelector('form #zs-bar'),null,'toolbar must stay outside the composer');
  assert.equal(w.document.querySelectorAll('#zs-claude-toolbar-slot').length,1,'SPA replacement must not duplicate slots');
  assert.equal(p.getEditor().isConnected,true,'cached detached editor must be discarded');
  let clicks=0,enters=0;
  const editor=p.getEditor(),button=w.document.querySelector('[aria-label="Send message"]');
  Object.defineProperty(button,'offsetParent',{get:()=>button.parentElement});
  w.document.execCommand=(cmd,unused,text)=>{if(cmd==='insertText'){editor.textContent=text;return true;}return false;};
  button.addEventListener('click',()=>{clicks++;}); // simulate a slow site that does not clear input
  editor.addEventListener('keydown',e=>{if(e.key==='Enter')enters++;});
  await p.typeAndSend('Mock Claude submission');
  assert.equal(clicks,1,'a slow send receives one click only');
  assert.equal(enters,0,'no duplicate Enter after a potentially accepted click');
  replacement.hidden=true;
  assert.equal(p.getEditor(),null,'stability wrapper must not resurrect a hidden composer');
  replacement.hidden=false;
  assert.equal(errors.length,0,errors.map(String).join('\n'));
  console.log('PASS actual Claude adapter + toolbar mounts; composer lock survives; page chrome rejected; assistant extracted (mock DOM, not live Claude)');
 }finally{await new Promise(r=>setTimeout(r,250));w.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
