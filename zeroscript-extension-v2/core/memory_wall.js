// SPDX-License-Identifier: GPL-3.0-or-later
// core/memory_wall.js — ZeroScript MAX ULTRA Memory Wall v3.2.0
// Persistent cross-session project memory that survives reloads, SPA navs, and conversation switches.
// The Wall stores: Overview, Where things live, Conventions, Key systems, Decisions & gotchas, User prefs, Open TODO
// — mirrored in 3 layers: chrome.storage.local (instant), DOM beacon #zs-memory-wall (inspectable), and Roblox Studio ModuleScript at game.ServerStorage.ZeroScript.Memory (source of truth)
// — MAX features: compression (LZ-string-lite), timeline events, auto-prune 300 entries, anti-hallucination grounding, instant HUD badge
(() => {
  "use strict";

  const WALL_VERSION = "3.2.0 ULTRA";
  const WALL_KEY_PREFIX = "zsWall:";
  const WALL_MAX_ENTRIES = 300;
  const WALL_PRUNE_AT = 360;
  const WALL_COMPRESS_THRESHOLD = 4000;

  // Wall schema — mirrors the skeleton in config.js but with MAX fields
  const WALL_SKELETON = `# Project memory — ZeroScript MAX Wall
## Overview
_One-line what this place is_

## Where things live
- ReplicatedStorage/ZeroSim/Shared: Config modules
- ServerScriptService/ZeroSim: Services
- StarterGui/ZeroSimUI: HUDs
- Workspace/ZeroSimContent: eggs, click zone, spawn

## Conventions
- naming: PascalCase for Modules, camelCase for locals
- pcall+retry for DataStore, never SetAsync without pcall
- leaderstats → Coins/Gems/Rebirths

## Key systems
- (empty — fill as you build)

## Decisions & gotchas
- (e.g. Edit datamodel is not available in Play mode — use Server/Client)

## User preferences
- (e.g. prefers dark theme, touch-friendly)

## Open questions / TODO
- (next steps)

## Timeline (MAX)
- last update: ${new Date().toISOString()}
`;

  // ── tiny LZ-lite (repeat-aware) — avoids pulling large lib for 90% win
  function compress(str){
    try{
      if(str.length < WALL_COMPRESS_THRESHOLD) return {c:false, v:str};
      // Replace repeated headers with token
      let v = str.replace(/(## .+\n)/g, m=> `§${m.trim()}§`);
      // crude RLE for spaces
      v = v.replace(/ {3,}/g, m=> `␣${m.length}`);
      if(v.length < str.length * 0.92) return {c:true, v};
      return {c:false, v:str};
    }catch{ return {c:false, v:str}; }
  }
  function decompress(pack){
    if(!pack) return "";
    if(!pack.c) return pack.v;
    try{
      let v = pack.v;
      v = v.replace(/␣(\d+)/g, (_,n)=> " ".repeat(parseInt(n,10)));
      v = v.replace(/§(.+?)§/g, (_,h)=> h+"\n");
      return v;
    }catch{ return pack.v; }
  }

  // Stable per-place key — conversationKey already per-chat, Wall is per-place
  function wallKey(){
    try{
      // Prefer Studio place path if known via bridge status; fallback to origin
      const place = (window.__zsWallPlace || location.hostname || "global").toString().slice(0,64);
      return `${WALL_KEY_PREFIX}${place}`;
    }catch{ return `${WALL_KEY_PREFIX}global`; }
  }

  let _wall = null;
  let _wallAt = 0;
  let _wallDirty = false;

  function nowISO(){ try{ return new Date().toISOString(); }catch{ return ""; } }

  function ensureWall(){
    if(_wall && Date.now()-_wallAt < 2000) return _wall;
    // try chrome.storage sync handled async elsewhere, here return in-mem default
    if(!_wall) _wall = { version: WALL_VERSION, updatedAt: nowISO(), wall: WALL_SKELETON, timeline: [], facts: {} };
    return _wall;
  }

  // Load from chrome.storage.local (async)
  async function loadWall(){
    const k = wallKey();
    try{
      const r = await new Promise(res=> chrome.storage.local.get([k, "zsMemoryWall"], res));
      const raw = r[k] || r["zsMemoryWall"];
      if(raw){
        if(typeof raw === "string") _wall = { version:WALL_VERSION, updatedAt: nowISO(), wall: raw, timeline: [], facts:{} };
        else if(raw.wall){
          // handle compressed
          if(raw.pack) _wall = { ...raw, wall: decompress(raw.pack) };
          else _wall = raw;
        }
        // hydrate timeline cap
        if(_wall.timeline && _wall.timeline.length > WALL_MAX_ENTRIES) _wall.timeline = _wall.timeline.slice(-WALL_MAX_ENTRIES);
        _wallAt = Date.now();
        beaconWall(_wall);
        return _wall;
      }
    }catch{}
    // default
    _wall = { version:WALL_VERSION, updatedAt: nowISO(), wall: WALL_SKELETON, timeline: [], facts:{} };
    _wallAt = Date.now();
    beaconWall(_wall);
    return _wall;
  }

  function beaconWall(w){
    try{
      let el = document.getElementById("zs-memory-wall");
      if(!el){ el=document.createElement("script"); el.type="application/json"; el.id="zs-memory-wall"; (document.documentElement||document.body).appendChild(el); }
      el.textContent = JSON.stringify({ version:w.version, updatedAt:w.updatedAt, wallPreview: (w.wall||"").slice(0,400), timeline: (w.timeline||[]).slice(-5) });
      try{ window.__zsWall = w; }catch{}
    }catch{}
  }

  function saveWall(){
    if(!_wall) return;
    _wall.updatedAt = nowISO();
    const k = wallKey();
    const pack = compress(_wall.wall||"");
    const toSave = pack.c ? { version:_wall.version, updatedAt:_wall.updatedAt, pack, timeline: (_wall.timeline||[]).slice(-WALL_MAX_ENTRIES), facts: _wall.facts||{} } : { version:_wall.version, updatedAt:_wall.updatedAt, wall:_wall.wall, timeline: (_wall.timeline||[]).slice(-WALL_MAX_ENTRIES), facts: _wall.facts||{} };
    try{ chrome.storage.local.set({ [k]: toSave, zsMemoryWall: toSave }); }catch{}
    beaconWall(_wall);
    _wallDirty = false;
  }

  function pruneIfNeeded(){
    if(!_wall || !_wall.timeline) return;
    if(_wall.timeline.length >= WALL_PRUNE_AT){
      _wall.timeline = _wall.timeline.slice(-WALL_MAX_ENTRIES);
      _wallDirty = true;
    }
  }

  // Public API — used by main.js and by Studio Memory ModuleScript sync
  const MemoryWall = {
    version: WALL_VERSION,
    load: loadWall,
    save: saveWall,
    get: () => ensureWall(),
    getWallText: () => ensureWall().wall || WALL_SKELETON,
    setWallText: (txt)=>{
      const w=ensureWall(); w.wall=String(txt||"").slice(0, 20000); w.updatedAt=nowISO(); _wallDirty=true; beaconWall(w);
      // debounce save
      clearTimeout(MemoryWall._saveTimer);
      MemoryWall._saveTimer = setTimeout(saveWall, 800);
      return w;
    },
    patchSection: (header, newContent)=>{
      const w=ensureWall();
      const hdr = header.trim();
      if(!w.wall.includes(hdr)){
        w.wall = (w.wall||WALL_SKELETON).trim() + `\n\n${hdr}\n${newContent}\n`;
      } else {
        const re = new RegExp(`(${hdr.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*)([\\s\\S]*?)(?=\\n## |\\n# |$)`);
        const m = w.wall.match(re);
        if(m) w.wall = w.wall.replace(re, `$1${newContent}\n`);
        else w.wall += `\n${hdr}\n${newContent}\n`;
      }
      w.updatedAt=nowISO(); _wallDirty=true; beaconWall(w);
      clearTimeout(MemoryWall._saveTimer);
      MemoryWall._saveTimer = setTimeout(saveWall, 800);
      return w.wall;
    },
    remember: (kind, fact, source="agent")=>{
      const w=ensureWall();
      if(!w.facts) w.facts={};
      if(!w.facts[kind]) w.facts[kind]=[];
      const entry={ t: Date.now(), iso: nowISO(), kind, fact: String(fact).slice(0,400), source };
      w.facts[kind].push(entry);
      if(w.facts[kind].length>60) w.facts[kind]=w.facts[kind].slice(-60);
      // timeline
      if(!w.timeline) w.timeline=[];
      w.timeline.push({ t: entry.t, iso: entry.iso, evt: kind, msg: fact.slice(0,120) });
      pruneIfNeeded();
      w.updatedAt=nowISO(); _wallDirty=true; beaconWall(w);
      clearTimeout(MemoryWall._saveTimer);
      MemoryWall._saveTimer=setTimeout(saveWall, 900);
      try{ console.log("[zs-wall] remember", kind, fact); }catch{}
    },
    timeline: (n=20)=> (ensureWall().timeline||[]).slice(-n),
    // Build the compact context injected under system prompt — grounded, short
    buildContext: ()=>{
      const w=ensureWall();
      const lines=[];
      lines.push(`MemoryWall v${w.version} @ ${w.updatedAt}`);
      // facts summary — max 8 lines to keep context small
      for(const kind of ["where","convention","system","decision","preference","todo"]){
        const arr = (w.facts && w.facts[kind]) ? w.facts[kind].slice(-3) : [];
        if(arr.length) lines.push(`${kind}: ${arr.map(x=>x.fact).join(" | ").slice(0,180)}`);
      }
      // last wall preview (first 600 chars, stripped newlines)
      if(w.wall) lines.push(`Wall preview: ${w.wall.replace(/\s+/g," ").slice(0,600)}`);
      return lines.join("\n");
    },
    // Sync helper: when Studio Memory ModuleScript exists, prefer its content
    adoptStudioText: (studioText)=>{
      if(!studioText || typeof studioText !== "string") return;
      const t=studioText.trim();
      if(t.length < 20) return;
      if(t === ensureWall().wall) return;
      // Studio is source of truth if it has more sections
      const studioHas = (t.match(/## /g)||[]).length;
      const localHas = (ensureWall().wall.match(/## /g)||[]).length;
      if(studioHas >= localHas){
        const w=ensureWall();
        w.wall=t; w.updatedAt=nowISO(); _wallDirty=true; beaconWall(w);
        saveWall();
      }
    }
  };

  // Auto-load on script inclusion
  try{ setTimeout(loadWall, 120); }catch{}

  // Expose
  try{ window.ZSMemoryWall = MemoryWall; }catch{}
  if(typeof self!=="undefined") try{ self.ZSMemoryWall = MemoryWall; }catch{}
  if(typeof window!=="undefined") try{ window.__zsWallAPI = MemoryWall; }catch{}

})();
