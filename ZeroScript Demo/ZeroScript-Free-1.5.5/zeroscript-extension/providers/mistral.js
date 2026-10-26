// SPDX-License-Identifier: GPL-3.0-or-later
// providers/mistral.js — Mistral Le Chat (chat.mistral.ai)
const ZSProvider = (() => {
  const G = ZSGenericProvider;
  G.setMeta("mistral", "Mistral");
  const P = Object.create(G);
  Object.defineProperty(P, 'id', { get: () => "mistral" });
  Object.defineProperty(P, 'displayName', { get: () => "Mistral" });
  P.promptExtra = "- MISTRAL: Use ZeroScript tools for any Studio project work. For game settings use execute_luau, for Play use start_stop_play.";
  try{ const _a=()=>{try{if(typeof ZSAgentStability!=="undefined"&&ZSAgentStability.tryPatch) ZSAgentStability.tryPatch();}catch{}}; _a(); setTimeout(_a,300); setTimeout(_a,1000); }catch{}
  return P;
})();
