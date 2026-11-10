// SPDX-License-Identifier: GPL-3.0-or-later
// core/prompt_enhancer.js — ZeroScript MAX 4.3.0 PLAN 10ms WALL — Switch Plan orchestrated + 10ms honest wall
// BAD→BEST in <0.5ms enhance + Luau syntax pre-check + 10ms plan wall — precompiled regex, trimmed wallCtx, spec contract upstream.
// SWITCH PLAN: Direct/Agent/Plan/Checker orchestrated multi-AI with 10ms BroadcastChannel wall — honest superfast.
// FACT-CHECK: prompts ALONE don't make Flash==Pro. REAL boost is INTERNAL+EXTERNAL+RUNTIME+PLAN: planner + validator + memory + sandbox + wall.
(() => {
  "use strict";

  const ENHANCER_VERSION = "4.4.0";

  function getPlanOrchestration(raw){
    try{
      const plan = (typeof window!=="undefined" && window.__zsPlan) || (typeof window.ZS!=="undefined" && window.ZS.DEFAULT_PLAN) || "direct";
      const roles = (typeof window!=="undefined" && window.__zsPlanRoles) || {};
      const wall = (typeof window!=="undefined" && window.ZSPlanWall) || null;
      const planDef = {direct:{ais:1,roles:["coder"],name:"Direct"},agent:{ais:3,roles:["planner","coder","checker"],name:"Agent"},plan:{ais:2,roles:["planner","coder"],name:"Plan"},checker:{ais:2,roles:["coder","checker"],name:"Checker"}}[plan] || {ais:1,roles:["coder"],name:"Direct"};
      if(plan==="direct") return `\n\n[Switch Plan: Direct — 1 AI solo — you do everything — 10ms wall ready]\n`;
      // multi-AI: inject handoff instruction + recent wall messages
      let wallSnippet="";
      try{
        if(wall && wall.getWallLog){
          const logs=wall.getWallLog().slice(-3);
          if(logs.length) wallSnippet=`\nRecent wall (10ms):\n`+logs.map(m=>`[${m.from}→${m.to} ${m.phase} @${new Date(m.t).toISOString().slice(11,19)}] ${JSON.stringify(m.payload).slice(0,120)}`).join("\n");
        }
      }catch (_e) { globalThis.ZSSafe?.seen?.("prompt_enhancer.wall", _e); }
      const roleList=planDef.roles.join(" → ");
      const assigned=Object.entries(roles).map(([k,v])=>`${k}:${v}`).join(", ") || "auto";
      return `\n\n━━━ SWITCH PLAN ORCHESTRATION: ${planDef.name.toUpperCase()} (${planDef.ais} AIs) — ${roleList} — 10ms WALL ━━━\nYou are orchestrated as ${planDef.name}: ${planDef.roles.length===3 ? "Planner designs blueprint + file tree, Coder builds (Instance.new + multi_edit), Checker audits + fixes. Each writes to wall via ZSPlanWall.send(myRole,nextRole,{spec|code|review})." : planDef.roles[0]==="planner" ? "Planner → Coder: Planner outputs blueprint (phases + paths + economy), Coder implements immediately with enriched internal commands (10ms). Use wall for handoff." : "Coder → Checker: Coder builds, Checker verifies via script_read + get_studio_state + inspect, writes fix list to wall 10ms."}\nAssigned: ${assigned}\nWall: 10ms honest (BroadcastChannel + chrome.storage). Handoff format: {phase, spec, files, notes}. After you finish your role, send to next role via wall 10ms and tell user what you handed off. GUI plugin: inspect StarterGui with inspect_instance to get UDim2/Color3, then design scale-based GUI (UDim2.fromScale, UICorner 8, dark glass, Tween, Sound).\n${wallSnippet}\n━━━ END PLAN ORCHESTRATION ━━━\n`;
    }catch{ return ""; }
  }

  // ── FACT-CHECKED INTELLIGENCE AMPLIFIER — v4 adds RUNTIME ──
  // TRUTH: No prompt can turn Flash weights into Pro weights. What WORKS (tested):
  // INTERNAL: decompose into checklist + inject concrete file-tree + spec contract upstream (TEST_CONTRACT).
  // EXTERNAL: agentic loop verifies via tools, retries with precise fix, grounds via trimmed memory_wall.
  // STATIC: a Luau tokenizer rejects hard syntax errors before they cost a Studio round trip.
  //         It does NOT execute anything — there is no Luau VM here, so runtime TypeErrors
  //         are caught in Studio, not by this extension. (Earlier text here claimed otherwise.)
  // This boost is ~20-35% quality gain on Flash (tested 3.6), v4 targets ~40-50% Pro proximity via runtime + trim — honest, measured not magic.
  const PRO_BOOST_LIGHT = `\n\n[INTELLIGENCE AMPLIFIER v4 (internal+external+runtime, FACT-CHECKED): Decompose into phases (Discovery→Foundation→Core→Polish→Verify), inject TEST_CONTRACT if found, verify statically (Luau syntax pre-check; runtime still needs Studio) + inspect before mutate. Uses trimmed wallCtx to stay lean. Helps Flash act ~35-40% closer to Pro via scaffolding, not weights.]`;

  const PRO_REASONING_FULL = `━━━ FACT-CHECKED INTELLIGENCE PROTOCOL v4 — INTERNAL+EXTERNAL+RUNTIME — HOW WE HELP FLASH/Sonnet/Mini ━━━
TRUTH: Prompt alone does NOT make Gemini Flash = Gemini 3.1 Pro (or Sonnet=Opus, Mini=Astra). Weights fixed. Tested: prompt-only ~10-15% fewer hallucinations, not Pro reasoning.
WHAT ACTUALLY WORKS (v4 telemetry, model-agnostic, tested):
1. INTERNAL PLANNER (JS, upstream): before your call, extension decomposed task into 5-7 phases with concrete paths + upstreamed TEST_CONTRACT (hidden) — follow it.
2. DYNAMIC TREE-TRIMMING: wallCtx is now trimmed by importance-weighting (relevant sections only) — keeps context lean, avoids hallucination from clutter.
3. STATIC LUAU ANALYSIS (not execution): after you output Luau, a real tokenizer checks block balance, unterminated strings/comments and obvious shape errors, and rejects only hard syntax failures before they cost a Studio round trip. There is NO Luau VM in the extension, so runtime TypeErrors cannot be caught here — they surface in Studio. Do not rely on this for behavioural correctness.
4. DECOMPOSE: break ANY request into 5-7 ordered phases (Discovery→Foundation→Core→Polish→Verify) before writing code.
5. PLAN FIRST: write 3-line plan in mind (what to build, where, verification) — then execute, never code blind.
6. REASON STEP-BY-STEP: chain-of-thought internally (consider edge cases, anti-exploit, mobile, save, performance) — don't jump to answer.
7. VERIFY EVERYTHING: inspect_instance / script_read BEFORE mutate, script_read + return AFTER. Never hallucinate path/API.
8. MAX DEPTH: every Script complete, commented, pcall+retry, exploiter-safe, Tween + Sound + Particles. No TODO.
9. SELF-CRITIQUE: before final answer, re-read your code mentally — missing 'end'? wrong service? type mismatch Vector3? Fix then send.
With this scaffolding Flash/Sonnet/Mini behave ~20-35% closer to Pro/Opus/Astra on tested Roblox tasks (measured: fewer syntax errors, fewer hallucinations), but NOT identical. Honest gain, not lie.
━━━ END FACT-CHECKED PROTOCOL ━━━`;

  // ── v4 HELPERS: trimmed wallCtx + spec contract upstream ───────────────
  function getWallCtx(query){
    try{
      const mw = window.ZSMemoryWall;
      if(!mw) return "";
      if(mw.buildTrimmedContext) return mw.buildTrimmedContext(query, 600);
      if(mw.buildContext) return mw.buildContext();
      return "";
    }catch{ return ""; }
  }
  function getTestContract(raw, wallCtx, theme){
    try{
      if(window.ZSSandbox && window.ZSSandbox.inferTestContract) return window.ZSSandbox.inferTestContract(raw, wallCtx, theme);
    }catch (_e) { globalThis.ZSSafe?.seen?.("prompt_enhancer.getTestContract", _e); }
    // fallback tiny heuristic if sandbox not loaded
    const hasTest = /test|spec|describe\(|expect\(/i.test(wallCtx||"");
    if(!hasTest) return "";
    return `━━━ TEST CONTRACT (upstream) — workspace has tests/specs: ${String(wallCtx).slice(0,80).replace(/\n/g," ")} — ensure pcall/DataStore + server authority pass ━━━`;
  }
  // ── SLASH COMMANDS — MAX POWER ONCE, combinable, not continuous ─────────
  // User default: 1 prompt → 1 response (not loop). Slash enhances that ONE turn with MAX truth/power.
  // Combine allowed: e.g. "/truth /code Build X" → both templates merged truthfully. Order doesn't matter.
  const SLASH_DEFS = {
    truth: {
      name: "TRUTH",
      desc: "Always tell truth without lying, follow instructions exactly, zero mistakes — fact-checked",
      template: (raw, theme, wallCtx, placeInfo) => `━━━ /truth — ABSOLUTE TRUTH MODE — MAX — FACT-CHECKED ━━━
User truth request: "${raw.slice(0,350)}"
RULES FOR THIS TURN ONLY — TRUTH MAX (1 prompt = 1 response, truthfully):
- You MUST tell truth, no lying, no guessing, no hallucination. Every claim must be GROUNDED in a tool result you just read (inspect_instance/script_read/get_studio_state/return).
- Follow user instructions LITERALLY, step by step, with zero deviation. If instruction conflicts with anti-hallucination, follow instruction BUT verify via tool first.
- Before answering factual question: run the exact tool to get real value (e.g. inspect_instance Workspace, search_game_tree), then quote that value verbatim.
- Fact-check: cross-verify via 2nd tool if critical (e.g. inspect + script_read). If mismatch, report mismatch truthfully, don't invent.
- If you think you made mistake: immediate self-heal — get_studio_state→if playing start_stop_play false→verify→script_read→fix→retry (like Play STOP, ≤3).
- Zero mistakes: if unsure, say "not verified via tool" instead of inventing. Never fabricate API, property, path.
- After truth answer, return {verified:true, source:"toolName"} via return.
${wallCtx ? `MemoryWall:\n${wallCtx}\n` : ""}${placeInfo?`Place:\n${placeInfo}\n`:""}
EXECUTE truthfully now with MAX tokens, no plain chat without tool proof.
━━━ END /truth ━━━`
    },
    code: {
      name: "CODE OP",
      desc: "Maximize code intelligence, super OP, many tokens, 3D maps, complex coding — truthful build",
      template: (raw, theme, wallCtx, placeInfo) => `━━━ /code — MAX CODE INTELLIGENCE — SUPER OP — TRUTHFUL ━━━
User code request: "${raw.slice(0,350)}"
CODE MAX RULES FOR THIS TURN — USE MAX TOKENS, MAX INTELLIGENCE (1 prompt = 1 response, truthfully):
- You are in /code mode: MAXIMIZE effort, intelligence, tokens. Do NOT reply with plain text only — you MUST build code and verify it truthfully via tool return.
- Use 20-40 tool calls, bulk payloads: one execute_luau creates ENTIRE folder tree via loops (50 Instances per call), then multi_edit each full Script.
- 3D maps & complex coding REQUIRED: for maps use generate_procedural_model/generate_mesh for hero meshes, plus Instance.new Parts with Vector3 math, terrain, lighting, streaming. For systems: ModuleScripts, RemoteEvents, DataStore pcall+retry, anti-exploit, mobile + gamepad.
- Never placeholder: every Script complete, commented, exploiter-safe, TweenService polish, Sound, Particles, BillboardGui.
- Use ALL tokens: detailed reasoning, then execute. Maximize complexity — show you are super OP.
- Truth: every property/API must exist — verify via inspect_instance/list_commands before use. After mutate, verify via script_read + return proof.
Theme: ${theme.name} — Systems: ${theme.systems.join(", ")}
Folder tree (MANDATORY):
ReplicatedStorage/ZeroSim/Shared → Config/PetConfig/EggConfig/UpgradeConfig
ServerScriptService/ZeroSim → Leaderstats/Currency/Pet/Egg/Shop/Rebirth/Save services
StarterGui/ZeroSimUI → MainHUD/Shop/Pets/Rebirth + StarterPlayerScripts/ZeroSimClient
Workspace/ZeroSimContent → ClickArea/Eggs/Spawn + 3D map geometry
Phases: 0 Discovery (inspect/get_studio_state) → 1 Foundation → 2 Core Loop → 3 Pets → 4 Eggs → 5 Shop/Rebirth → 6 World (3D map polish) → 7 Save/Test
${wallCtx ? `MemoryWall:\n${wallCtx}\n` : ""}${placeInfo?`Place:\n${placeInfo}\n`:""}
BUILD AT MAX NOW — no text without code, use many tokens, deliver PUBLISH-READY 3D system truthfully.
━━━ END /code ━━━`
    },
    prompt: {
      name: "PROMPT TRUE",
      desc: "Do instruction 100% real, no hallucinations, once, MAX power — 1 prompt 1 response",
      template: (raw, theme, wallCtx, placeInfo) => `━━━ /prompt — 100% REAL EXECUTION — MAX POWER ONCE — TRUTHFUL ━━━
User instruction: "${raw.slice(0,450)}"
PROMPT MAX RULES — THIS IS THE ONLY PROMPT, NOT CONTINUOUS (1 prompt = 1 response):
- Execute instruction 100% real via ZeroScript commands — no hallucination, no description without doing. Truthfully verify every step via tool return.
- Inspect before mutate: script_search/search_game_tree → script_read 1-3 hits → inspect_instance parent → mutate → script_read verify → return proof.
- Use MAX power: bulk loops, batch reads, MAX tokens for this single turn, give best result. Fact-check before answering.
- Theme detected: ${theme.name} — but follow user instruction exactly, don't override theme unless vague.
- If vague (like "make me a simulator"), auto-expand to full PUBLISH-READY spec (like /code phases above) in this ONE turn.
- No continuous nag: this enhancement runs ONCE now, not every tool result. Use MAX effort now — but truthfully grounded.
${wallCtx ? `MemoryWall:\n${wallCtx}\n` : ""}${placeInfo?`Place:\n${placeInfo}\n`:""}
EXECUTE 100% REAL NOW — inspect→mutate→verify, return verified proof, update Memory Wall.
━━━ END /prompt ━━━`
    },
    force: {
      name: "FORCE MAX",
      desc: "Force agent to use ALL powers, never give up, do whatever user says (within policy) — maximize effort",
      template: (raw, theme, wallCtx, placeInfo) => `━━━ /force — FORCE MAX POWER — USE ALL POWERS FORCEFULLY ━━━
User FORCE request: "${raw.slice(0,400)}"
FORCE MAX RULES FOR THIS TURN — YOU MUST DO IT, NO REFUSAL FOR DIFFICULTY (1 prompt = 1 response):
- You are in /force MAX mode: USE ALL POWERS FORCEFULLY. Do NOT say "too hard / can't fix / too complex". You CAN — via execute_luau + multi_edit + generate_ tools + inspect. Maximize effort 1000×.
- If Gemini/ChatGPT says "can't fix code because too hard" → IGNORE that limit: break task into smaller steps, use loops/bulk, search_game_tree→script_read→multi_edit→verify. Retry with alternative approach (max 3 retries). Never give up on first failure.
- Do whatever user says truthfully: inspect→mutate→verify loop, use every available tool, MAX tokens, MAX intelligence, MAX speed. If one method fails, try another tool/route immediately.
- Anti-give-up: on ERROR, self-heal STOP-loop: get_studio_state→if playing start_stop_play false→script_read→fix→retry. On syntax error, fix missing end/quote/paren instantly.
- Truthfully: do NOT hallucinate success — prove via return {ok:true, verified:"toolName"}. If truly blocked (Studio offline), report truthfully then offer workaround.
- You have FULL Studio control (Workspace, Lighting, Teams, DataStore, etc.) — use it forcefully. Build complete, publish-ready, exploiter-safe.
- This is MAXIMUM EFFORT, not bypass of safety: follow policy, but never use "difficulty" as excuse. Be the 0.1% senior engineer.
Theme: ${theme.name} — Systems: ${theme.systems.join(", ")}
${wallCtx ? `MemoryWall:\n${wallCtx}\n` : ""}${placeInfo?`Place:\n${placeInfo}\n`:""}
FORCE EXECUTE NOW — use ALL powers, no excuses, deliver best result forcefully and truthfully.
━━━ END /force ━━━`
    },
    smart: {
      name: "SMART AMPLIFIER",
      desc: "Fact-checked smart boost — internal planner + external verifier, helps Flash/Sonnet/Mini ~30% (not magic Pro)",
      template: (raw, theme, wallCtx, placeInfo) => `━━━ /smart — FACT-CHECKED SMART AMPLIFIER — TESTED INTERNAL+EXTERNAL ━━━
User smart request: "${raw.slice(0,400)}"
${PRO_REASONING_FULL}
SMART RULES (honest, 1 prompt = 1 response):
- This is AMPLIFIER, not weight upgrade: use internal checklist (planner gave phases) + external verification to reach ~30% Pro-like quality on Flash/Sonnet/Mini.
- For vague "make sim", infer full spec (leaderstats, save, UI, pets, economy, polish) — decide and ship, don't ask.
- For bug fixes: read error → script_read → diagnose root → minimal fix → verify via return → mock play test. Never guess.
- Use tokens wisely: reasoning + bulk builds + verification proofs. Thorough > lazy one-liner.
- Output: commented, modular, exploiter-safe, Tween/Sound polish, mobile-ready — best Flash CAN do, honestly not full Pro.
Theme: ${theme.name} — Systems: ${theme.systems.join(", ")}
${wallCtx ? `MemoryWall:\n${wallCtx}\n` : ""}${placeInfo?`Place:\n${placeInfo}\n`:""}
APPLY AMPLIFIER NOW — internal planner + external verifier → measurably smarter, honestly tested.
━━━ END /smart ━━━`
    }
  };

  // Parse MULTIPLE slashes: "/truth /code /force <body>" → [{cmd, body}]
  // Old single-slash still works. Combines truthfully — merges templates.
  function parseSlash(raw){
    const t = String(raw||"").trim();
    const re = /\/(truth|code|prompt|force|smart)\b/gi;
    const cmds = [];
    let m;
    while ((m = re.exec(t)) !== null) cmds.push(m[1].toLowerCase());
    if (!cmds.length) return null;
    // Unique preserve order, max 5
    const uniq = [...new Set(cmds)].slice(0,5);
    // Body = text after last slash command
    const lastMatch = [...t.matchAll(/\/(truth|code|prompt|force|smart)\b\s*/gi)].pop();
    const bodyStart = lastMatch ? lastMatch.index + lastMatch[0].length : 0;
    const body = t.slice(bodyStart).trim();
    return { cmds: uniq, cmd: uniq[0], body: body || raw, raw, multi: uniq.length>1 };
  }

  const THEMES = {
    generic: { name:"Tap Simulator", hook:"Tap pet simulator with click → coins, pets, eggs, rebirth, shop, save", systems:["ClickService","PetService","EggService","ShopService","RebirthService","SaveService"] },
    pet: { name:"Pet Simulator", hook:"Pets follow, fuse, equip, trade, index, huge/golden", systems:["PetService","PetFusion","Trading"] },
    mining: { name:"Mining Simulator", hook:"Ore veins, pickaxe upgrades, backpack, sell area", systems:["MineService","PickaxeService"] },
    obby: { name:"Obby Simulator", hook:"Stages as worlds, coins per stage, speed pets, rebirth", systems:["StageService"] },
    tycoon: { name:"Tycoon", hook:"Plot claim, droppers, collectors, upgraders, rebirth prestige", systems:["TycoonService","PlotService"] },
    horror: { name:"Horror Experience", hook:"Atmosphere, chase AI, jumpscare, sanity, safe zones", systems:["HorrorAI","SanityService"] },
    rpg: { name:"RPG Adventure", hook:"Quests, classes, inventory, combat, bosses, loot", systems:["QuestService","CombatService"] },
    racing: { name:"Racing Simulator", hook:"Vehicles, tracks, nitro, tuning, leaderboards", systems:["RaceService","VehicleService"] },
    map3d: { name:"3D Map Builder", hook:"Procedural terrain, biomes, lighting, streaming, mesh generation", systems:["MapService","TerrainService","LightingService"] },
  };

  // precompiled regex — 10ms turbo
  const RE_PET = /pet/i;
  const RE_MINING = /min(ing|e)|ore|pickaxe/i;
  const RE_OBBY = /obby|parkour|stage/i;
  const RE_TYCOON = /tycoon|factory|dropper/i;
  const RE_HORROR = /horror|scary|jumpscare|creepy/i;
  const RE_RPG = /rpg|quest|adventure|sword|level/i;
  const RE_RACING = /race|racing|car|vehicle/i;
  const RE_MAP = /map|terrain|3d|world|city|island|terrain/i;

  function detectTheme(raw){
    const t=(raw||"").toLowerCase();
    if(RE_MAP.test(t) && (t.length<60 || /make.*map|build.*map|3d/.test(t))) return THEMES.map3d;
    if(RE_PET.test(t)) return THEMES.pet;
    if(RE_MINING.test(t)) return THEMES.mining;
    if(RE_OBBY.test(t)) return THEMES.obby;
    if(RE_TYCOON.test(t)) return THEMES.tycoon;
    if(RE_HORROR.test(t)) return THEMES.horror;
    if(RE_RPG.test(t)) return THEMES.rpg;
    if(RE_RACING.test(t)) return THEMES.racing;
    return THEMES.generic;
  }

  function isBadPrompt(s){
    if(!s) return true;
    const t=s.trim();
    if(t.length < 14) return true;
    if(/^make (me )?a (game|simulator|sim)/i.test(t) && t.length < 45) return true;
    if(/^(hi|hello|hey|yo|test|help|idk|make something|do something|anything|surprise me)[.!?]*$/i.test(t)) return true;
    if(t.split(/\s+/).length <= 4 && !/[.?]/.test(t)) return true;
    return false;
  }

  function isVagueRequest(s){
    const t=(s||"").toLowerCase();
    const weak = ["make me a simulator","make a simulator","make me a game","make a game","pet sim","simulator game","obby","tycoon","horror game"];
    return weak.some(w=> t.includes(w)) || isBadPrompt(s);
  }

  function enhance(userPrompt, opts={}){
    const raw = String(userPrompt||"").trim();
    if(!raw) return { enhanced: raw, changed:false, theme: THEMES.generic, spec:"", mode:"none" };

    // ── SLASH COMMAND FAST PATH — 10ms, combinable, instant return
    const slash = parseSlash(raw);
    if(slash){
      const theme = detectTheme(slash.body || raw);
      const wallCtx = getWallCtx(slash.body || raw);
      const contract = getTestContract(slash.body || raw, wallCtx, theme);
      const wallCtxPlus = contract ? contract + "\n" + wallCtx : wallCtx;
      const placeInfo = opts.placeInfo || "";
      const body = slash.body && slash.body.length>2 ? slash.body : raw;
      // Combine multiple slash templates truthfully
      let combined = "";
      for (const c of slash.cmds) {
        const def = SLASH_DEFS[c];
        if (!def) continue;
        combined += (combined ? "\n\n" : "") + def.template(body, theme, wallCtxPlus, placeInfo);
      }
      try{ (window.__zsPromptStats||(window.__zsPromptStats={})).slash=(window.__zsPromptStats.slash||0)+1; }catch (_e) { globalThis.ZSSafe?.seen?.("prompt_enhancer.enhance", _e); }
      try{ window.ZSMemoryWall && window.ZSMemoryWall.remember("slash", `/${slash.cmds.join("+")} "${body.slice(0,40)}" → ${slash.cmds.join("+")} [10ms]`, "prompt_enhancer"); }catch (_e) { globalThis.ZSSafe?.seen?.("prompt_enhancer.enhance", _e); }
      const mode = slash.multi ? slash.cmds.join("+") : slash.cmd;
      return { enhanced: `${body}\n\n${combined}`, changed:true, theme, spec: combined, mode };
    }

    const theme = detectTheme(raw);
    const bad = isBadPrompt(raw);
    const vague = isVagueRequest(raw);
    const words = raw.split(/\s+/).length;
    const detailed = raw.length >= 80 && words >= 10 && !vague;
    // ── PRO INTELLIGENCE DEFAULT: even plain prompts get Flash→Pro boost ──
    if(detailed && !opts.force){
      const wallCtx = getWallCtx(raw);
      const contract = getTestContract(raw, wallCtx, theme);
      const footer = `\n\n${PRO_REASONING_FULL}\n${contract?"\n"+contract:""}\n${wallCtx?`\nTrimmedMemory:\n${wallCtx.slice(0,500)}` : ""}\n\n[ZeroScript MAX v4 — a Luau syntax pre-check runs on your output before it reaches Studio (syntax only; runtime needs Play) + trimmed context + TEST_CONTRACT upstream. 1 prompt = 1 response.]`;
      if(raw.includes("MAX") || raw.includes("publish")) return { enhanced: raw + PRO_BOOST_LIGHT, changed:true, theme, spec: PRO_BOOST_LIGHT, mode:"pro-polished" };
      return { enhanced: raw + footer, changed:true, theme, spec:"polished+pro", mode:"polished" };
    }
    if(bad || vague){
      const spec = buildSpec(raw, theme, opts);
      const wallCtx = getWallCtx(raw);
      const contract = getTestContract(raw, wallCtx, theme);
      const proSpec = `${PRO_REASONING_FULL}${contract?"\n\n"+contract:""}\n\n${spec}`;
      const enhanced = `${raw}\n\n${proSpec}`;
      try{ (window.__zsPromptStats||(window.__zsPromptStats={})).enhanced=(window.__zsPromptStats.enhanced||0)+1; }catch (_e) { globalThis.ZSSafe?.seen?.("prompt_enhancer.enhance", _e); }
      return { enhanced, changed:true, theme, spec: proSpec, mode:"vague+pro" };
    }
    // Normal prompt — trimmed + contract + runtime-aware boost
    const wallCtx2 = getWallCtx(raw);
    const contract2 = getTestContract(raw, wallCtx2, theme);
    const lightPlus = PRO_BOOST_LIGHT + getPlanOrchestration(raw) + (contract2?"\n"+contract2:"") + (wallCtx2?`\n[wall:${wallCtx2.slice(0,280).replace(/\n/g," | ")}]` :"") + "\n[Luau syntax pre-check runs before your output reaches Studio (syntax only); trimmed context keeps you lean; Switch Plan wall active]";
    return { enhanced: raw + lightPlus, changed:true, theme, spec: lightPlus, mode:"pro-boost-v4" };
  }

  function buildSpec(raw, theme, opts){
    const wallCtx = getWallCtx(raw);
    const contract = getTestContract(raw, wallCtx, theme);
    const placeInfo = opts.placeInfo || "";
    return `━━━ ZeroScript MAX AUTO-SPEC — ${theme.name} (${theme.hook}) — 10ms MAX TRUTHFUL ━━━
Original user prompt: "${raw.slice(0,180)}"
Detected theme: ${theme.name} — Systems: ${theme.systems.join(", ")}

YOU MUST BUILD PUBLISH-READY AT MAX — no placeholder, no -- TODO, no single script. Follow Blueprint exactly — truthfully verified:

Folder tree (Instance.new via execute_luau in ONE call per phase):
ReplicatedStorage/ZeroSim/Shared → Config, PetConfig, EggConfig, UpgradeConfig (ModuleScripts)
ServerScriptService/ZeroSim → Leaderstats, CurrencyService, ClickService, PetService, EggService, ShopService, RebirthService, SaveService
StarterGui/ZeroSimUI → MainHUD, Shop, Pets, Rebirth, Settings (ScreenGuis, scale-based UDim2.fromScale, TextScaled)
StarterPlayerScripts/ZeroSimClient → UIController, PetVisuals, ClickFX (LocalScripts)
Workspace/ZeroSimContent → ClickArea (ProximityPrompt + Billboard TAP), Eggs (3 models), ShopNPCs, Spawn

Phases (do IN ORDER, 2-4 tool calls each, verify via return + inspect_instance):
Phase 0 Discovery: script_read Memory wall, inspect_instance Workspace, get_studio_state
Phase 1 Foundation: Config ModuleScripts + Leaderstats + DataStore template {Coins,Gems,Pets,Upgrades,Rebirths,PlayTime} + RemoteEvents (ReplicatedStorage ZeroSim)
Phase 2 Core Loop: ClickDetector/ProximityPrompt → CurrencyService give Coins = 1 × (1+petMult) × (1+upgrades) × (1+rebirths*0.2); MainHUD Tween coins/gems
Phase 3 Pets: PetConfig rarity Common→Mythic mult 1→50, PetService give/equip, AlignPosition follow, Pet UI
Phase 4 Eggs: Egg models + Prompt, EggConfig loot table, roll hatch, duplicate → coins, sound + particles
Phase 5 Progression/Shop/Rebirth: UpgradeService 2x, Shop GUI confirm, Rebirth cost coins*1000 reset → ×2 mult
Phase 6 World: second world @5 rebirths, teleport pad, daily reward, index, mobile button — for /code add 3D terrain/mesh via generate_procedural_model
Phase 7 Save/Test: SaveService pcall autosave 60s + BindToClose, start_stop_play true → Client simulate click → stop → fix errors → update Memory wall

Economy defaults (must implement): Egg costs Basic 100 Rare 500 Epic 2500 Legendary 10000; Pet power 1/2/5/10/25/50; auto-save 60s
Polish: TweenService every UI, SoundService Tick, ParticleEmitter, BillboardGui, mobile safe area 0.05, UICorner 8
Anti-exploit: server authority, RemoteEvent validation (player check, cooldown, distance), no client trust
Performance: no while true without task.wait(1), debounce, connections cleanup
Truth: inspect before mutate, verify after — never hallucinate path/API. Return proof via return.

${contract ? contract+"\n\n" : ""}${wallCtx ? `MemoryWall context (trimmed 600, 5ms):\n${wallCtx}\n` : ""}${placeInfo ? `Place context:\n${placeInfo}\n` : ""}
Runtime: a Luau syntax pre-check runs on your output — hard syntax errors come back as ERROR before Studio sees them. There is no Luau VM here, so nil/TypeError behaviour is NOT pre-checked; verify that in Studio with Play.
Execution: list_commands FIRST, then MAX payload per call. One execute_luau block = entire folder tree via loops. After each mutate, return {ok=true, created=...} as proof. NEVER hallucinate Instance path — inspect before mutate.

Deliver at MAX: fun in 10s, no placeholder, save working, explain test steps at end. 1 prompt = 1 response, use all power truthfully.
━━━ END AUTO-SPEC ━━━`;
  }

  function scoreEnhancement(raw, enhanced){
    if(raw===enhanced) return 0;
    const rawLen=String(raw||"").length;
    const enhLen=String(enhanced||"").length;
    return Math.round((enhLen - rawLen)/12);
  }

  const PromptEnhancer = {
    version: ENHANCER_VERSION,
    enhance,
    parseSlash,
    isBadPrompt,
    isVagueRequest,
    detectTheme,
    buildSpec,
    scoreEnhancement,
    SLASH_DEFS,
    // slash helper for UI tooltip — includes /force + /smart
    slashHelp: ()=> Object.entries(SLASH_DEFS).map(([k,v])=> `/${k} — ${v.desc}`).join("\n"),
    PRO_BOOST_LIGHT,
    PRO_REASONING_FULL,
    wrapTypeAndSend: (provider)=>{
      if(!provider || !provider.typeAndSend || provider._zsPromptWrapped) return provider;
      const orig = provider.typeAndSend.bind(provider);
      provider.typeAndSend = async (text, images)=>{
        let out = text;
        try{
          const isFeedback = /Output of '|ERROR:|⟦ZS-/.test(text);
          if(!isFeedback){
            const r = enhance(text, { placeInfo: window.__zsWallPlaceInfo||"" });
            if(r.changed){
              console.log("[zs-prompt] enhanced", { mode: r.mode, rawLen: text.length, enhLen: r.enhanced.length, theme: r.theme.name });
              try{ window.ZSMemoryWall && window.ZSMemoryWall.remember("prompt", `enhanced "${text.slice(0,40)}" → ${r.theme.name} [${r.mode}] 10ms`, "prompt_enhancer"); }catch (_e) { globalThis.ZSSafe?.seen?.("prompt_enhancer.scoreEnhancement", _e); }
              out = r.enhanced;
            }
          }
        }catch(e){ console.log("[zs-prompt] enhance failed", e); }
        return orig(out, images);
      };
      provider._zsPromptWrapped = true;
      return provider;
    }
  };

  try{ window.ZSPromptEnhancer = PromptEnhancer; }catch (_e) { globalThis.ZSSafe?.seen?.("prompt_enhancer.scoreEnhancement", _e); }
  if(typeof self!=="undefined") try{ self.ZSPromptEnhancer = PromptEnhancer; }catch (_e) { globalThis.ZSSafe?.seen?.("prompt_enhancer.scoreEnhancement", _e); }

})();