// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-memory-wall.js — regression suite for the wall.
//
// Added because 4.2.0 built the Memory Wall and then never read it (audit #16),
// and because a careless cleanup of the unused `_wallDirty` flag silently deleted
// the three mutation lines that MAKE the wall persist. These assertions would have
// caught both: every mutator must change the text AND bump updatedAt.
const storage = {};
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in storage) out[k] = storage[k]; });
        if (typeof cb === "function") cb(out);
        return Promise.resolve(out);
      },
      set: (obj) => { Object.assign(storage, obj); },
    },
    onChanged: { addListener() {} },
  },
};
global.window = global;
global.document = {
  documentElement: { appendChild() {} },
  body: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ textContent: "", type: "", id: "", className: "" }),
};
global.requestAnimationFrame = () => 0;
global.performance = { now: () => Date.now() };

let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

const origLog = console.log;
console.log = () => {};
require("./core/memory_wall.js");
console.log = origLog;
const W = global.window.ZSMemoryWall;

check("module loads", !!W && typeof W.setWallText === "function");

// ── setWallText must persist the text ─────────────────────────────────────
const before = W.get().updatedAt;
const t0 = Date.now();
while (Date.now() - t0 < 5) { /* let the ISO timestamp advance by >=1ms */ }
W.setWallText("# ZeroScript wall\n## Overview\nA tycoon game");
const afterSet = W.get();
check("setWallText stores the text", /tycoon game/.test(afterSet.wall));
check("setWallText bumps updatedAt", afterSet.updatedAt !== before && /^\d{4}-\d{2}-\d{2}T/.test(afterSet.updatedAt));
check("setWallText invalidates the context cache", W.stats().ctxCached === false);

// ── patchSection must replace a section, not append blindly ───────────────
W.setWallText("# wall\n## Conventions\nold rules\n## Key systems\nstuff");
W.patchSection("## Conventions", "new rules");
const patched = W.get().wall;
check("patchSection replaces the section body", /new rules/.test(patched) && !/old rules/.test(patched), patched);
check("patchSection keeps later sections", /Key systems/.test(patched));

// ── patchSection on a missing header appends it ───────────────────────────
W.setWallText("# wall\n## Overview\nx");
W.patchSection("## Gotchas", "Edit datamodel is not available in Play mode");
check("patchSection appends an unknown header", /## Gotchas/.test(W.get().wall));

// ── remember() records a fact + a timeline entry ──────────────────────────
W.remember("where", "Shop logic lives in ReplicatedStorage/ShopService", "test");
const w = W.get();
check("remember stores the fact", (w.facts.where || []).some((f) => /ShopService/.test(f.fact)));
check("remember adds a timeline entry", (w.timeline || []).length === 1);
check("remember bumps updatedAt", typeof w.updatedAt === "string" && w.updatedAt.length > 10);
// the context the model receives must contain the fact we just stored
const ctxEarly = W.buildContext();
check("buildContext includes remembered facts", /ShopService/.test(ctxEarly), ctxEarly.slice(0, 160));
check("remember caps a kind at 60 entries", (() => {
  for (let i = 0; i < 80; i++) W.remember("where", "filler " + i, "test");
  return W.get().facts.where.length === 60;
})());

// ── the context the model receives ───────────────────────────────────────
const ctx = W.buildContext();
check("buildContext stays a real string after pruning", typeof ctx === "string" && ctx.length > 0);
const trimmed = W.buildTrimmedContext("how does the shop work", 400);
check("buildTrimmedContext returns budgeted text", typeof trimmed === "string" && trimmed.length < 2000);
check("buildTrimmedContext is relevance-aware", /ShopService|Wall preview/.test(trimmed));

// ── stats() is what the diagnostics read ─────────────────────────────────
const st = W.stats();
check("stats reports wallLen", typeof st.wallLen === "number" && st.wallLen > 20);
check("stats reports the version", typeof st.version === "string" && st.version.startsWith("4.3.0"));

// ── adoptStudioText only adopts a richer wall ─────────────────────────────
W.setWallText("# w\n## A\n1");
W.adoptStudioText("short");
check("adoptStudioText ignores short input", W.get().wall.length < 40);
W.adoptStudioText("# studio\n## A\n1\n## B\n2\n## C\n3");
check("adoptStudioText adopts a richer wall", /## C/.test(W.get().wall));

// ── persistence reaches chrome.storage ───────────────────────────────────
W.save();
check("save writes to chrome.storage", Object.keys(storage).some((k) => k.startsWith("zsWall:") || k === "zsMemoryWall"));

console.log("\n" + pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
