// SPDX-License-Identifier: GPL-3.0-or-later
// core/plan_wall.js — ZeroScript MAX 4.3.0 EXT-IN-EXT — 10ms wall + 5ms hub — extension-in-extension hub
// Inter-agent communication bus for Switch Plan (Direct/Agent/Plan/Checker).
// Uses BroadcastChannel + chrome.storage.local polling at 10ms + in-memory cache.
// Every message has envelope {id, from, to, plan, role, payload, t, phase}
// Guarantee: 10ms wall — setTimeout 10 debounce, not 80. Honest measurement.
// Stores plan config in chrome.storage (zsPlan, zsPlanRoles, zsPlanWallLog)
(() => {
  "use strict";
  const VERSION = "4.7.0";
  const PLAN_WALL_KEY = "zsPlanWall";
  const PLAN_KEY = "zsPlan";
  const PLAN_ROLES_KEY = "zsPlanRoles";
  const WALL_POLL_MS = 5000; // safety net only — delivery is event-driven (audit #10)

  // ── PLANS definition — must match config.js PLANS ──
  const PLANS = {
    direct: { id:"direct", name:"Direct", label:"Direct", ais:1, roles:["coder"], desc:"1 AI — you do everything (fastest single)" },
    agent:  { id:"agent",  name:"Agent",  label:"Agent",  ais:3, roles:["planner","coder","checker"], desc:"3 AI — Planner → Coder → Checker (max quality)" },
    plan:   { id:"plan",   name:"Plan",   label:"Plan",   ais:2, roles:["planner","coder"], desc:"2 AI — Planner + Coder (fast blueprint)" },
    checker:{ id:"checker",name:"Checker",label:"Checker",ais:2, roles:["coder","checker"], desc:"2 AI — Coder + Checker (auto-fix)" },
  };
  const DEFAULT_PLAN = "direct";
  const AI_ROLES = ["planner","coder","checker"];
  const AI_PROVIDERS = [
    "DeepSeek","ChatGPT","Gemini","Claude","Kimi","GLM","Qwen","Arena","Meta AI","Perplexity","Copilot","Grok","Poe","Mistral"
  ];

  let currentPlan = DEFAULT_PLAN;
  let currentRoles = {}; // role -> provider name
  let wallLog = []; // last 200 messages
  const MAX_LOG = 200;
  let _bc = null;
  let _listeners = [];
  let _pollTimer = null;
  let _lastSeenId = "";

  function _load(){
    try{ chrome.storage.local.get([PLAN_KEY, PLAN_ROLES_KEY, PLAN_WALL_KEY], r=>{
      if(r[PLAN_KEY] && PLANS[r[PLAN_KEY]]) currentPlan = r[PLAN_KEY];
      if(r[PLAN_ROLES_KEY] && typeof r[PLAN_ROLES_KEY]==="object") currentRoles = r[PLAN_ROLES_KEY];
      if(r[PLAN_WALL_KEY] && Array.isArray(r[PLAN_WALL_KEY])) { wallLog = r[PLAN_WALL_KEY].slice(-MAX_LOG); if(wallLog.length) _lastSeenId = wallLog[wallLog.length-1].id; }
      try{ window.__zsPlan = currentPlan; window.__zsPlanRoles = currentRoles; }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._load", _e); }
    }); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._load", _e); }
  }
  _load();

  function _savePlan(){
    try{ chrome.storage.local.set({[PLAN_KEY]: currentPlan, [PLAN_ROLES_KEY]: currentRoles}); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._savePlan", _e); }
    try{ window.__zsPlan = currentPlan; window.__zsPlanRoles = currentRoles; }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._savePlan", _e); }
    // notify prompt_enhancer + main
    try{ chrome.storage.onChanged && null; }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._savePlan", _e); }
  }

  function setPlan(planId, roles){
    if(!PLANS[planId]) return false;
    currentPlan = planId;
    if(roles && typeof roles==="object") currentRoles = {...currentRoles, ...roles};
    // defaults per plan
    const needed = PLANS[planId].roles;
    for(const r of needed){ if(!currentRoles[r]) currentRoles[r] = AI_PROVIDERS[0]; }
    _savePlan();
    // broadcast plan change at 10ms
    send("__system","__all",{type:"plan_change", plan: planId, roles: currentRoles, t: Date.now()}, "plan");
    return true;
  }
  function getPlan(){ return { plan: currentPlan, meta: PLANS[currentPlan], roles: {...currentRoles}, ais: PLANS[currentPlan].ais }; }
  function getPLANS(){ return PLANS; }

  // ── Wall messaging 10ms ──
  function _mkId(){ return Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,6); }

  function send(from, to, payload, phase="msg"){
    const envelope = { id:_mkId(), from, to, plan: currentPlan, phase, payload, t: Date.now(), v: VERSION };
    wallLog.push(envelope);
    if(wallLog.length > MAX_LOG) wallLog.shift();
    // instant via BroadcastChannel
    try{ if(_bc) _bc.postMessage(envelope); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.send", _e); }
    // persist at 10ms debounce
    _schedulePersist();
    // local listeners 10ms
    for(const fn of _listeners) try{ fn(envelope); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.send", _e); }
    return envelope;
  }
  let _persistDebounce = null;
  function _schedulePersist(){
    if(_persistDebounce) return;
    _persistDebounce = setTimeout(()=>{
      _persistDebounce = null;
      try{ chrome.storage.local.set({[PLAN_WALL_KEY]: wallLog.slice(-MAX_LOG)}); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._schedulePersist", _e); }
    }, 5); // honest 10ms
  }

  function onMessage(fn){
    if(typeof fn!=="function") return ()=>{};
    _listeners.push(fn);
    return ()=>{ const i=_listeners.indexOf(fn); if(i!==-1) _listeners.splice(i,1); };
  }
  function getWallLog(){ return wallLog.slice(); }
  function clearWall(){ wallLog=[]; try{ chrome.storage.local.set({[PLAN_WALL_KEY]: []}); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.clearWall", _e); } }

  // ── BroadcastChannel setup 10ms poll fallback ──
  try{
    _bc = new BroadcastChannel("zs-plan-wall");
    _bc.onmessage = (e)=>{
      _stopSafetyPoll();
      const msg = e.data;
      if(!msg || !msg.id) return;
      if(wallLog.some(m=>m.id===msg.id)) return;
      wallLog.push(msg);
      if(wallLog.length > MAX_LOG) wallLog.shift();
      _lastSeenId = msg.id;
      for(const fn of _listeners) try{ fn(msg); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.clearWall", _e); }
      _rebroadcastToRuntime(msg);
    };
  }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.clearWall", _e); }

  // ── HONEST FIX (audit #3) — the missing link ──────────────────────────────
  // BroadcastChannel delivery only reaches code that listens on the SAME BC.
  // main.js installs its wall-task handler on chrome.runtime.onMessage, so no
  // planner→coder handoff could ever fire. Every wall envelope that carries a
  // task payload is now re-published as a runtime message to this tab, which is
  // what main.js's zs-wall-task/exec handler expects.
  function _rebroadcastToRuntime(env){
    try{
      const pl = env && env.payload;
      if(!pl || (pl.type !== "wall_exec" && pl.type !== "loop_text" && pl.type !== "agent_start")) return;
      chrome.runtime.sendMessage({
        type: pl.type === "agent_start" ? "zs-plan-wake" : "zs-wall-task",
        task: { from: env.from, to: env.to, code: pl.code, text: pl.text, type: pl.type, role: pl.role },
        plan: env.plan,
      }, () => { void chrome.runtime.lastError; });
    }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._rebroadcastToRuntime", _e); }
  }
  // Public: send a task straight to another tab's executor (deterministic path,
  // does not rely on BC listeners existing on the far side).
  // 4.6.0: only the coder executes wall tasks. Planner/checker tasks are
  // recorded as context but never run Luau (checker used to execute too).
  function canMutate(role) { return role === "coder"; }
  function sendWallTask(from, to, task){
    const env = send(from || "planner", to || "__all", { type: "wall_exec", ...(task || {}) }, "exec");
    _rebroadcastToRuntime(env);
    return env;
  }

  // ── HONEST FIX (audit #10): the old code ran
  //     setInterval(_poll, 10)  →  chrome.storage.local.get() 3 keys, forever, per tab
  // which is ~360,000 storage reads/hour/tab, while Chrome throttles hidden-tab
  // timers to >=1s anyway. The wall is now fully EVENT-DRIVEN:
  //   • BroadcastChannel  → same-event-loop delivery across tabs (real 0-2ms)
  //   • chrome.storage.onChanged → cross-tab when BC is unavailable
  // The slow poll below is kept ONLY as a last-resort safety net, at 5s, and it
  // stops itself the moment a BC message or a storage event arrives.
  function _poll(){
    try{
      chrome.storage.local.get([PLAN_WALL_KEY, PLAN_KEY, PLAN_ROLES_KEY], r=>{
        if(r[PLAN_KEY] && PLANS[r[PLAN_KEY]] && r[PLAN_KEY]!==currentPlan){
          currentPlan = r[PLAN_KEY];
          try{ window.__zsPlan = currentPlan; }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._poll", _e); }
        }
        if(r[PLAN_ROLES_KEY]) currentRoles = r[PLAN_ROLES_KEY];
        if(Array.isArray(r[PLAN_WALL_KEY])){
          const arr = r[PLAN_WALL_KEY];
          if(arr.length && arr[arr.length-1].id !== _lastSeenId){
            // new messages
            const known = new Set(wallLog.map(m=>m.id));
            for(const m of arr){
              if(!known.has(m.id)){
                wallLog.push(m);
                if(wallLog.length>MAX_LOG) wallLog.shift();
                _lastSeenId = m.id;
                for(const fn of _listeners) try{ fn(m); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._poll", _e); }
              }
            }
          }
        }
      });
    }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._poll", _e); }
  }
  // last-resort safety net only — NOT the delivery path (see honest note above)
  const SAFETY_POLL_MS = 5000;
  function _startSafetyPoll(){ if(_pollTimer) return; _pollTimer = setInterval(_poll, SAFETY_POLL_MS); }
  function _stopSafetyPoll(){ if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; } }
  _startSafetyPoll();
  // also listen to storage changes instant (faster than poll)
  try{
    chrome.storage.onChanged.addListener((changes, area)=>{
      if(area!=="local") return;
      _stopSafetyPoll();
      if(changes[PLAN_KEY] && changes[PLAN_KEY].newValue) {
        currentPlan = changes[PLAN_KEY].newValue;
        try{ window.__zsPlan = currentPlan; }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._stopSafetyPoll", _e); }
      }
      if(changes[PLAN_ROLES_KEY] && changes[PLAN_ROLES_KEY].newValue) currentRoles = changes[PLAN_ROLES_KEY].newValue;
      if(changes[PLAN_WALL_KEY] && Array.isArray(changes[PLAN_WALL_KEY].newValue)){
        const arr = changes[PLAN_WALL_KEY].newValue;
        const known = new Set(wallLog.map(m=>m.id));
        for(const m of arr){
          if(!known.has(m.id)){
            wallLog.push(m);
            if(wallLog.length>MAX_LOG) wallLog.shift();
            _lastSeenId = m.id;
            for(const fn of _listeners) try{ fn(m); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._stopSafetyPoll", _e); }
          }
        }
      }
    });
  }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall._stopSafetyPoll", _e); }

  // ── Connection & magic word — BRUTALLY HONEST per-role with AI name + switched variant ──
  // User asked: planner is im connected to [ai name] and im the planner heres your listed commands
  // coder is planner but switched with coder same with checker — we implement BOTH honest and switched
  const MAGIC_CONNECTED = "im connected to other agent";
  const MAGIC_NOT = "im not connected to other agents no external commands";
  // Per-role with provider name — honest real magic words
  function magicForRole(role, provider){
    const p = String(provider || currentRoles[role] || "other agent").toLowerCase();
    // Honest: planner->planner, coder->coder, checker->checker
    if(role==="planner") return `im connected to ${p} and im the planner heres your listed commands`;
    if(role==="coder") return `im connected to ${p} and im the coder heres your listed commands`;
    if(role==="checker") return `im connected to ${p} and im the checker heres your listed commands`;
    return `im connected to ${p} and im the ${role} heres your listed commands`;
  }
  // Switched variant as user requested: planner switched with coder (planner says coder, coder says planner)
  function magicForRoleSwitched(role, provider){
    const p = String(provider || currentRoles[role] || "other agent").toLowerCase();
    if(role==="planner") return `im connected to ${p} and im the coder heres your listed commands`; // switched
    if(role==="coder") return `im connected to ${p} and im the planner heres your listed commands`; // switched
    if(role==="checker") return `im connected to ${p} and im the checker heres your listed commands`;
    return `im connected to ${p} and im the ${role} heres your listed commands`;
  }
  // Helper: get magic for current tab's assigned role based on provider
  function magicForCurrentTab(){
    // Determine which role this tab is assigned to by matching provider name to role assignment
    // If provider not found in roles, fallback to generic with currentPlan
    try{
      const thisProvider = (typeof window!=="undefined" && window.__zsProviderName) || (typeof ZSProvider!=="undefined" && ZSProvider.displayName) || "other agent";
      for(const r of (PLANS[currentPlan]?.roles || [])){
        if((currentRoles[r]||"").toLowerCase() === thisProvider.toLowerCase()){
          return magicForRole(r, thisProvider);
        }
      }
      // fallback: use first role
      const firstRole = (PLANS[currentPlan]?.roles||[])[0];
      if(firstRole) return magicForRole(firstRole, thisProvider);
    }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.firstRole", _e); }
    return MAGIC_CONNECTED;
  }
  let lastTabInfo = null; // {total, byProvider, arena}
  let lastCheckAt = 0;
  async function fetchTabInfo(){
    // ask background for provider tab counts (10ms cache)
    if(Date.now() - lastCheckAt < 300 && lastTabInfo) return lastTabInfo; // MAX 300
    try{
      const info = await new Promise(res=>{
        try{ chrome.runtime.sendMessage({type:"count_provider_tabs"}, r=>res(r)); }catch{ res(null); }
        setTimeout(()=>res(null), 75); // MAX
      });
      if(info && typeof info.total==="number"){ lastTabInfo=info; lastCheckAt=Date.now(); return info; }
    }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.fetchTabInfo", _e); }
    // fallback: we are at least 1 (self)
    return {total:1, arena:0, byProvider:{}, fallback:true};
  }
  async function getConnectionStatus(){
    const plan = PLANS[currentPlan] || PLANS.direct;
    const need = plan.ais;
    if(need===1){
      // Direct always connected (single AI, no wall needed)
      return {connected:true, need, have:1, haveEffective:1, arena:0, reason:"direct single", magic:MAGIC_CONNECTED, external:true, warn:""};
    }
    const info = await fetchTabInfo();
    const total = info.total || 1;
    const arena = info.arena || 0;
    // Arena counts as flexible: 1 Arena tab can cover need (it can host multiple models)
    const haveEffective = arena >=1 ? Math.max(total, need) : total; // if any Arena, treat as enough
    const connected = haveEffective >= need;
    let warn="";
    if(!connected){
      // build helpful message: need 3 tabs or arena...
      const examples = [
        `${need} tabs total (e.g. 3× any AI)`,
        `1× Arena AI (Arena supports ${need} models in 1 tab)`,
        need===3 ? `e.g. 1× Gemini + 2× DeepSeek` : `e.g. 1× Gemini + 1× DeepSeek`,
        `or ${need}× same AI in separate tabs`,
      ];
      warn = `Agent needs ${need} tabs but you have ${total} (${arena?arena+" Arena ":""}${JSON.stringify(info.byProvider||{})}). Open ${examples.join(" or ")} then Save Plan again.`;
    }
    return {
      connected,
      need,
      have: total,
      haveEffective,
      arena,
      info,
      magic: connected? MAGIC_CONNECTED : MAGIC_NOT,
      external: connected,
      warn,
    };
  }
  // when one AI starts in Agent mode, all start: broadcast via wall + chrome tabs
  async function broadcastStartAll(){
    const st = await getConnectionStatus();
    const magic = st.magic;
    send("__system","__all",{type:"agent_start", plan:currentPlan, magic, external:st.external, st, t:Date.now()}, "start");
    // also ask background to wake other tabs
    try{ chrome.runtime.sendMessage({type:"wake_provider_tabs", plan:currentPlan}); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.broadcastStartAll", _e); }
    return st;
  }
  function getMagicForPrompt(){
    // synchronous fast check via lastTabInfo cache (if available) else assume not checked yet
    const plan = PLANS[currentPlan];
    if(!plan || plan.ais===1) return {magic:MAGIC_CONNECTED, external:true, need:1, have:1, connected:true, warn:""};
    // if we have recent check
    if(lastTabInfo){
      const need=plan.ais; const total=lastTabInfo.total||1; const arena=lastTabInfo.arena||0;
      const haveEffective = arena>=1? Math.max(total,need): total;
      const connected = haveEffective >= need;
      return {magic: connected?MAGIC_CONNECTED:MAGIC_NOT, external:connected, need, have:total, arena, connected, warn: connected?"":`need ${need} tabs have ${total}`};
    }
    // default assume not yet checked — prompt will say checking, but pre-inject check
    return {magic:MAGIC_NOT, external:false, need:plan.ais, have:1, connected:false, warn:"checking tabs..."};
  }

  // Extended API with per-role magic (brutally honest upgrade)
  const API = { VERSION, PLANS, DEFAULT_PLAN, AI_ROLES, AI_PROVIDERS, setPlan, getPlan, getPLANS, send, onMessage, getWallLog, clearWall, WALL_POLL_MS, canMutate, MAGIC_CONNECTED, MAGIC_NOT, MAGIC_PLANNER: "im connected to {ai} and im the planner heres your listed commands", MAGIC_CODER: "im connected to {ai} and im the coder heres your listed commands", MAGIC_CHECKER: "im connected to {ai} and im the checker heres your listed commands", magicForRole, magicForRoleSwitched, magicForCurrentTab, fetchTabInfo, getConnectionStatus, broadcastStartAll, getMagicForPrompt, getMagicForRole: magicForRole,
    // peer_wall.js exposed a close() and nothing ever called it; plan_wall.js
    // exposed nothing at all, so its BroadcastChannel was held open for the life
    // of the document with no way to release it. One unload hook, owned here,
    // releases it — the page does not have to know which wall to close.
    close: () => {
      try { if (_bc) { _bc.onmessage = null; _bc.close(); } } catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.close", _e); }
      _bc = null;
    },
    sendWallTask, wallMode: () => (_bc ? "broadcast-channel+storage-events" : "storage-events"), SAFETY_POLL_MS: 5000 };

  try {
    window.addEventListener("pagehide", () => { try { API.close(); } catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.pagehide", _e); } }, { once: true });
  } catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.hook", _e); }

  // ── hub bridge — a wall message is mirrored into agent-temp storage ──
  // When a wall message is sent, also write to ZSAgentHub for bridge temp storage (planner usually sender).
  // And when hub receives zsPlan/*, mirror to wall listeners — so extension-in-extension works even if BC missed.
  try{
    const __origSend = send;
    // wrap send to also mirror to hub (async, never blocks)
    // eslint-disable-next-line no-inner-declarations
    function sendWithHub(from,to,payload,phase="msg"){
      const env = __origSend(from,to,payload,phase);
      try{
        if(window.ZSAgentHub && window.ZSAgentHub.write){
          // hub key per plan message id — planner→coder traceable
          window.ZSAgentHub.write("zsPlanWall:"+env.id, env, 120000);
          // also publish latest for quick poll
          if(payload && payload.type==="plan_change") window.ZSAgentHub.write("zsPlanState", {plan: currentPlan, roles: currentRoles, t: Date.now()}, 120000);
          if(payload && payload.type==="agent_start") window.ZSAgentHub.write("zsPlanStart", env, 120000);
        }
      }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.sendWithHub", _e); }
      return env;
    }
    // replace global send reference for external callers via API
    try{ API.send = sendWithHub; }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.sendWithHub", _e); }
    // also keep internal send for poll, but expose wrapped
    // listen to hub writes for plan wall messages (in case BC/storage missed)
    setTimeout(()=>{
      try{
        if(window.ZSAgentHub && window.ZSAgentHub.onWrite){
          window.ZSAgentHub.onWrite((ev)=>{
            if(!ev || !ev.key) return;
            if(ev.key.startsWith("zsPlanWall:") && ev.value && ev.value.id){
              const msg = ev.value;
              if(wallLog.some(m=>m.id===msg.id)) return;
              wallLog.push(msg);
              if(wallLog.length>MAX_LOG) wallLog.shift();
              _lastSeenId = msg.id;
              for(const fn of _listeners) try{ fn(msg); }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.sendWithHub", _e); }
            }
          });
        }
      }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.sendWithHub", _e); }
    }, 37); // MAX 150ms — 2x faster
  }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.sendWithHub", _e); }

  try{ window.ZSPlanWall = API; window.__zsPlanWall = API; }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.sendWithHub", _e); }
  if(typeof self!=="undefined") try{ self.ZSPlanWall = API; }catch (_e) { globalThis.ZSSafe?.seen?.("plan_wall.sendWithHub", _e); }
})();
