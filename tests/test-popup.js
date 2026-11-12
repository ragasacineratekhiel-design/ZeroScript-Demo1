// Real popup UI, mocked browser transport. No real tabs/bridge.
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..','zeroscript-extension-v2');
(async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'popup.html'),'utf8'),{url:'https://extension.test/popup.html',runScripts:'outside-only'});
 const w=dom.window,messages=[];let unavailable=false;
 w.chrome={runtime:{getManifest:()=>({version:'3.1.0'}),onMessage:{addListener(){}},sendMessage:(msg,cb)=>cb?.({connected:false})},storage:{local:{get:(k,cb)=>cb({})}},tabs:{query:async()=>[{id:7}],sendMessage:async(id,msg)=>{messages.push(msg.type);if(unavailable)throw new Error('No receiving end');return {ok:true,name:'Gemini',version:'3.1.0',composer:true,toolbar:true,toolbarVisible:true,running:false,starting:false,generating:false,team:{joined:false,active:false},note:msg.type==='zs-stop-tab'?'Local stop requested. Bridge operations are not undone.':undefined};}}};
 const settle=()=>new Promise(r=>setTimeout(r,10));
 try{
  w.eval(fs.readFileSync(path.join(root,'popup.js'),'utf8'));await settle();
  assert.match(w.document.querySelector('#tab-result').textContent,/Gemini/);
  assert.match(w.document.querySelector('#state').textContent,/start.py/);
  w.document.querySelector('#tab-recover').click();await settle();assert.ok(messages.includes('zs-recover-toolbar'));
  w.document.querySelector('#tab-stop').click();await settle();assert.match(w.document.querySelector('#tab-result').textContent,/not undone/);
  unavailable=true;w.document.querySelector('#tab-refresh').click();await settle();
  assert.match(w.document.querySelector('#tab-result').textContent,/No ZeroScript adapter responding/);
  assert.equal(w.document.querySelector('#tab-refresh').disabled,false);
  w.chrome.tabs.sendMessage=()=>new Promise(()=>{});
  await assert.rejects(w.tabRequest(7,'zs-tab-status',10),/No automatic retry/);
  console.log('PASS real popup controls, recovery, stop warning, missing-adapter guidance and Python launcher instructions');
 }finally{w.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
