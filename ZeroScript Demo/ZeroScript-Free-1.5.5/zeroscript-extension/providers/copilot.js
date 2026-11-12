// SPDX-License-Identifier: GPL-3.0-or-later
// providers/copilot.js — Microsoft Copilot (copilot.microsoft.com)
const ZSProvider = (() => {
  const G = ZSGenericProvider;
  G.setMeta("copilot", "Copilot");
  const P = Object.create(G);
  Object.defineProperty(P, 'id', { get: () => "copilot" });
  Object.defineProperty(P, 'displayName', { get: () => "Copilot" });
  P.promptExtra = "- COPILOT: Prefer precise tool use. For Roblox Studio game settings (Lighting, Workspace etc) use execute_luau with game:GetService — don't describe steps.";
  // v3.1: team-role + ground-truth discipline + faster completion detection.
  P.promptExtra += " - TEAM ROLES (ENFORCED): planner plans only and never writes code; coder is the ONLY role that writes/changes code; checker verifies and REPORTS but never edits (coder makes the changes). Use set_role + team_msg hand-offs (kind plan/code/check). TRUTH: /truth runs the ground-truth command (live Studio probe + executed-tool ledger) — never present unverified claims as facts; label them \"not verified\".";
  P.timings = { ...P.timings, GEN_IDLE_MS: 1500, STABLE_MS: 6000 };
  try{ const _a=()=>{try{if(typeof ZSAgentStability!=="undefined"&&ZSAgentStability.tryPatch) ZSAgentStability.tryPatch();}catch{}}; _a(); setTimeout(_a,300); setTimeout(_a,1000); }catch{}
  return P;
})();
