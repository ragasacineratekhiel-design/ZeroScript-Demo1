// SPDX-License-Identifier: GPL-3.0-or-later
// core/prompt_enhancer.js — ZeroScript MAX 4.3.0 PLAN 10ms WALL — Switch Plan orchestrated + 10ms honest wall
// BAD→BEST in <0.5ms enhance + Luau syntax pre-check + 10ms plan wall — precompiled regex, trimmed wallCtx, spec contract upstream.
// SWITCH PLAN: Direct/Agent/Plan/Checker orchestrated multi-AI with 10ms BroadcastChannel wall — honest superfast.
// FACT-CHECK: prompts ALONE don't make Flash==Pro. REAL boost is INTERNAL+EXTERNAL+RUNTIME+PLAN: planner + validator + memory + sandbox + wall.
(() => {
  "use strict";

  const ENHANCER_VERSION = "4.8.0";

  // 4.8.0: the orchestration text is DERIVED from the roles that are actually
  // in the plan. It used to hardcode "three roles" and "planner first", so a
  // two-agent plan was described with the wrong handoff chain.
  function orchestrationText(roleList){
    const has=(r)=>roleList.includes(r);
    if(has("planner")&&has("coder")&&has("checker"))
      return "Planner designs blueprint + file tree (NEVER calls execute_luau/multi_edit — rejected for planner), Coder builds (Instance.new + multi_edit, ONLY mutator), Checker audits via script_read/inspect and reports defects to Coder (NEVER edits). Each writes to wall via ZSPlanWall.send(myRole,nextRole,{spec|code|review}).";
    if(has("planner")&&has("coder"))
      return "Planner → Coder: Planner outputs blueprint (phases + paths + economy, never mutates), Coder implements immediately with enriched internal commands (10ms). Use wall for handoff.";
    if(has("coder")&&has("checker"))
      return "Coder → Checker: Coder builds, Checker verifies via script_read + get_studio_state + inspect, writes defect list to Coder via wall 10ms (never edits itself).";
    if(has("planner"))
      return "Planner works on the blueprint alone (never mutates Studio).";
    if(has("checker"))
      return "Checker audits alone via script_read + get_studio_state + inspect (never edits Studio).";
    return "Single AI: you do everything.";
  }

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
      return `\n\n━━━ SWITCH PLAN ORCHESTRATION: ${planDef.name.toUpperCase()} (${planDef.ais} AIs) — ${roleList} — 10ms WALL ━━━\nYou are orchestrated as ${planDef.name}: ${orchestrationText(planDef.roles)}\nAssigned: ${assigned}\nWall: 10ms honest (BroadcastChannel + chrome.storage). Handoff format: {phase, spec, files, notes}. After you finish your role, send to next role via wall 10ms and tell user what you handed off. GUI plugin: inspect StarterGui with inspect_instance to get UDim2/Color3, then design scale-based GUI (UDim2.fromScale, UICorner 8, dark glass, Tween, Sound).\n${wallSnippet}\n━━━ END PLAN ORCHESTRATION ━━━\n`;
    }catch{ return ""; }
  }

  // ── PROMPT SCAFFOLDING — what this extension adds, and what it cannot do ──
  // TRUTH: No prompt can turn Flash weights into Pro weights. What this file does
  // is mechanical, and each piece corresponds to real code:
  // INTERNAL: expand a vague request into a checklist with a concrete file tree,
  //           and inject a TEST_CONTRACT when the workspace has tests/specs.
  // EXTERNAL: the agentic loop verifies via tools, retries with a precise fix and
  //           grounds itself in the trimmed memory_wall.
  // STATIC:   a recursive-descent Luau PARSER rejects hard syntax errors before
  //           they cost a Studio round trip. It does NOT execute anything —
  //           there is no Luau VM here, so runtime TypeErrors are caught in
  //           Studio, not by this extension. (Earlier text here claimed otherwise.)
  // No benchmark exists for this. Earlier text here quoted "~20-35% quality gain" and
  // "~40-50% Pro proximity" as measured results; there is no eval harness, dataset or
  // recorded run in this repo to support either number, so they are gone. What the
  // mechanism does is concrete (checklists, trimmed context, static syntax gate) and
  // that is what the prompt now claims.
  // HONEST: no percentage. The old text claimed "helps Flash act ~35-40% closer
  // to Pro" — no harness here measures model quality, so nothing like that can
  // be asserted. What follows describes only mechanisms that exist in code.
  const PRO_BOOST_LIGHT = `\n\n[ZEROSCRIPT SCAFFOLDING — structure, not new weights: decompose into phases (Discovery→Foundation→Core→Polish→Verify); inspect before you mutate; every Luau block you emit is PARSED before it reaches Studio, so unbalanced brackets / missing 'end' are rejected with a line and column. Memory below is trimmed to what matches this task.]`;

  // HONEST REWRITE (4.8.0). Two claims in this block were false:
  //   • item 1 advertised an "INTERNAL PLANNER (JS, upstream)" that decomposes
  //     EVERY task into 5-7 phases "before your call". No such per-task code
  //     runs; buildSpec() fires only for short/vague prompts. It now says what
  //     really happens, including "if no contract is printed, none was made".
  //   • the header quoted "prompt-only ~10-15% fewer hallucinations". Nothing
  //     in this repo measured that, so the number is gone.
  // Every item below names the function that implements it, so the model can
  // trust that the mechanism exists.
  const PRO_REASONING_FULL = `━━━ ZEROSCRIPT SCAFFOLDING — WHAT THIS EXTENSION ACTUALLY DOES FOR YOU ━━━
TRUTH FIRST: prompt scaffolding does NOT change your weights. It cannot make Flash behave like Pro, Sonnet like Opus, or Mini like Astra. No "Pro proximity" percentage is quoted anywhere, because nothing here measures it. What follows is mechanical tooling that removes avoidable mistakes.
WHAT IS REAL — each item names the code that does it:
1. SPEC CONTRACT (prompt_enhancer.buildSpec) — ONLY when a request is short or vague does the extension expand it into a concrete spec: ordered phases, Roblox service paths, verify steps. If a contract is printed below, satisfy it. If NO contract block appears, none was generated — derive the requirements yourself and never assume one exists.
2. DYNAMIC TREE-TRIMMING (memory_wall.buildTrimmedContext) — memory is importance-scored against your current task and trimmed to the most relevant sections, so unrelated branches do not crowd the context or tempt you into inventing paths that were never there.
3. STATIC LUAU PARSE GATE (sandbox.analyseLuau) — every Luau block you emit is parsed by a real recursive-descent Luau parser BEFORE it is sent to Studio. It rejects: unbalanced ( ) [ ] { }, a missing 'then' / 'end' / 'until', trailing commas in calls and parameter lists, malformed 'local' declarations, 'break'/'continue' outside a loop, a 'goto' with no matching '::label::', and dangling operators — each reported with a line AND column. There is NO Luau VM in this extension: it parses, it does not run. Nil dereferences, wrong argument types and nonexistent properties are NOT caught here; they surface from Studio as an ordinary tool error.
4. TEST CONTRACT (sandbox.inferTestContract) — when the workspace holds tests or specs, their expectations are injected below as a contract to satisfy.
WHAT YOU DO — instructions to you, not claims about tooling:
5. DECOMPOSE: break any request into 5-7 ordered phases (Discovery→Foundation→Core→Polish→Verify) before writing code.
6. PLAN FIRST: 3-line plan (what to build, where, how verified) — then execute; never code blind.
7. REASON STEP-BY-STEP: consider edge cases, exploit safety, mobile input, saving and performance before answering.
8. VERIFY EVERYTHING: inspect_instance / script_read BEFORE mutating, script_read + return AFTER. Never state a path or API you did not read.
9. MAX DEPTH: every Script complete, commented, pcall+retry around DataStore, exploiter-safe. No TODO placeholders.
10. SELF-CRITIQUE: re-read your code before sending — unbalanced brackets, missing 'end', wrong service, Vector3 vs string. The parser catches the syntax; only you can catch the logic.
━━━ END SCAFFOLDING ━━━`;

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
      template: (raw, theme, wallCtx, placeInfo) => `━━━ /truth — EVIDENCE MODE (extension-enforced) ━━━
User truth request: "${raw.slice(0,350)}"
RULES FOR THIS TURN ONLY — /truth is ENFORCED, not just suggested:
- STEP 1 (mandatory): call a READ tool FIRST — inspect_instance / script_read / get_studio_state / search_game_tree / list_commands, or verify_fact {"path":"Workspace"} for a bridge-verified read. The extension counts your tool calls: a /truth answer with ZERO tool calls is REJECTED and you are forced to call a tool. Never answer from memory.
- STEP 2: quote the tool output VERBATIM. Tag every factual claim [VERIFIED: toolName] or [NOT VERIFIED]. Anything you did not read via a tool is NOT VERIFIED — say so, never invent.
- Fact-check: cross-verify via a 2nd tool if critical (e.g. inspect + script_read). If mismatch, report the mismatch truthfully.
- If you think you made a mistake: immediate self-heal — get_studio_state→if playing start_stop_play false→verify→script_read→fix→retry (like Play STOP, ≤3).
- Zero mistakes: if unsure, say "NOT VERIFIED" instead of inventing. Never fabricate API, property, path.
${wallCtx ? `MemoryWall:\n${wallCtx}\n` : ""}${placeInfo?`Place:\n${placeInfo}\n`:""}
Call the read tool NOW, then answer with verbatim quotes + VERIFIED/NOT VERIFIED tags.
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
      name: "SMART SCAFFOLD",
      desc: "Structural boost — spec contract + trimmed memory + Luau parse gate. Adds process, not weights; no quality number is claimed",
      template: (raw, theme, wallCtx, placeInfo) => `━━━ /smart — STRUCTURAL BOOST (spec + trimmed memory + parse gate) ━━━
