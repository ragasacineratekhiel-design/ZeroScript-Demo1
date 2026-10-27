// SPDX-License-Identifier: GPL-3.0-or-later
// core/prompt_enhancer.js — ZeroScript MAX ULTRA Prompt Optimizer v3.2.0
// Converts BAD / vague prompts into BEST prompts at MAX quality before they reach the AI.
// Runs 100% locally, no network. Used by core/main.js submitAndGetBase() as pre-processor.
// Philosophy: "make me a game" → PUBLISH-READY spec with architecture, save, polish, anti-exploit, mobile, test.
// — MAX anti-hallucination: every claim grounded in inspected place, not invented.
// — MAX speed: regex + template expansion in <2ms, zero async.
//
(() => {
  "use strict";

  const ENHANCER_VERSION = "3.2.0 ULTRA";

  // ── prompt patterns → expansion ───────────────────────────────────────
  const THEMES = {
    generic: { name:"Tap Simulator", hook:"Tap pet simulator with click → coins, pets, eggs, rebirth, shop, save", systems:["ClickService","PetService","EggService","ShopService","RebirthService","SaveService"] },
    pet: { name:"Pet Simulator", hook:"Pets follow, fuse, equip, trade, index, huge/golden", systems:["PetService","PetFusion","Trading"] },
    mining: { name:"Mining Simulator", hook:"Ore veins, pickaxe upgrades, backpack, sell area", systems:["MineService","PickaxeService"] },
    obby: { name:"Obby Simulator", hook:"Stages as worlds, coins per stage, speed pets, rebirth", systems:["StageService"] },
    tycoon: { name:"Tycoon", hook:"Plot claim, droppers, collectors, upgraders, rebirth prestige", systems:["TycoonService","PlotService"] },
    horror: { name:"Horror Experience", hook:"Atmosphere, chase AI, jumpscare, sanity, safe zones", systems:["HorrorAI","SanityService"] },
    rpg: { name:"RPG Adventure", hook:"Quests, classes, inventory, combat, bosses, loot", systems:["QuestService","CombatService"] },
    racing: { name:"Racing Simulator", hook:"Vehicles, tracks, nitro, tuning, leaderboards", systems:["RaceService","VehicleService"] },
  };

  function detectTheme(raw){
    const t=(raw||"").toLowerCase();
    if(/pet/.test(t)) return THEMES.pet;
    if(/min(ing|e)|ore|pickaxe/.test(t)) return THEMES.mining;
    if(/obby|parkour|stage/.test(t)) return THEMES.obby;
    if(/tycoon|factory|dropper/.test(t)) return THEMES.tycoon;
    if(/horror|scary|jumpscare|creepy/.test(t)) return THEMES.horror;
    if(/rpg|quest|adventure|sword|level/.test(t)) return THEMES.rpg;
    if(/race|racing|car|vehicle/.test(t)) return THEMES.racing;
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

  // ── the optimizer — returns { enhanced, changed, theme, spec } ──────
  function enhance(userPrompt, opts={}){
    const raw = String(userPrompt||"").trim();
    if(!raw) return { enhanced: raw, changed:false, theme: THEMES.generic, spec:"" };

    const theme = detectTheme(raw);
    const bad = isBadPrompt(raw);
    const vague = isVagueRequest(raw);

    // If prompt is already detailed (80+ chars + verbs), don't over-expand — just polish
    const words = raw.split(/\s+/).length;
    const detailed = raw.length >= 80 && words >= 10 && !vague;
    if(detailed && !opts.force){
      // Small polish: add verification + anti-hallucination footer
      const footer = `\n\n[ZeroScript MAX — execute with MAX payload: one execute_luau creates full folder tree via loops, verify via return. Inspect before mutate, never hallucinate API.]`;
      // Don't rewrite if user explicitly said detailed
      if(raw.includes("MAX") || raw.includes("publish")) return { enhanced: raw, changed:false, theme, spec:"" };
      return { enhanced: raw + footer, changed:true, theme, spec:"polished" };
    }

    // BAD / vague → expand to full spec
    if(bad || vague){
      const spec = buildSpec(raw, theme, opts);
      const enhanced = `${raw}\n\n${spec}`;
      // Track for diagnostics
      try{ (window.__zsPromptStats||(window.__zsPromptStats={})).enhanced=(window.__zsPromptStats.enhanced||0)+1; }catch{}
      return { enhanced, changed:true, theme, spec };
    }

    return { enhanced: raw, changed:false, theme, spec:"" };
  }

  function buildSpec(raw, theme, opts){
    const wallCtx = (()=>{ try{ return (window.ZSMemoryWall && window.ZSMemoryWall.buildContext()) || ""; }catch{ return ""; } })();
    const placeInfo = opts.placeInfo || "";
    return `━━━ ZeroScript MAX AUTO-SPEC — ${theme.name} (${theme.hook}) ━━━
Original user prompt: "${raw.slice(0,180)}"
Detected theme: ${theme.name} — Systems: ${theme.systems.join(", ")}

YOU MUST BUILD PUBLISH-READY AT MAX — no placeholder, no -- TODO, no single script. Follow Blueprint exactly:

Folder tree (Instance.new via execute_luau in ONE call per phase):
ReplicatedStorage/ZeroSim/Shared → Config, PetConfig, EggConfig, UpgradeConfig (ModuleScripts)
ServerScriptService/ZeroSim → Leaderstats, CurrencyService, ClickService, PetService, EggService, ShopService, RebirthService, SaveService
StarterGui/ZeroSimUI → MainHUD, Shop, Pets, Rebirth, Settings (ScreenGuis, scale-based UDim2.fromScale, TextScaled)
StarterPlayerScripts/ZeroSimClient → UIController, PetVisuals, ClickFX (LocalScripts)
Workspace/ZeroSimContent → ClickArea (ProximityPrompt + Billboard TAPTAP), Eggs (3 models), ShopNPCs, Spawn

Phases (do IN ORDER, 2-4 tool calls each, verify via return + inspect_instance):
Phase 0 Discovery: script_read Memory wall, inspect_instance Workspace, get_studio_state
Phase 1 Foundation: Config ModuleScripts + Leaderstats + DataStore template {Coins,Gems,Pets,Upgrades,Rebirths,PlayTime} + RemoteEvents (ReplicatedStorage ZeroSim)
Phase 2 Core Loop: ClickDetector/ProximityPrompt → CurrencyService give Coins = 1 × (1+petMult) × (1+upgrades) × (1+rebirths*0.2); MainHUD Tween coins/gems
Phase 3 Pets: PetConfig rarity Common→Mythic mult 1→50, PetService give/equip, AlignPosition follow, Pet UI
Phase 4 Eggs: Egg models + Prompt, EggConfig loot table, roll hatch, duplicate → coins, sound + particles
Phase 5 Progression/Shop/Rebirth: UpgradeService 2x, Shop GUI confirm, Rebirth cost coins*1000 reset → ×2 mult
Phase 6 World: second world @5 rebirths, teleport pad, daily reward, index, mobile button
Phase 7 Save/Test: SaveService pcall autosave 60s + BindToClose, start_stop_play true → Client simulate click → stop → fix errors → update Memory wall

Economy defaults (must implement): Egg costs Basic 100 Rare 500 Epic 2500 Legendary 10000; Pet power 1/2/5/10/25/50; auto-save 60s
Polish: TweenService every UI, SoundService Tick, ParticleEmitter, BillboardGui, mobile safe area 0.05, UICorner 8
Anti-exploit: server authority, RemoteEvent validation (player check, cooldown, distance), no client trust
Performance: no while true without task.wait(1), debounce, connections cleanup

${wallCtx ? `MemoryWall context:\n${wallCtx}\n` : ""}${placeInfo ? `Place context:\n${placeInfo}\n` : ""}
Execution: list_commands FIRST, then MAX payload per call. One execute_luau block = entire folder tree via loops. After each mutate, return {ok=true, created=...} as proof. NEVER hallucinate Instance path — inspect before mutate.

Deliver at MAX: fun in 10s, no placeholder, save working, explain test steps at end.
━━━ END AUTO-SPEC ━━━`;
  }

  // Lightweight scorer for diagnostics — how much was improved
  function scoreEnhancement(raw, enhanced){
    if(raw===enhanced) return 0;
    const rawLen=String(raw||"").length;
    const enhLen=String(enhanced||"").length;
    return Math.round((enhLen - rawLen)/12);
  }

  const PromptEnhancer = {
    version: ENHANCER_VERSION,
    enhance,
    isBadPrompt,
    isVagueRequest,
    detectTheme,
    buildSpec,
    scoreEnhancement,
    // Hook for main.js: replaces submitAndGetBase's text with enhanced version, but keeps original for display
    wrapTypeAndSend: (provider)=>{
      if(!provider || !provider.typeAndSend || provider._zsPromptWrapped) return provider;
      const orig = provider.typeAndSend.bind(provider);
      provider.typeAndSend = async (text, images)=>{
        let out = text;
        try{
          // Don't enhance tool feedback or system prompt — only user prompts
          const isFeedback = /Output of '|ERROR:|⟦ZS-/.test(text);
          if(!isFeedback){
            const r = enhance(text, { placeInfo: window.__zsWallPlaceInfo||"" });
            if(r.changed){
              console.log("[zs-prompt] enhanced bad→best", { rawLen: text.length, enhLen: r.enhanced.length, theme: r.theme.name });
              // Memory wall remembers the expansion
              try{ window.ZSMemoryWall && window.ZSMemoryWall.remember("prompt", `enhanced "${text.slice(0,40)}" → ${r.theme.name}`, "prompt_enhancer"); }catch{}
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

  try{ window.ZSPromptEnhancer = PromptEnhancer; }catch{}
  if(typeof self!=="undefined") try{ self.ZSPromptEnhancer = PromptEnhancer; }catch{}

})();
