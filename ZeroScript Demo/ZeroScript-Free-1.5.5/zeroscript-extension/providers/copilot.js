// SPDX-License-Identifier: GPL-3.0-or-later
// providers/copilot.js — Microsoft Copilot (copilot.microsoft.com) ULTRA v3.2.0
// ULTRA: super-stable, never-drops, hedge 80ms, fieldset-aware via generic fallback.
const ZSProvider = (() => {
  const G = ZSGenericProvider;
  G.setMeta("copilot", "Copilot");
  const P = Object.create(G);
  Object.defineProperty(P, 'id', { get: () => "copilot" });
  Object.defineProperty(P, 'displayName', { get: () => "Copilot" });
  P.promptExtra = "- COPILOT: Prefer precise tool use. For Roblox Studio game settings (Lighting, Workspace etc) use execute_luau with game:GetService — don't describe steps.";
  P.version = "3.2.0 ULTRA";
  try{ const _a=()=>{try{if(typeof ZSAgentStability!=="undefined"&&ZSAgentStability.tryPatch) ZSAgentStability.tryPatch();}catch{}}; _a(); setTimeout(_a,200); setTimeout(_a,800); setTimeout(_a,2000); }catch{}
  return P;
})();
