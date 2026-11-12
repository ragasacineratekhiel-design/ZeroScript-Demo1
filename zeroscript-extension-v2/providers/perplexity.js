// SPDX-License-Identifier: GPL-3.0-or-later
// providers/perplexity.js — Perplexity AI (perplexity.ai)
const ZSProvider = (() => {
  const G = ZSGenericProvider;
  G.setMeta("perplexity", "Perplexity");
  const P = Object.create(G);
  Object.defineProperty(P, 'id', { get: () => "perplexity" });
  Object.defineProperty(P, 'displayName', { get: () => "Perplexity" });
  P.promptExtra = "- PERPLEXITY: You may see search citations — ignore them for ZeroScript tasks. For game settings (Workspace/Lighting etc) use execute_luau directly, don't search.";
  // v3.1: team-role + ground-truth discipline + faster completion detection.
  P.promptExtra += " - TEAM ROLES (ENFORCED): planner plans only and never writes code; coder is the ONLY role that writes/changes code; checker verifies and REPORTS but never edits (coder makes the changes). Use set_role + team_msg hand-offs (kind plan/code/check). TRUTH: /truth runs the ground-truth command (live Studio probe + executed-tool ledger) — never present unverified claims as facts; label them \"not verified\".";
  P.timings = { ...P.timings, GEN_IDLE_MS: 1500, STABLE_MS: 6000 };
  try{ const _a=()=>{try{if(typeof ZSAgentStability!=="undefined"&&ZSAgentStability.tryPatch) ZSAgentStability.tryPatch();}catch{}}; _a(); setTimeout(_a,300); setTimeout(_a,1000); }catch{}
  return P;
})();
