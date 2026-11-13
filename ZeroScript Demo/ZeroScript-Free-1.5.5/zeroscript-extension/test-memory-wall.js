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
const MF_VER = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "manifest.json"), "utf8")).version;
check("stats reports the manifest version", typeof st.version === "string" && st.version === MF_VER, st.version);

// ── adoptStudioText only adopts a richer wall ─────────────────────────────
W.setWallText("# w\n## A\n1");
W.adoptStudioText("short");
check("adoptStudioText ignores short input", W.get().wall.length < 40);
W.adoptStudioText("# studio\n## A\n1\n## B\n2\n## C\n3");
check("adoptStudioText adopts a richer wall", /## C/.test(W.get().wall));

// ── persistence reaches chrome.storage ───────────────────────────────────
W.save();
check("save writes to chrome.storage", Object.keys(storage).some((k) => k.startsWith("zsWall:") || k === "zsMemoryWall"));


// ── 4.6.0 query-keyed trimmed context cache ────────────────────────────────
const tr1 = W.buildTrimmedContext("shop pricing formula", 400);
check("buildTrimmedContext populates query cache", W.stats().ctxCached === true);
const tr2 = W.buildTrimmedContext("shop pricing formula", 400);
check("cached buildTrimmedContext returns identical text", tr1 === tr2);
W.remember("gotcha", "Cache invalidates on mutation", "test");
check("remember() invalidates trimmed context cache", W.stats().ctxCached === false);

// ── 4.8.0 trimming quality ────────────────────────────────────────────────
// Trimming is the mechanism behind the "DYNAMIC TREE-TRIMMING" claim, so it
// has to actually discriminate. Before 4.8.0 every word longer than two
// characters scored, so "add leaderstats for the player" counted "add", "for"
// and "the" as content: unrelated sections earned unearned score (5 vs 2) and
// the ranking flattened. Stopwords are now dropped before scoring.
const toks = W._tokenizeQuery("add leaderstats for the player");
check("4.8.0: stopwords are dropped from query tokens",
  !toks.includes("the") && !toks.includes("for") && !toks.includes("add"), JSON.stringify(toks));
check("4.8.0: real terms survive stopword filtering",
  toks.includes("leaderstats") && toks.includes("player"), JSON.stringify(toks));

const relSec = "## Key systems\n- leaderstats to Coins/Gems/Rebirths";
const irrSec = "## Open questions\n- what should we do for the next milestone";
const oldToks = ["add", "leaderstats", "for", "the", "player"]; // pre-4.8.0 behaviour
check("4.8.0: an unrelated section no longer earns score from stopwords",
  W._scoreRelevance(irrSec, toks) === 0,
  "scored " + W._scoreRelevance(irrSec, toks) + " (was " + W._scoreRelevance(irrSec, oldToks) + ")");
check("4.8.0: the margin over an unrelated section widens",
  W._scoreRelevance(relSec, toks) - W._scoreRelevance(irrSec, toks) >
  W._scoreRelevance(relSec, oldToks) - W._scoreRelevance(irrSec, oldToks));

// The old return was `out.slice(0, budget+400)`, so a "trimmed to 600 chars"
// wall could hand back 1000 — the budget is now honoured.
const tb = W.trimContextFor("shop", 200);
check("4.8.0: trimContextFor never exceeds its budget", tb.length <= 200, tb.length + " chars");

console.log("\n" + pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
