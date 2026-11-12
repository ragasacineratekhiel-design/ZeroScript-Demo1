// Run: node tests/test-extension.js (Node 18+, no npm dependencies).
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const ROOT=path.join(__dirname,'..','zeroscript-extension-v2');
const source=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
let passed=0;
function check(name, fn){fn();passed++;console.log('PASS',name);}
const parse=new Function(source('core/parser.js')+';return ZSParse')();
check('multiple JSON mutations are not silently discarded',()=>assert.equal(parse.parseToolCalls('{"command":"a"}\n{"command":"b"}').length,2));
check('multiple bare Lua calls reach the multi-tool guard',()=>assert.equal(parse.parseToolCalls('###LUA###return 1###END_LUA###\n###LUA###return 2###END_LUA###').length,2));
check('open second Lua block is detected',()=>assert.equal(parse.hasOpenToolBlock('###LUA###return 1###END_LUA###\n###LUA###return 2'),true));
check('marker inside Lua string does not amputate source',()=>{
  const code='local marker = "###LUA###"\nreturn marker';
  assert.equal(parse.parseToolCalls(JSON.stringify({command:'execute_luau',params:{code}}))[0].arguments.code,code);
});
check('same-prefix same-length parser cache cannot alias commands',()=>{
  const a='{"command":"execute_luau","params":{"code":"'+ ' '.repeat(70)+'return 1"}}';
  const b=a.replace('return 1','return 2');
  assert.notEqual(parse.parseToolCallsCached(a)[0].arguments.code,parse.parseToolCallsCached(b)[0].arguments.code);
});
check('open later MCP and JSON blocks are detected',()=>{
  assert.equal(parse.hasOpenToolBlock('###MCP_TOOL###{"command":"a"}###END_MCP_TOOL###\n###MCP_TOOL###'),true);
  assert.equal(parse.hasOpenToolBlock('{"command":"a"}\n{"command":"b"'),true);
});
let now=10000,tick;
const stable={Date:{now:()=>now},setTimeout(){},setInterval(fn){tick=fn;},clearInterval(){},console,chrome:{runtime:{sendMessage(msg,cb){cb({studio:stable.studio});}}}};
vm.createContext(stable);vm.runInContext(source('core/agent_stability.js')+';this.api=ZSAgentStability',stable);
check('generation grace expires without self-renewing',()=>{
  let raw=true;const g=stable.api.makeGenerationHelper(()=>raw,{streamCheck:()=>10,idleMs:900});
  assert.equal(g(),true);raw=false;for(let i=0;i<100;i++){now+=100;g();}assert.equal(g(),false);
});
function element(tag,children=[]){
  return {nodeType:1,tagName:tag.toUpperCase(),matches:()=>false,childNodes:children.map(c=>typeof c==='string'?{nodeType:3,nodeValue:c}:c)};
}
check('generic provider preserves structural Lua newlines',()=>{
  const c={document:{},location:{},window:{},setTimeout(){}};vm.createContext(c);vm.runInContext(source('providers/generic.js')+';this.p=ZSGenericProvider',c);
  const text=c.p.itemText(element('div',[element('div',['-- comment']),element('div',['return 1'])]));
  assert.match(text,/-- comment\nreturn 1/);
});
check('Claude exports the required core contract',()=>{
  const c={document:{},location:{},window:{},setTimeout(){}};vm.createContext(c);vm.runInContext(source('providers/claude.js')+';this.p=ZSProvider',c);
  for(const name of ['getEditor','editorText','chatIsEmpty','isFreshChat','composerFrame','barMount','readAssistant','installSendHooks'])assert.equal(typeof c.p[name],'function',name);
});
check('team prompt is short, role-specific, honest and bridge-mediated',()=>{
  const config=new Function(source('core/config.js')+';return ZS')();
  const p=config.buildTeamPrompt({name:'Claude',role:'planner',status:{self:{team:'studio'}}});
  assert.ok(p.length<5000);assert.match(p,/You are Claude, the planner/);assert.match(p,/team_send/);assert.match(p,/not proof/);
  assert.match(p,/I am not directly communicating with the others try/);
  assert.ok(p.length<config.buildSystemPrompt().length/2);
});
check('team inbox batches never acknowledge text outside the safe prompt budget',()=>{
  const config=new Function(source('core/config.js')+';return ZS')();
  const messages=Array.from({length:8},(_,id)=>({id,from:'Gemini',role:'checker',timestamp:'now',text:'x'.repeat(12000)}));
  const batch=config.buildTeamInbox(messages,30000);
  assert.equal(batch.messages.length,1);
  assert.ok(batch.text.length<=24000);
  assert.equal(batch.messages[0].id,0);
  assert.throws(()=>config.buildTeamInbox(messages,5000),/exceeds/);
});
async function main(){
  let drops=0;stable.studio=true;stable.api.startStudioMonitor(()=>{},()=>drops++);await tick();stable.studio=false;
  for(let i=0;i<5;i++){now+=1800;await tick();}
  check('sustained Studio drop callback fires once',()=>assert.equal(drops,1));
  let fetches=[];
  class FakeSocket {static OPEN=1;static CONNECTING=0;constructor(){this.readyState=0;}close(){}}
  const session={};
  const c={console,crypto:webcrypto,Date,Math,Promise,Map,ArrayBuffer,TextDecoder,AbortController,URL,WebSocket:FakeSocket,setTimeout,clearTimeout,setInterval(){},
    fetch:async(url,opts={})=>{
      fetches.push({url,opts});return {ok:true,status:200,json:async()=>url.endsWith('/api/token')?{token:'test-token'}:{ok:true,self:{role:JSON.parse(opts.body||'{}').role}}};
    },
    chrome:{runtime:{id:'extension-id',onMessage:{addListener(){}},onStartup:{addListener(){}},onInstalled:{addListener(){}},sendMessage:async()=>{}},
      tabs:{query:async()=>[],sendMessage:async()=>({ok:true}),onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
      storage:{session:{get:async()=>session,set:async values=>Object.assign(session,values)}},alarms:{create(){},onAlarm:{addListener(){}}}}
  };
  vm.createContext(c);vm.runInContext(source('background.js')+';this.api={handle};',c);
  await new Promise(r=>setImmediate(r));
  const sender={id:'extension-id',tab:{id:1,url:'https://claude.ai/new'}};
  c.wsCalls=0;
  vm.runInContext("connected=true;sendWS=async()=>{globalThis.wsCalls++;await new Promise(r=>setTimeout(r,350));return {ok:true,text:'real'};}",c);
  fetches=[];
  const r=await c.api.handle({type:'call_tool',name:'execute_luau',arguments:{code:'return 1'}},sender);
  check('slow WebSocket mutation does not hedge to HTTP',()=>{assert.equal(r.ok,true);assert.equal(c.wsCalls,1);assert.equal(fetches.length,0);});
  const results=await Promise.all([c.api.handle({type:'call_tool',name:'same'},sender),c.api.handle({type:'call_tool',name:'same'},sender)]);
  check('distinct concurrent callers both get actual results, not placeholders',()=>assert.ok(results.every(r=>r.ok&&r.text==='real')));
  vm.runInContext('connected=false;',c);fetches=[];
  c.fetch=async(url)=>{fetches.push(url);throw Error('network lost');};
  await c.api.handle({type:'call_tool',name:'mutation'},sender);
  check('failed HTTP mutation is not automatically replayed',()=>assert.equal(fetches.length,1));
  const bad=await c.api.handle({type:'call_tool',name:'mutation'},{id:'extension-id',tab:{id:2,url:'https://evil.example/chatgpt.com'}});
  check('provider trust uses hostname, not a substring',()=>assert.equal(bad.ok,false));
  c.fetch=async(url,opts)=>({ok:true,status:200,json:async()=>({ok:true,self:{role:JSON.parse(opts.body||'{}').role},members:[1,2,3].map(id=>({id:`tab-${id}-session`}))})});
  for(const [id,role,host] of [[1,'planner','claude.ai'],[2,'coder','chat.deepseek.com'],[3,'checker','gemini.google.com']]){
    const joined=await c.api.handle({type:'team_register',session_id:'session',role,team:'studio'},{id:'extension-id',tab:{id,url:`https://${host}/`}});assert.equal(joined.ok,true);
  }
  let active=0,maxActive=0;
  c.chrome.tabs.sendMessage=async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,20));active--;return {ok:true};};
  const started=await c.api.handle({type:'team_start',team:'studio'},{id:'extension-id'});
  check('three team startup submissions run concurrently',()=>{assert.equal(started.ok,true);assert.equal(maxActive,3);});
  const sent=[];
  c.chrome.storage.local={get:async()=>({zsPlan:'agent',zsPlanRoles:{planner:'Claude',coder:'DeepSeek',checker:'Gemini'}}),set:async()=>{}};
  c.chrome.tabs.query=async()=>[{id:1,url:'https://claude.ai/new'},{id:2,url:'https://chat.deepseek.com/new'}];
  c.chrome.tabs.sendMessage=async(id,msg)=>{sent.push({id,msg});return {ok:true};};
  const routed=await c.api.handle({type:'peer_route',envelope:{fromProvider:'claude',toProvider:'deepseek',payload:{text:'retained legacy route'}}},sender);
  check('main legacy peer routing remains functional alongside bridge teams',()=>{assert.equal(routed.ok,true);assert.equal(routed.delivered,1);assert.equal(sent[0].id,2);assert.equal(sent[0].msg.type,'zs-peer-inbound');});
  const who=await c.api.handle({type:'peer_whoami'},sender);
  check('main role assignments are retained',()=>{assert.equal(who.roles.coder,'DeepSeek');assert.equal(who.plan,'agent');});
  await c.api.handle({type:'agent_temp_write',key:'integration',value:{text:'retained temp'}},sender);
  const temp=await c.api.handle({type:'agent_temp_read',key:'integration'},sender);
  check('main agent temp hub remains functional',()=>assert.equal(temp.payload.value.text,'retained temp'));
  // 4.6.0 role enforcement, subdomain hosts (lmarena.ai, z.ai), and verify_fact routing
  c.fetch=async(url,opts)=>({ok:true,status:200,json:async()=>({ok:true,verified:true,sha256:'a'.repeat(64),self:{id:`m-${JSON.parse(opts.body||'{}').role||'x'}`,role:JSON.parse(opts.body||'{}').role||'coder'}})});
  await c.api.handle({type:'team_register',session_id:'s46',role:'planner',team:'r46'},{id:'extension-id',tab:{id:21,url:'https://claude.ai/new'}});
  await c.api.handle({type:'team_register',session_id:'s46',role:'coder',team:'r46'},{id:'extension-id',tab:{id:22,url:'https://lmarena.ai/c/1'}});
  await c.api.handle({type:'team_register',session_id:'s46',role:'checker',team:'r46'},{id:'extension-id',tab:{id:23,url:'https://z.ai/'}});
  const pBlock=await c.api.handle({type:'call_tool',name:'execute_luau',arguments:{code:'return 1'}},{id:'extension-id',tab:{id:21,url:'https://claude.ai/new'}});
  check('4.6.0 background role gate blocks planner from execute_luau',()=>{assert.equal(pBlock.ok,false);assert.equal(pBlock.kind,'role_violation');});
  const kBlock=await c.api.handle({type:'call_tool',name:'multi_edit',arguments:{}},{id:'extension-id',tab:{id:23,url:'https://z.ai/'}});
  check('4.6.0 background role gate blocks checker from multi_edit',()=>{assert.equal(kBlock.ok,false);assert.equal(kBlock.kind,'role_violation');});
  const cAllow=await c.api.handle({type:'call_tool',name:'execute_luau',arguments:{code:'return 1'}},{id:'extension-id',tab:{id:22,url:'https://lmarena.ai/c/1'}});
  check('4.6.0 background role gate allows coder on lmarena.ai to execute_luau',()=>assert.equal(cAllow.ok,true));
  const vf=await c.api.handle({type:'verify_fact',path:'game.Workspace',tool:'inspect_instance'},{id:'extension-id',tab:{id:21,url:'https://claude.ai/new'}});
  check('4.6.0 verify_fact routes to /api/verify with sha256 proof',()=>{assert.equal(vf.ok,true);assert.equal(vf.verified,true);});
  console.log(`\n${passed} extension regression checks passed.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
