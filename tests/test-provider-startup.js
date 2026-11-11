// Manifest-ordered startup smoke tests. Synthetic pages, no real provider/API.
const {JSDOM,VirtualConsole}=require('jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..','zeroscript-extension-v2');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
(async()=>{
 for(const entry of manifest.content_scripts.filter(e=>e.js.includes('core/main.js'))){
  const listeners=[];
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
  const url=entry.matches[0].replace('*.', '').replace('*','new');
  const d=new JSDOM('<!doctype html><body><main><form><textarea placeholder="Message"></textarea><div class="ProseMirror" contenteditable="true" role="textbox" data-placeholder="Reply to Claude"></div><button type="button" aria-label="Send message">Send</button></form></main></body>',{url,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=d.window;
  w.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:400,top:400,left:0,right:700,bottom:600,width:700,height:200});
  Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.parentElement;}});
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.chrome={runtime:{id:'fixture',getManifest:()=>({version:'3.1.0'}),onMessage:{addListener(fn){listeners.push(fn);}},sendMessage:(m,cb)=>queueMicrotask(()=>{if(!w.document)return;cb?.(m.type==='status'?{connected:false,studio:false,tools:0,servers:[]}:{ok:false,error:'Mock disconnected'});})},storage:{local:{get:(k,cb)=>queueMicrotask(()=>{if(w.document)cb({});}),set(){}}}};
  try{
   w.eval(entry.js.map(p=>fs.readFileSync(path.join(root,p),'utf8')).join('\n')+'\nwindow.provider=ZSProvider;');
   await new Promise(r=>setTimeout(r,200));
   assert.ok(w.document.querySelector('#zs-bar'),'toolbar missing: '+url);
   assert.equal(errors.length,0,errors.map(String).join('\n'));
   assert.ok(w.provider.getEditor(),'no composer: '+url);
   function control(type,sender='fixture'){
    let response;
    for(const fn of listeners)fn({type},{id:sender},r=>{response=r;});
    return response;
   }
   const status=control('zs-tab-status');
   assert.equal(status.ok,true);assert.equal(status.composer,true);
   assert.equal(status.toolbarVisible,true);
   assert.equal(control('zs-tab-status','other-extension').ok,false);
   w.document.querySelector('#zs-bar').remove();
   assert.equal(control('zs-recover-toolbar').toolbarVisible,true,'recovery reattaches existing toolbar');
   assert.equal(w.document.querySelectorAll('#zs-bar').length,1,'recovery must not duplicate controls');
   const stopped=control('zs-stop-tab');assert.equal(stopped.ok,true);
   assert.match(stopped.note,/not undone/);

   console.log('PASS manifest-ordered mock startup',url);
  }finally{w.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
