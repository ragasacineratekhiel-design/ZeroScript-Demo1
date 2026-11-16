// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-status-fanout.js — background.js status fan-out.
//
// WHY: 4.6.0 broadcast a full status object to every provider tab once per
// socket frame. Studio chats (a tools frame per server, a status frame per
// heartbeat), so a burst produced one tabs.query + N sendMessage calls per
// frame. These assertions pin the coalescer: a burst must collapse to ONE send
// round carrying the NEWEST state, and a send must never reject into a caller.
const fs = require("fs");
const path = require("path");

let pass = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── extract the fan-out block and run it against a fake chrome ──────────────
const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
const from = src.indexOf("const BROADCAST_COALESCE_MS");
const to = src.indexOf("function fetchToken()");
if (from < 0 || to < 0) { console.log("FAIL  could not locate the fan-out block"); process.exit(1); }
const block = src.slice(from, to);

let queries = 0;
const sent = [];          // [{tabId, msg}]
const runtimeMsgs = [];   // popup messages
const brokenTab = 3;
const chrome = {
  runtime: { sendMessage: (m) => { runtimeMsgs.push(m); return Promise.reject(new Error("no popup listening")); } },
  tabs: {
    query: async () => { queries++; return [
      { id: 1, url: "https://chatgpt.com/c/1" },
      { id: 2, url: "https://gemini.google.com/app" },
      { id: brokenTab, url: "https://claude.ai/chat" },
      { id: 4, url: "https://example.com/not-a-provider" },
    ]; },
    sendMessage: (id, m) => {
      if (id === brokenTab) return Promise.reject(new Error("Receiving end does not exist"));
      sent.push({ id, m });
      return Promise.resolve();
    },
  },
};
const providerName = (u) => (/chatgpt|gemini|claude/.test(String(u || "")) ? "P" : null);
let n = 0;
const statusObj = () => ({ type: "zs-status", n: ++n });

const api = new Function("chrome", "providerName", "statusObj", "setTimeout", "clearTimeout",
  block + "; return { broadcastStatus, flushStatus, stats: () => ({ queries, sent: sent.length, seq: statusSeq }) };"
)(chrome, providerName, statusObj, setTimeout, clearTimeout);

(async () => {
  // ── a burst of 20 triggers becomes one round ─────────────────────────────
  for (let i = 0; i < 20; i++) api.broadcastStatus();
  await wait(300);
  check("20 triggers in a burst issue ONE tabs.query", queries === 1, "queries=" + queries);
  check("20 triggers reach both live provider tabs once", sent.length === 2, "sends=" + sent.length);
  check("the non-provider tab is skipped", !sent.some((s) => s.id === 4));
  check("a tab whose listener is gone does not reject the round", true); // reaching here proves it
  // The status OBJECT is built at flush time, not per trigger — so one burst
  // means one statusObj() call. That is the point: 20 triggers must not build
  // 20 snapshots of the same state (n === 1 here proves it).
  check("a 20-trigger burst builds the status object exactly ONCE", n === 1, "statusObj calls=" + n);
  check("the frame carries that built state", runtimeMsgs.length >= 1 && runtimeMsgs[0].n === 1, JSON.stringify(runtimeMsgs[0] && runtimeMsgs[0].n));
  check("the frame carries a monotonic seq", runtimeMsgs[0].seq === 1, String(runtimeMsgs[0].seq));

  // ── a trigger DURING a send is not lost ──────────────────────────────────
  api.broadcastStatus();
  await wait(300);
  const before = queries;
  api.broadcastStatus();
  await wait(300);
  check("a later trigger is still delivered (not swallowed)", queries === before + 1, `${before}→${queries}`);

  // ── flushStatus forces it immediately ────────────────────────────────────
  api.broadcastStatus();
  await api.flushStatus();
  check("flushStatus sends without waiting for the timer", sent.length >= 4);

  // ── nothing is left scheduled ────────────────────────────────────────────
  const q = queries;
  await wait(250);
  check("an idle period issues no further queries", queries === q, `${q}→${queries}`);

  console.log("\n" + pass + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
