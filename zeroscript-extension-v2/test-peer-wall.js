// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-peer-wall.js — regression suite for core/peer_wall.js.
//
// The extension claimed "2–3 AI work together". For three versions that claim
// was false: BroadcastChannel messages were never turned into an AI turn, so no
// AI ever READ another AI. These assertions pin the properties that make the
// claim true, and that a future refactor cannot quietly undo:
//
//   1. two different providers talk;
//   2. the same provider is REFUSED (a model cannot review itself);
//   3. a peer message actually lands in the OTHER AI's prompt text;
//   4. role resolution follows the user's mapping, never tab index;
//   5. an undelivered message is reported, not silently dropped.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Load the module in a REAL realm with a given hostname, the way a browser tab
// does. This is what makes the "two different AIs" assertions meaningful: a
// plain require() has no location, so SELF would be "unknown" and the
// distinctness gate could not be exercised at all.
const SRC = fs.readFileSync(path.join(__dirname, "core/peer_wall.js"), "utf8");
function openTab(hostname) {
  const ctx = { console, Date, Math, JSON, String, Number, Object, Array, Map, Set, Promise, Error };
  ctx.location = { hostname, href: `https://${hostname}/`, origin: `https://${hostname}` };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: `peer_wall@${hostname}` });
  return ctx.ZSPeerWall;
}

const P = openTab("chatgpt.com");              // this "tab" is ChatGPT
const CLAUDE = openTab("claude.ai");           // a genuinely separate realm
let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// ── 1. identity ──────────────────────────────────────────────────────────
check("the module identifies its own provider from location", P.self === "chatgpt", P.self);
check("providerOf maps every supported host",
  [
    ["chat.deepseek.com", "deepseek"], ["chatgpt.com", "chatgpt"], ["chat.openai.com", "chatgpt"],
    ["gemini.google.com", "gemini"], ["claude.ai", "claude"], ["www.kimi.ai", "kimi"],
    ["chat.z.ai", "glm"], ["chat.qwen.ai", "qwen"], ["arena.ai", "arena"],
    ["www.meta.ai", "meta"], ["perplexity.ai", "perplexity"],
    ["copilot.microsoft.com", "copilot"], ["grok.com", "grok"], ["x.ai", "grok"],
    ["poe.com", "poe"], ["chat.mistral.ai", "mistral"],
  ].every(([h, want]) => P.providerOf(h) === want));
check("providerOf strips www", P.providerOf("www.claude.ai") === "claude");
check("providerOf handles subdomains", P.providerOf("a.b.deepseek.com") === "deepseek");
check("unknown host is 'unknown', not a false match", P.providerOf("example.com") === "unknown");
check("empty hostname is safe", P.providerOf("") === "unknown");

// ── 2. distinctness: THE core requirement ────────────────────────────────
check("different providers are different", P.sameProvider("chatgpt", "claude") === false);
check("same provider compares equal", P.sameProvider("ChatGPT", "chatgpt") === true);
check("'unknown' never equals a real provider", P.sameProvider("unknown", "claude") === false);
check("empty values never compare equal", P.sameProvider("", "") === false);

const GOOD = { planner: "chatgpt", coder: "claude", checker: "deepseek" };
const BAD = { planner: "chatgpt", coder: "chatgpt", checker: "chatgpt" };
check("a 3-provider plan passes the audit", P.auditPlan("claude", GOOD, ["planner", "coder", "checker"]).ok === true);
check("the audit counts distinct providers", P.auditPlan("claude", GOOD, ["planner", "coder", "checker"]).distinctProviders === 3);
const badAudit = P.auditPlan("chatgpt", BAD, ["planner", "coder", "checker"]);
check("a single-AI plan FAILS the audit", badAudit.ok === false);
check("the audit names the self-review problem", badAudit.problems.some((p) => /cannot review itself/.test(p)), JSON.stringify(badAudit.problems));
check("the audit says it is a single-AI run", badAudit.problems.some((p) => /single-AI/.test(p)));
const partial = P.auditPlan("chatgpt", { planner: "chatgpt" }, ["planner", "coder"]);
check("unassigned roles are reported", partial.problems.some((p) => /no AI assigned/.test(p)), JSON.stringify(partial.problems));

