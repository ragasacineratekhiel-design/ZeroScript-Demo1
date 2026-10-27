// SPDX-License-Identifier: GPL-3.0-or-later
// providers/poe.js — Poe (poe.com) ULTRA v3.2.0
// ULTRA: super-stable, never-drops, hedge 80ms, fieldset-aware via generic fallback.
const ZSProvider = (() => {
  const G = ZSGenericProvider;
  G.setMeta("poe", "Poe");
  const P = Object.create(G);
  Object.defineProperty(P, 'id', { get: () => "poe" });
  Object.defineProperty(P, 'displayName', { get: () => "Poe" });
  P.promptExtra = "- POE: You run inside Poe — use ZeroScript commands exactly as specified for Roblox Studio control.";
  P.version = "3.2.0 ULTRA";
  try{ const _a=()=>{try{if(typeof ZSAgentStability!=="undefined"&&ZSAgentStability.tryPatch) ZSAgentStability.tryPatch();}catch{}}; _a(); setTimeout(_a,200); setTimeout(_a,800); setTimeout(_a,2000); }catch{}
  return P;
})();
