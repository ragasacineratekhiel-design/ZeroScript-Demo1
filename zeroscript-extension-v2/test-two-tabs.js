// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-two-tabs.js — END-TO-END cross-AI proof.
//
// The unit suite (test-peer-wall.js) proves the peer_wall module in isolation.
// This proves the WHOLE assembled feature: every core module from the real
// manifest, two separate realms with real hostnames, and the actual claim —
// that one AI's message ends up in a DIFFERENT AI's prompt text.
//
// It exists because "2-3 AI work together" was false for three versions while
// every unit test that existed still passed.
const fs = require("fs"), path = require("path"), vm = require("vm");
let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  -> " + detail : "")); }
}
const E=__dirname;
const mf=JSON.parse(fs.readFileSync(path.join(E,"manifest.json"),"utf8"));
const core=(mf.content_scripts[0].js||[]).filter(f=>!/^providers\//.test(f)&&!/main\.js$/.test(f));

function realm(host){
  const errors=[];
  const store={};
  function stubEl(tag="div"){ const el={tagName:tag.toUpperCase(),children:[],attributes:{},style:{},dataset:{},classList:{add(){},remove(){},contains(){return false},toggle(){}},textContent:"",innerHTML:"",value:"",checked:false,disabled:false,hidden:false,
    appendChild(c){this.children.push(c);return c},removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);return c},
    insertBefore(c){this.children.push(c);return c},remove(){},setAttribute(k,v){this.attributes[k]=String(v)},getAttribute(k){return this.attributes[k]??null},
    removeAttribute(k){delete this.attributes[k]},hasAttribute(k){return k in this.attributes},addEventListener(){},removeEventListener(){},
    dispatchEvent(){return true},focus(){},blur(){},click(){},querySelector(){return null},querySelectorAll(){return []},
    getBoundingClientRect(){return{left:0,top:0,right:0,bottom:0,width:100,height:20}},contains(){return false},
    cloneNode(){return stubEl(tag)},attachShadow(){return stubEl("shadow")},matches(){return false},closest(){return null} };
    el.parentElement=null; return el; }
  const doc={ documentElement:stubEl("html"), body:stubEl("body"), head:stubEl("head"),
    hidden:false, visibilityState:"visible", title:"t", cookie:"",
    createElement:(t)=>stubEl(t), createElementNS:(ns,t)=>stubEl(t), createTextNode:(t)=>({nodeType:3,textContent:t}),
    createRange:()=>({selectNodeContents(){},collapse(){},setStart(){},setEnd(){}}),
    createTreeWalker:()=>({nextNode:()=>null}),
    getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[],
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){return true},
    execCommand(){}, elementFromPoint:()=>null, getSelection:()=>({rangeCount:0,addRange(){},removeAllRanges(){},getRangeAt:()=>({})}) };
  const ctx={ console:{log(){},warn(){},error(){},info(){},debug(){}}, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect,
    setTimeout:(fn)=>{try{fn&&fn()}catch(e){errors.push(String(e&&e.message||e))}return 0}, clearTimeout(){}, setInterval:()=>0, clearInterval(){},
    queueMicrotask:(fn)=>{try{fn()}catch(e){errors.push(String(e&&e.message||e))}},
    requestAnimationFrame:(fn)=>{try{fn&&fn(0)}catch (e) { globalThis.ZSSafe?.seen?.("test-two-tabs.stubEl", e); }return 0}, cancelAnimationFrame(){},
    performance:{now:()=>Date.now()}, document:doc,
    location:{hostname:host,href:"https://"+host+"/",pathname:"/",search:"",origin:"https://"+host},
    navigator:{userAgent:"Mozilla/5.0 (e2e)",language:"en-US",clipboard:{writeText:async()=>{}}},
    history:{pushState(){},replaceState(){},state:null},
    chrome:{ runtime:{ id:"ext", lastError:null, getManifest:()=>({version:mf.version}),
        sendMessage:()=>{}, onMessage:{addListener(){},removeListener(){}}, onStartup:{addListener(){}}, onInstalled:{addListener(){}} },
      storage:{ local:{ get:(k,cb)=>{const r={};cb&&cb(r);return Promise.resolve(r)}, set:(o,cb)=>{Object.assign(store,o);cb&&cb();return Promise.resolve()}, remove:()=>Promise.resolve() },
        onChanged:{addListener(){}} },
      tabs:{query:()=>Promise.resolve([]),sendMessage:()=>Promise.resolve()}, alarms:{create(){},onAlarm:{addListener(){}}} },
    BroadcastChannel:undefined, getComputedStyle:()=>({getPropertyValue:()=>""}),
    innerWidth:1920, innerHeight:1080, devicePixelRatio:1,
  };
  ctx.window=ctx; ctx.self=ctx; ctx.globalThis=ctx;
  vm.createContext(ctx);
  for(const rel of core){
    const p=path.join(E,rel); if(!fs.existsSync(p)) continue;
    try{ vm.runInContext(fs.readFileSync(p,"utf8"), ctx, {filename:host+":"+rel}); }
    catch(e){ errors.push("LOAD "+rel+": "+e.message); }
  }
  return {ctx, errors, host};
}

