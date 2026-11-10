// SPDX-License-Identifier: GPL-3.0-or-later
// providers/perplexity.js — Perplexity (https://perplexity.ai)
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
  const META = G.makeMeta("perplexity", "Perplexity");
  const P = Object.create(G);
  Object.defineProperty(P, "id", { get: () => META.id });
  Object.defineProperty(P, "displayName", { get: () => META.displayName });
  P.promptExtra = "- PERPLEXITY: You may see search citations — ignore them for ZeroScript tasks. For game settings (Workspace/Lighting etc) use execute_luau directly, don't search.";
  P.version = "4.3.0";
  // Re-apply the stability patch as the composer mounts (the alias files are
  // loaded before the site has finished painting its first frame).
  try{ const _a = () => { try{ if (typeof ZSAgentStability !== "undefined" && ZSAgentStability.tryPatch) ZSAgentStability.tryPatch(); }catch (_e) { globalThis.ZSSafe?.seen?.("perplexity._a", _e); } }; _a(); setTimeout(_a, 50); setTimeout(_a, 300); }catch (_e) { globalThis.ZSSafe?.seen?.("perplexity._a", _e); }
  return P;
})();