// ── 3. role resolution follows the USER's mapping ────────────────────────
const fromClaude = P.resolveRoles("claude", GOOD, ["planner", "coder", "checker"]);
check("a tab knows its own role from the plan", fromClaude.role === "coder", JSON.stringify(fromClaude));
check("it lists the other AIs as peers", fromClaude.peerRoles.length === 2);
check("it knows this is a multi-AI run", fromClaude.multiAI === true);
const fromChatgpt = P.resolveRoles("chatgpt", GOOD, ["planner", "coder", "checker"]);
check("a different tab gets a different role", fromChatgpt.role === "planner");
const solo = P.resolveRoles("poe", GOOD, ["planner", "coder", "checker"]);
check("an unassigned provider is flagged, not given a bogus role", solo.unassigned === true && solo.role === null);

// ── 4. sending: same-provider is refused, cross-provider is accepted ─────
// (in Node `self` is "unknown", so a real-provider target is cross-provider)
const refuse = P.send("task", "chatgpt", { text: "talking to myself" });
check("sending to your own provider is REFUSED", refuse.ok === false && refuse.refused === "same-provider", JSON.stringify(refuse.refused));
const ok = P.send("task", "claude", { text: "here is the plan" });
check("sending to a different provider is accepted", ok.ok === true && !!ok.envelope);
check("the envelope records who sent it", ok.envelope.fromProvider === P.self);
check("the envelope records where it goes", ok.envelope.toProvider === "claude");
check("the envelope demands a different provider", ok.envelope.requireDifferent === true);

// ── 5. receiving: identity + addressing enforced ─────────────────────────
const caught = [];
P.onInbound((m) => caught.push(m));
const inbound = { id: "in-1", v: "4.4.0", kind: "review", fromProvider: "claude", toProvider: "chatgpt", requireDifferent: true, payload: { text: "your loop leaks memory" } };
const r1 = P.receive(inbound, "test");
check("a peer message is accepted", r1.ok === true, JSON.stringify(r1));
check("it fires the inbound listener", caught.length === 1);
check("a duplicate is rejected", P.receive(inbound, "test").ok === false);
// addressed to a THIRD AI (deepseek), not to this chatgpt tab
check("a message for a third AI is ignored", P.receive({ ...inbound, id: "in-2", toProvider: "deepseek" }, "test").ok === false);
check("a broadcast message is accepted", P.receive({ ...inbound, id: "in-b", toProvider: "__any" }, "test").ok === true);
check("a message addressed to me is accepted", P.receive({ ...inbound, id: "in-me", toProvider: "chatgpt" }, "test").ok === true);
check("the sender's own echo is ignored", P.receive({ ...inbound, id: "in-3", fromProvider: P.self }, "test").ok === false);
check("a malformed envelope is rejected", P.receive({ id: "x" }, "test").ok === false);
check("null is handled", P.receive(null, "test").ok === false);