const chatgpt=realm("chatgpt.com");
const claude=realm("claude.ai");


check("ChatGPT realm boots every core module from the manifest", chatgpt.errors.length === 0, JSON.stringify(chatgpt.errors.slice(0,2)));
check("Claude realm boots every core module from the manifest", claude.errors.length === 0, JSON.stringify(claude.errors.slice(0,2)));

const CW=chatgpt.ctx.ZSPeerWall, LW=claude.ctx.ZSPeerWall;

check("each tab derives its own provider identity", CW && CW.self === "chatgpt" && LW && LW.self === "claude", (CW&&CW.self)+"/"+(LW&&LW.self));


const roles={planner:"chatgpt",coder:"claude",checker:"deepseek"};
const sent=CW.sendToRole(roles,"coder","task",{text:"build the shop GUI, use bulk execute_luau",role:"coder"});
check("cross-provider send is accepted", sent.ok === true, sent.refused);
const recv=LW.receive(sent.envelope,"runtime");
check("the peer realm accepts the envelope", recv.ok === true, recv.reason);
const inbound=LW.takeInbound(5);
const prompt=LW.formatForPrompt(inbound);
check("THE CLAIM: the sender's words are in the receiver's prompt", /bulk execute_luau/.test(prompt));
check("the prompt names which model spoke", /CHATGPT/.test(prompt));
check("the prompt forbids impersonating the peer", /NOT you/.test(prompt));


const self=CW.sendToRole({planner:"chatgpt",coder:"chatgpt"},"coder","task",{text:"talk to myself"});
check("a same-provider send is refused", self.ok === false && self.refused === "same-provider");


const rG = CW.resolveRoles("chatgpt",roles,["planner","coder","checker"]).role;
check("roles follow the user mapping, not tab order", rG === "planner", rG);
const rC = LW.resolveRoles("claude",roles,["planner","coder","checker"]).role;
check("the two tabs get different roles", rC === "coder" && rC !== rG, rC);


// 4.6.0 role permission matrix + slash-alias enhancer + team inbox bypass
const ZSRef = chatgpt.ctx.ZS;
check("ZS.roleAllowsTool blocks planner from execute_luau", ZSRef.roleAllowsTool("planner", "execute_luau").ok === false);
check("ZS.roleAllowsTool blocks checker from multi_edit", ZSRef.roleAllowsTool("checker", "multi_edit").ok === false);
check("ZS.roleAllowsTool allows coder to execute_luau", ZSRef.roleAllowsTool("coder", "execute_luau").ok === true);
check("ZS.roleAllowsTool allows planner & checker to verify_fact and team_send",
  ZSRef.roleAllowsTool("planner", "verify_fact").ok === true && ZSRef.roleAllowsTool("checker", "team_send").ok === true);

const PE = claude.ctx.ZSPromptEnhancer;
const parsedAliases = PE.parseSlash("/brutal-honest /0%-Lies /Follow-Everything /Absolute-effort /code build shop");
check("ZSPromptEnhancer maps /brutal-honest, /0%-Lies, /Follow-Everything, /Absolute-effort",
  ["truth", "prompt", "force", "code"].every((m) => parsedAliases.cmds.includes(m)),
  JSON.stringify(parsedAliases.cmds));
let sentText = null;
const mockProv = { id: "claude", typeAndSend: async (t) => { sentText = t; } };
PE.wrapTypeAndSend(mockProv);
const inboxMsg = "(System note: Bridge team inbox — actual messages queued for you)\n[Planner]: build shop";
mockProv.typeAndSend(inboxMsg);
check("wrapTypeAndSend leaves Bridge team inbox untouched", sentText === inboxMsg);

// the audit removes the first two lines of scratch console output
console.log("\n" + pass + "/" + (pass + failed) + " passed" + (failed ? ", " + failed + " FAILED" : ""));
process.exit(failed ? 1 : 0);
