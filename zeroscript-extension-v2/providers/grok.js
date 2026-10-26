// SPDX-License-Identifier: GPL-3.0-or-later
// providers/grok.js — xAI Grok (grok.com)
const ZSProvider = (() => {
  const G = ZSGenericProvider;
  G.setMeta("grok", "Grok");
  const P = Object.create(G);
  Object.defineProperty(P, 'id', { get: () => "grok" });
  Object.defineProperty(P, 'displayName', { get: () => "Grok" });
  P.promptExtra = "- GROK: Be witty but precise. For Studio control (Play/Stop, Workspace, Lighting) use start_stop_play and execute_luau — never hand-wave.";
  try{ const _a=()=>{try{if(typeof ZSAgentStability!=="undefined"&&ZSAgentStability.tryPatch) ZSAgentStability.tryPatch();}catch{}}; _a(); setTimeout(_a,300); setTimeout(_a,1000); }catch{}
  return P;
})();