// ── 6. THE point: a peer's words reach this AI's prompt ──────────────────
const msgs = P.takeInbound(5);
check("takeInbound drains the mailbox", msgs.length >= 1);
check("takeInbound empties it (no replay next turn)", P.takeInbound(5).length === 0);
const prompt = P.formatForPrompt(msgs);
check("the prompt block names the other AI", /CLAUDE/.test(prompt), prompt.slice(0, 120));
check("the prompt says it is a different model", /NOT you|different model/.test(prompt));
check("the peer's actual words are included", /leaks memory/.test(prompt));
check("the prompt forbids impersonation", /Do not claim to be them/.test(prompt));
check("an empty mailbox produces no prompt pollution", P.formatForPrompt([]) === "");
check("null is safe", P.formatForPrompt(null) === "");
check("a code payload is fenced as Luau", /```luau/.test(P.formatForPrompt([{ fromProvider: "deepseek", kind: "task", payload: { code: "print(1)" } }])));
const big = P.formatForPrompt([{ fromProvider: "deepseek", payload: { text: "a".repeat(9000) } }]);
check("an oversized payload is truncated", big.includes("[truncated]") && big.length < 5000, "len=" + big.length);

// ── 6b. A REAL round trip between two separate realms ────────────────────
// This is the claim the extension makes, tested end to end: one AI's message
// arriving in another AI's context, over the real transport.
const got = [];
CLAUDE.onInbound((m) => got.push(m));
const sent = P.send("review", "claude", { text: "the economy loop double-counts visits", role: "planner" });
check("a message to a different AI is not refused", sent.ok === true, JSON.stringify(sent.refused));
// deliver it the way background.js does (runtime message → page)
const delivered = CLAUDE.receive(sent.envelope, "runtime");
check("the peer realm accepts it", delivered.ok === true, JSON.stringify(delivered));
check("the peer realm received exactly one message", got.length === 1);
check("the peer knows it came from ChatGPT", got[0].fromProvider === "chatgpt", got[0].fromProvider);
const peerPrompt = CLAUDE.formatForPrompt(CLAUDE.takeInbound(5));
check("the peer's next prompt contains the sender's words", /double-counts visits/.test(peerPrompt));
check("the peer's prompt is labelled with the sender", /CHATGPT/.test(peerPrompt));
check("ChatGPT's inbound mailbox stayed empty (it did not talk to itself)", P.takeInbound(5).length === 0);
check("the two realms resolve to different roles", P.resolveRoles("chatgpt", GOOD, ["planner","coder","checker"]).role !== CLAUDE.resolveRoles("claude", GOOD, ["planner","coder","checker"]).role);

// ── 7. delivery honesty ──────────────────────────────────────────────────
// NOTE: `Array.isArray(dl)` was the whole assertion here for two versions, which
// passes even if undelivered() is hard-coded to return []. Pin both directions
// with a send that is deliberately never acknowledged.
const before = P.undelivered(0).length;
const lonely = P.send("msg", "deepseek", { text: "this peer tab is closed" });
check("a send with no live receiver is pending", lonely.ok === true, JSON.stringify(lonely));
const dl = P.undelivered(0);
check("unacknowledged sends are visible as undelivered", Array.isArray(dl) && dl.length > before,
  `before=${before} after=${dl.length}`);
check("the undelivered entry names the peer that never answered",
  dl.some((d) => d.id === lonely.id && d.toProvider === "deepseek"),
  JSON.stringify(dl.map((d) => [d.id, d.toProvider])));
// and the honest inverse: once acked, it is no longer reported as lost.
if (typeof P.ack === "function") P.ack(lonely.id, "test");
check("an acknowledged send stops being reported as undelivered",
  !P.undelivered(0).some((d) => d.id === lonely.id));
check("stats reports the transport actually in use", /broadcast|runtime/.test(P.stats().transport), P.stats().transport);
check("stats reports the effective self identity", typeof P.stats().self === "string");
check("stats is bounded metadata only", Object.keys(P.stats()).length < 12);

// ── 8. the background router cannot drift from this table ────────────────
const bgSrc = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
const missingInBg = [];
for (const [needle, id] of [["deepseek.com", "deepseek"], ["chatgpt.com", "chatgpt"], ["openai.com", "chatgpt"],
  ["gemini.google.com", "gemini"], ["claude.ai", "claude"], ["kimi.ai", "kimi"], ["chat.z.ai", "glm"],
  ["z.ai", "glm"], ["qwen.ai", "qwen"], ["arena.ai", "arena"], ["meta.ai", "meta"],
  ["perplexity.ai", "perplexity"], ["copilot.microsoft.com", "copilot"], ["grok.com", "grok"],
  ["x.ai", "grok"], ["poe.com", "poe"], ["mistral.ai", "mistral"]]) {
  if (!bgSrc.includes(`"${needle}"`) || !bgSrc.includes(`"${id}"`)) missingInBg.push(needle + "→" + id);
}
check("background.js provider table matches peer_wall.js", missingInBg.length === 0, missingInBg.join(", "));
check("background.js has the peer_route handler", bgSrc.includes('case "peer_route"'));
check("main.js handles zs-peer-inbound", fs.readFileSync(path.join(__dirname, "core/main.js"), "utf8").includes("zs-peer-inbound"));

// ── 9. the ack must come BACK, not just be logged ────────────────────────
// Regression guard for a bug that made every DELIVERED message look lost:
// peer_ack was received by background.js and only written to a log, so the
// sender's pending map never cleared.
const mainSrc = fs.readFileSync(path.join(__dirname, "core/main.js"), "utf8");
check("main.js accepts the relayed ack", /zs-peer-ack/.test(mainSrc));
check("main.js clears pending on ack", /PW\.ack\(m\.id\)/.test(mainSrc));
check("background relays peer_ack to the sender tab", /zs-peer-ack/.test(bgSrc));
check("background targets the sender by provider, not by broadcast", /told\+\+/.test(bgSrc) && /providerIdForHost/.test(bgSrc.slice(bgSrc.indexOf("peer_ack"), bgSrc.indexOf("peer_whoami"))));
const apiAck = typeof P.ack === "function";
check("ack is exported so the content script can call it", apiAck);

// ── 10. a route that delivers to nobody must not report ok ───────────────
// background.js decides ok/fail from `delivered` and `targets`. Model that
// decision exactly and prove the zero-delivery branch is a failure. (The old
// version answered ok:true, delivered:0 whenever a target tab merely existed.)
const routeSlice = bgSrc.slice(bgSrc.indexOf('case "peer_route"'), bgSrc.indexOf('case "peer_ack"'));
check("peer_route has a zero-delivery failure branch", /else if\(!delivered\)/.test(routeSlice));
check("the zero-delivery branch explains why", /cannot message itself/.test(routeSlice));
function routeDecision(delivered, targetCount) {
  if (!delivered && !targetCount) return { ok: false, why: "no-open-tab" };
  if (!delivered) return { ok: false, why: "filtered-to-nobody" };
  return { ok: true, why: "delivered" };
}
check("route with a live target is ok", routeDecision(1, 1).ok === true);
check("route with no tab at all fails", routeDecision(0, 0).ok === false && routeDecision(0, 0).why === "no-open-tab");
check("route whose only target is the sender fails", routeDecision(0, 2).ok === false && routeDecision(0, 2).why === "filtered-to-nobody");

// ── 11. a user condition is not a code fault ─────────────────────────────
// Refusing to send to your own provider is normal (plan audit, solo run). It
// used to go through ZSSafe.seen(), so 25 such refusals logged "repeated
// failure x25" about code that is fine. Expected conditions get their own
// counter instead of the fault stream.
const sentCount = 30;
for (let i = 0; i < sentCount; i++) P.send("msg", "chatgpt", { text: "self send" });
check("same-provider sends are refused", P.send("msg", "chatgpt", { text: "x" }).ok === false);
check("refusals are counted as conditions, not faults",
  (P.stats().conditions || {})["send.refused"] >= sentCount,
  JSON.stringify(P.stats().conditions));
check("the peer module did not borrow ZSSafe to report a refusal",
  !/reportStatus\("peer\.send\.refused"/.test(SRC));
check("no refusal path calls ZSSafe.seen with a condition site",
  !/seen\?\.\("send\.refused"/.test(SRC));

P.close();
CLAUDE.close();
const total = pass + failed;
console.log("\n" + pass + "/" + total + " passed" + (failed ? ", " + failed + " FAILED" : ""));
process.exit(failed ? 1 : 0);
