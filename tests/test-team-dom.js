// Optional integration check: npm install, then node tests/test-team-dom.js.
// Simulated chat DOM, not a live AI website. Exercises the actual shared core.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.join(__dirname,'..','zeroscript-extension-v2');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
async function scenario({sendWorks=true,hidden=false,deliverInbox=false,largeInbox=false}={}){
  const errors=[];
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',e=>errors.push(e));
  const dom=new JSDOM('<!doctype html><html><body><main id="messages"></main><form><textarea id="editor"></textarea></form></body></html>',{url:'https://claude.ai/new',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  const w=dom.window;
  if(hidden)Object.defineProperty(w.document,'hidden',{value:true,configurable:true});
  let gen=false,requests=[],listeners=[],ready=0,submissions=[],key='';
  const editor=w.document.getElementById('editor');
  const status={ok:true,self:{id:'mock',name:'Claude',role:'planner',team:'studio',ready:false},peers:[],active:true,communication_confirmed:false,phrase:'I am not directly communicating with the others try joining the other tabs'};
  const items=()=>[...w.document.querySelectorAll('[data-role]')];
  w.fakeProvider={
    id:'claude',displayName:'Claude',timings:{RESPONSE_TIMEOUT_MS:10000,STABLE_MS:1000,WARMUP_MS:1000,REASON_NOREPLY_MS:1000},
    init(){},snapshot:()=>({}),getEditor:()=>editor,editorText:()=>editor.value,chatIsEmpty:()=>items().length===0,isFreshChat:()=>items().length===0,
    conversationKey:()=>key,composerFrame:()=>editor.parentElement,barMount:()=>null,
    allItems:items,isUserItem:el=>el.dataset.role==='user',isAssistantItem:el=>el.dataset.role==='assistant',
    assistantCount:()=>items().filter(i=>i.dataset.role==='assistant').length,userCount:()=>items().filter(i=>i.dataset.role==='user').length,
    lastAssistant:()=>items().filter(i=>i.dataset.role==='assistant').slice(-1)[0]||null,
    itemText:el=>el.textContent,classifyText:el=>el.textContent,streamLen:el=>(el||w.fakeProvider.lastAssistant())?.textContent.length||0,
    readAssistant:()=>{const item=w.fakeProvider.lastAssistant();return {present:!!item,reply:item?.textContent||'',thinking:'',item};},
    isGenerating:()=>gen,isHardGenerating:()=>gen,isBusyNow:()=>gen,setInputLock(){},stopGeneration(){gen=false;},enforceComposer:()=>({ready:true}),ensureComposerReady:async()=>({ready:true}),
    turnHalted:()=>false,findContinueBtn:()=>null,scanError:()=>null,isTooLongMsg:()=>false,installSendHooks(){},findToolBlockSpot:()=>null,
    typeAndSend:async text=>{
      submissions.push(text);
      if(!sendWorks){editor.value='';return;} // tests the old false-positive empty-editor gate
      const user=w.document.createElement('div');user.dataset.role='user';user.textContent=text;w.document.getElementById('messages').appendChild(user);
      editor.value='';gen=true;
      setTimeout(()=>{key='/chat/test';const assistant=w.document.createElement('div');assistant.dataset.role='assistant';assistant.textContent='I am the planner; I will wait for my introduction turn.';w.document.getElementById('messages').appendChild(assistant);gen=false;},30);
    }
  };
  w.chrome={runtime:{id:'test-extension',getManifest:()=>({version:'3.1.0'}),onMessage:{addListener:fn=>listeners.push(fn)},lastError:null,
    sendMessage:(msg,callback)=>{
      requests.push(msg);
      const r=msg.type==='team_register'?status:msg.type==='team_status'?status:msg.type==='team_ready'?(ready++,status.self.ready=true,status):msg.type==='team_inbox'?{ok:true,messages:deliverInbox&&ready&&!requests.some(m=>m.type==='team_ack')?Array.from({length:largeInbox?8:1},(_,i)=>({id:17+i,timestamp:'2026-11-11T00:00:00+00:00',from:'Gemini',role:'checker',text:largeInbox?'Please inspect '+ 'x'.repeat(11900):'Please inspect this task.'})):[]}:msg.type==='status'?{connected:false,tools:0,servers:[]}:{ok:true};
      queueMicrotask(()=>callback?.(r));
    }},storage:{local:{get:(key,callback)=>queueMicrotask(()=>callback({})),set(){}}}};
  try {
    w.eval(read('core/config.js')+'\n'+read('core/parser.js')+'\nconst ZSProvider=window.fakeProvider;\n'+read('core/main.js'));
    function message(msg){return new Promise(resolve=>{let handled=false;for(const listener of listeners){if(listener(msg,{id:'test-extension'},resolve)===true)handled=true;}if(!handled)resolve({ok:false,error:'no listener'});});}
    await new Promise(r=>setImmediate(r));
    const joined=await message({type:'zs-team-join',role:'planner',team:'studio'});assert.equal(joined.ok,true);
    const result=await message({type:'zs-team-start'});
    assert.equal(result.ok,sendWorks,JSON.stringify(result));
    assert.equal(ready,sendWorks?1:0,'ready requires actual submitted-turn evidence');
    assert.equal(submissions.length,1,'team startup must not resend an ambiguous prompt');
    if(deliverInbox){
      const deadline=Date.now()+5000;
      while(!requests.some(m=>m.type==='team_ack'&&m.ids.includes(17))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
      assert.ok(requests.some(m=>m.type==='team_ack'&&m.ids.includes(17)),'background team inbox must be submitted and acknowledged');
      assert.equal(submissions.length,2,'one startup and one real inbox submission');
      assert.match(submissions[1],/Gemini \/ checker/);
      if(largeInbox){assert.equal(requests.find(m=>m.type==='team_ack').ids.length,1,'only fully submitted message is acknowledged');assert.ok(submissions[1].length<=24000);}
    }
    assert.ok(!requests.some(m=>m.type==='list_tools'),'team startup does not wait for Studio catalogue');
    await message({type:'zs-team-stop'});
    await new Promise(r=>setTimeout(r,180));
    assert.equal(errors.length,0,errors.map(String).join('\n'));
    console.log('PASS actual core DOM startup:',sendWorks?'submitted':'refused empty-editor false positive',hidden?'(background tab)':'');
  } finally {dom.window.close();}
}
(async()=>{await scenario();await scenario({hidden:true,deliverInbox:true,largeInbox:true});await scenario({sendWorks:false});})().catch(e=>{console.error(e);process.exitCode=1;});
