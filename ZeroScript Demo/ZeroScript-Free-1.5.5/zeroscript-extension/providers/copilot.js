// SPDX-License-Identifier: GPL-3.0-or-later
// providers/copilot.js — Microsoft Copilot (copilot.microsoft.com)
const ZSProvider = (() => {
  const G = ZSGenericProvider;
  G.setMeta("copilot", "Copilot");
  const P = Object.create(G);
  Object.defineProperty(P, 'id', { get: () => "copilot" });
  Object.defineProperty(P, 'displayName', { get: () => "Copilot" });
  P.promptExtra = "- COPILOT: Prefer precise tool use. For Roblox Studio game settings (Lighting, Workspace etc) use execute_luau with game:GetService — don't describe steps.";
  try{ const _a=()=>{try{if(typeof ZSAgentStability!=="undefined"&&ZSAgentStability.tryPatch) ZSAgentStability.tryPatch();}catch{}}; _a(); setTimeout(_a,300); setTimeout(_a,1000); }catch{}
  return P;
})();
