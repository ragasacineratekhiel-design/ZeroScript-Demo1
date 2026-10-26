// SPDX-License-Identifier: GPL-3.0-or-later
// providers/perplexity.js — Perplexity AI (perplexity.ai)
const ZSProvider = (() => {
  const G = ZSGenericProvider;
  G.setMeta("perplexity", "Perplexity");
  const P = Object.create(G);
  Object.defineProperty(P, 'id', { get: () => "perplexity" });
  Object.defineProperty(P, 'displayName', { get: () => "Perplexity" });
  P.promptExtra = "- PERPLEXITY: You may see search citations — ignore them for ZeroScript tasks. For game settings (Workspace/Lighting etc) use execute_luau directly, don't search.";
  try{ const _a=()=>{try{if(typeof ZSAgentStability!=="undefined"&&ZSAgentStability.tryPatch) ZSAgentStability.tryPatch();}catch{}}; _a(); setTimeout(_a,300); setTimeout(_a,1000); }catch{}
  return P;
})();
