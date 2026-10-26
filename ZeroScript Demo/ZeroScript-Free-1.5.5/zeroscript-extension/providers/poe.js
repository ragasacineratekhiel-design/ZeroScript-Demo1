// SPDX-License-Identifier: GPL-3.0-or-later
// providers/poe.js — Poe (poe.com)
const ZSProvider = (() => {
  const G = ZSGenericProvider;
  G.setMeta("poe", "Poe");
  const P = Object.create(G);
  Object.defineProperty(P, 'id', { get: () => "poe" });
  Object.defineProperty(P, 'displayName', { get: () => "Poe" });
  P.promptExtra = "- POE: You run inside Poe — use ZeroScript commands exactly as specified for Roblox Studio control.";
  try{ const _a=()=>{try{if(typeof ZSAgentStability!=="undefined"&&ZSAgentStability.tryPatch) ZSAgentStability.tryPatch();}catch{}}; _a(); setTimeout(_a,300); setTimeout(_a,1000); }catch{}
  return P;
})();