User smart request: "${raw.slice(0,400)}"
${PRO_REASONING_FULL}
SMART RULES (honest, 1 prompt = 1 response):
- This is PROCESS SUPPORT, not a weight upgrade: follow the checklist above, use the trimmed memory below, and satisfy the spec contract if one is printed. No quality percentage is claimed — expect fewer avoidable mistakes, not a different model.
- For vague "make sim", infer full spec (leaderstats, save, UI, pets, economy, polish) — decide and ship, don't ask.
- For bug fixes: read error → script_read → diagnose root → minimal fix → verify via return → mock play test. Never guess.
- Use tokens wisely: reasoning + bulk builds + verification proofs. Thorough > lazy one-liner.
- Output: commented, modular, exploiter-safe, Tween/Sound polish, mobile-ready.
Theme: ${theme.name} — Systems: ${theme.systems.join(", ")}
${wallCtx ? `MemoryWall:\n${wallCtx}\n` : ""}${placeInfo?`Place:\n${placeInfo}\n`:""}
APPLY NOW — spec contract (if printed) + trimmed memory + parse gate on your output.
━━━ END /smart ━━━`
    }
  };

  // Parse MULTIPLE slashes: "/truth /code /force <body>" → [{cmd, body}]
  // 4.6.0: aliases /brutal-honest & /0%-lies → truth, /follow-everything → prompt,
  // /absolute-effort → force so real-world truth/effort flags activate enforcement.
  const SLASH_ALIASES = {
    "brutal-honest": "truth",
    "0%-lies": "truth",
    "follow-everything": "prompt",
    "absolute-effort": "force",
  };
  const SLASH_RE = /\/(truth|brutal-honest|0%-lies|code|prompt|follow-everything|force|absolute-effort|smart)(?=\s|$)/gi;
  function parseSlash(raw){
    const t = String(raw||"").trim();
    if (!t.includes("/")) return null; // fast path: no slash, no scan
    const re = new RegExp(SLASH_RE.source, "gi");
    const cmds = [];
    let m;
    while ((m = re.exec(t)) !== null) {
      const k = m[1].toLowerCase();
      cmds.push(SLASH_ALIASES[k] || k);
    }
    if (!cmds.length) return null;
    // Unique preserve order, max 5
    const uniq = [...new Set(cmds)].slice(0,5);
    // Body = text after last slash command
    const lastMatch = [...t.matchAll(/\/(truth|brutal-honest|0%-lies|code|prompt|follow-everything|force|absolute-effort|smart)(?=\s|$)\s*/gi)].pop();
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

  // ── COMPACT SCAFFOLD (4.8.0) ───────────────────────────────────────────
  // The 3KB PRO_REASONING_FULL block was appended verbatim to EVERY prompt,
  // whatever the task. Generic self-help ("REASON STEP-BY-STEP", "MAX DEPTH",
  // "SELF-CRITIQUE") does not change model behaviour — it only burns tokens and
  // buries the few facts that DO matter. This is the short version, carrying
  // only what is true and actionable; the task-specific constraints come from
  // buildAcceptanceChecklist() below, derived from the user's own words.
  const SCAFFOLD_BRIEF = `[ZeroScript scaffolding — structure, not new weights:
• Every Luau block you emit is PARSED before it reaches Studio: unbalanced () [] {}, missing 'then'/'end'/'until', trailing commas, malformed 'local' and dangling operators are rejected with a line and column. Parsing is NOT execution — nil derefs, wrong argument types and nonexistent properties still return from Studio as errors.
• The memory below is trimmed to what matches this task.
• No quality percentage is claimed. This is process support, not a different model.]`;

  // ── ACCEPTANCE CHECKLIST (4.8.0) ────────────────────────────────────────
  // Turns the user's own request into concrete, checkable requirements. This is
  // the part that actually changes output: instead of "be thorough", the model
  // gets "you said 3 pets — return the count". Only triggered rules are emitted,
  // so a simple request stays short. Nothing here is invented: every line is
  // derived from text the user typed.
  const RULE_TRIGGERS = [
    [/\b(leaderstats|datastore|save|saving|persist|persistence|profile)\b/i,
      "persistence is requested → every DataStore call must be wrapped in pcall with a retry, and you must `return` the save result as proof"],
    [/\b(mobile|phone|tablet|touch)\b/i,
      "mobile is requested → size UI with UDim2.fromScale (never pixel offsets) and use a touch-friendly hit area"],
    [/\b(gamepad|controller|xbox|playstation|console)\b/i,
      "gamepad is requested → bind through ContextActionService and cover the A/Thumbstick path"],
    [/\b(sound|audio|sfx|music)\b/i,
      "audio is requested → create the Sound under SoundService with a real asset id and verify it with `return`"],
    [/\b(tween|animat|easing|smooth)\b/i,
      "animation is requested → use TweenService with an explicit EasingStyle/Direction, not a manual lerp loop"],
    [/\b(particle|vfx|effect|trail|sparkle)\b/i,
      "effects are requested → ParticleEmitter with explicit Lifetime/Rate, parented under the right part"],
    [/\b(ui|hud|gui|screen|menu|button|shop\s*ui)\b/i,
      "UI is requested → ScreenGui with ResetOnSpawn=false, and every text element must have a real value"],
    [/\b(anti[- ]?cheat|exploit|hacker|security|sanitiz|validat)/i,
      "security is requested → validate on the SERVER and never trust a client-supplied number"],
    [/\b(rebirth|prestige|ascend)\b/i,
      "rebirth is requested → leaderstats must survive the rebirth; reset only what the user said to reset"],
    [/\b(shop|buy|purchase|price|cost|economy|currency|coins?)\b/i,
      "an economy is requested → prices and balances are server-authoritative; check funds before deducting"],
    [/\b(pet|egg|hatch|rarity|legendary)\b/i,
      "pets/eggs are requested → a weighted rarity table with an explicit chance value per entry"],
    [/\b(performance|lag|fps|optimi[sz]e|60\s*fps)\b/i,
      "performance is requested → no work in RenderStepped that can be done once; use task.wait() not wait()"],
    [/\b(team|party|squad|multiplayer|co-?op)\b/i,
      "multiplayer is requested → state lives on the server; replicate through RemoteEvents, never locals"],
  ];

  function buildAcceptanceChecklist(raw) {
    const text = String(raw || "");
    const rules = [];
    for (const [re, rule] of RULE_TRIGGERS) if (re.test(text)) rules.push(rule);

    // explicit counts the user asked for ("3 pets", "two zones", "5 rounds")
    const counts = [];
    const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };
    const reCount = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:different\s+|unique\s+|distinct\s+)?([a-z][a-z-]{2,20})\b/gi;
    let m;
    while ((m = reCount.exec(text)) !== null && counts.length < 4) {
      const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : WORD_NUM[m[1].toLowerCase()];
      const noun = m[2].toLowerCase();
      if (!n || n > 200) continue;
      // "every 5 seconds" is an interval, not a count of things to build —
      // measurement and filler words are not countable deliverables.
      if (/^(and|or|the|x|px|ms|s|sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days|tick|ticks|frame|frames|fps|stud|studs|percent|times?|more|less|other)$/.test(noun)) continue;
      counts.push(`you asked for ${n} ${noun} → build exactly ${n} and \`return\` the count as proof`);
    }

    // things the user explicitly does NOT want
    const negations = [];
    const reNeg = /\b(?:no|without|don'?t|do not|never|avoid|skip|exclude)\s+([a-z][a-z\s]{2,22}?)(?:[.,;!?]|$|\s+(?:and|or|but|just|only|please)\b)/gi;
    while ((m = reNeg.exec(text)) !== null && negations.length < 3) {
      const what = m[1].trim().replace(/\s+/g, " ");
      if (what.length < 3) continue;
      negations.push(`you said NO "${what}" → do not implement it`);
    }

    const all = [...counts, ...rules, ...negations];
    if (!all.length) return "";
    return "━━━ ACCEPTANCE CHECKLIST (derived from your own request — satisfy every line) ━━━\n" +
      all.slice(0, 8).map((r) => "• " + r).join("\n") +
      "\n━━━ END CHECKLIST ━━━";
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
      const checklist = buildAcceptanceChecklist(raw);
      // 4.8.0: task-specific requirements instead of 3KB of generic coaching.
      const footer = `\n\n${SCAFFOLD_BRIEF}\n${checklist?"\n"+checklist:""}\n${contract?"\n"+contract:""}\n${wallCtx?`\nTrimmedMemory:\n${wallCtx.slice(0,500)}` : ""}\n\n[1 prompt = 1 response.]`;
      if(raw.includes("MAX") || raw.includes("publish")) return { enhanced: raw + PRO_BOOST_LIGHT, changed:true, theme, spec: PRO_BOOST_LIGHT, mode:"pro-polished" };
      return { enhanced: raw + footer, changed:true, theme, spec:"polished+pro", mode:"polished" };
    }
    if(bad || vague){
      const checklistVague = buildAcceptanceChecklist(raw);
      const spec = buildSpec(raw, theme, opts);
      const wallCtx = getWallCtx(raw);
      const contract = getTestContract(raw, wallCtx, theme);
      // 4.8.0: the checklist rides along here too. Without it the auto-spec
      // prescribes the theme's default systems even when the user excluded one
      // ("…but no trading" still produced a Trading system) and drops any count
      // they asked for.
      const proSpec = `${PRO_REASONING_FULL}${contract?"\n\n"+contract:""}\n\n${spec}${checklistVague?"\n\n"+checklistVague:""}`;
      const enhanced = `${raw}\n\n${proSpec}`;
      try{ (window.__zsPromptStats||(window.__zsPromptStats={})).enhanced=(window.__zsPromptStats.enhanced||0)+1; }catch (_e) { globalThis.ZSSafe?.seen?.("prompt_enhancer.enhance", _e); }
      return { enhanced, changed:true, theme, spec: proSpec, mode:"vague+pro" };
    }
    // Normal prompt — trimmed + contract + runtime-aware boost
    const wallCtx2 = getWallCtx(raw);
    const contract2 = getTestContract(raw, wallCtx2, theme);
    const checklist2 = buildAcceptanceChecklist(raw);
    const lightPlus = PRO_BOOST_LIGHT + getPlanOrchestration(raw) + (checklist2?"\n"+checklist2:"") +
      (contract2?"\n"+contract2:"") + (wallCtx2?`\n[wall:${wallCtx2.slice(0,280).replace(/\n/g," | ")}]` :"") +
      "\n[Every Luau block is parsed before it reaches Studio (syntax only — parsing is not execution); trimmed context keeps you lean; Switch Plan wall active]";
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

  function isInternalPrompt(raw){
    const s = String(raw||"");
    return /^\s*(?:Output of '|ERROR\b|\(System note:|# ZeroScript|ZeroScript\s+—|# Studio Wall|\[PEER MESSAGE FROM )/i.test(s) ||
      s.includes("⟦ZS-") ||
      s.includes("ZeroScript bridge team") ||
      s.includes("━━━ ZeroScript MAX");
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
    isInternalPrompt,
    detectTheme,
    buildSpec,
    scoreEnhancement,
    SLASH_DEFS,
    // slash helper for UI tooltip — includes /force + /smart
    slashHelp: ()=> Object.entries(SLASH_DEFS).map(([k,v])=> `/${k} — ${v.desc}`).join("\n"),
    PRO_BOOST_LIGHT,
    PRO_REASONING_FULL,
    SCAFFOLD_BRIEF,
    buildAcceptanceChecklist,
    wrapTypeAndSend: (provider)=>{
      if(!provider || !provider.typeAndSend || provider._zsPromptWrapped) return provider;
      const orig = provider.typeAndSend.bind(provider);
      provider.typeAndSend = async (text, images)=>{
        let out = text;
        try{
          if(!window.__zsSkipEnhance && !window.__zsTeamActive && !isInternalPrompt(text)){
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