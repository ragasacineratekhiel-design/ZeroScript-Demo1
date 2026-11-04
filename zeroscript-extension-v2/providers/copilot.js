// SPDX-License-Identifier: GPL-3.0-or-later
// providers/copilot.js — Copilot (https://copilot.microsoft.com)
//
// HONEST NOTE (audit #9): this is a THIN WRAPPER over providers/generic.js, not a
// bespoke integration. That is a deliberate trade-off — the generic DOM strategy
// (bottom-biased composer scan, fieldset/ProseMirror fallbacks, stream sampling)
// does the real work and is maintained in one place. What this file must NOT do is
// mutate the shared generic singleton, which is what it used to do: `setMeta()` on
// the shared object meant the LAST loaded provider won the visible identity for the
// whole page. Identity is now per-object and immutable.
const ZSProvider = (() => {
  "use strict";
  const G = ZSGenericProvider;
  const META = G.makeMeta("copilot", "Copilot");
  const P = Object.create(G);
  Object.defineProperty(P, "id", { get: () => META.id });
  Object.defineProperty(P, "displayName", { get: () => META.displayName });
  P.promptExtra = "- COPILOT: Prefer precise tool use. For Roblox Studio game settings (Lighting, Workspace etc) use execute_luau with game:GetService — don't describe steps.";
  P.version = "4.3.0";
  // Re-apply the stability patch as the composer mounts (the alias files are
  // loaded before the site has finished painting its first frame).
  try{ const _a = () => { try{ if (typeof ZSAgentStability !== "undefined" && ZSAgentStability.tryPatch) ZSAgentStability.tryPatch(); }catch{} }; _a(); setTimeout(_a, 50); setTimeout(_a, 300); }catch{}
  return P;
})();
