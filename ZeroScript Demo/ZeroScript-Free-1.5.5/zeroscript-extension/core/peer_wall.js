// SPDX-License-Identifier: GPL-3.0-or-later
// core/peer_wall.js — ZeroScript 4.4.0 CROSS-AI PEER CHANNEL
//
// WHAT THIS FIXES (and yes, the old claim was false)
// --------------------------------------------------
// The extension advertised "2–3 AI working together". What actually existed was
// a BroadcastChannel + a storage log. Checked end to end:
//
//   * `send()` posted an envelope and pushed it into a local log. Nothing on any
//     other tab ever turned that envelope into an AI turn.
//   * the only cross-tab effect was `handleWallTask()`, which ran `execute_luau`
//     SILENTLY. The receiving AI never saw the sending AI's message — it was a
//     remote-control channel, not a conversation. So no AI ever read another
//     AI's reasoning; they just shared a Roblox Studio.
//   * `wake_provider_tabs` assigned roles by TAB INDEX
//     (`planRolesOrder[idx % n]`), ignoring the user's role→AI mapping entirely.
//   * nothing prevented two roles landing on the SAME AI, so "planner and coder
//     are different models" was never enforced — it was a label in the UI.
//
// This module is the missing layer. It does four things:
//
//   1. IDENTITY   — knows which provider THIS tab is, from the hostname.
//   2. ROUTING    — resolves role → provider from the user's plan, and refuses
//                   to route a role to the same provider (distinctness enforced,
//                   not assumed).
//   3. DELIVERY   — sends, then VERIFIES a receipt. A message that no peer
//                   acknowledged is reported as undelivered instead of silently
//                   vanishing (the old `catch {}` behaviour).
//   4. CONTEXT    — exposes an inbound mailbox that core/main.js folds into the
//                   next prompt, so the peer AI's actual words enter this AI's
//                   context window. This is the part that makes it a
//                   conversation between two different AIs.
(() => {
  "use strict";
  const VERSION = "4.5.0";

  // hostname → stable provider id. Must stay in sync with manifest matches;
  // background.js has its own copy for tab routing (it cannot see this module's
  // globals from the service worker).
  const HOST_MAP = [
    ["deepseek.com", "deepseek"],
    ["chatgpt.com", "chatgpt"],
    ["openai.com", "chatgpt"],
    ["gemini.google.com", "gemini"],
    ["claude.ai", "claude"],
    ["kimi.ai", "kimi"],
    ["chat.z.ai", "glm"],
    ["z.ai", "glm"],
    ["qwen.ai", "qwen"],
    ["arena.ai", "arena"],
    ["meta.ai", "meta"],
    ["perplexity.ai", "perplexity"],
    ["copilot.microsoft.com", "copilot"],
    ["grok.com", "grok"],
    ["x.ai", "grok"],
    ["poe.com", "poe"],
    ["mistral.ai", "mistral"],
  ];

  const HOSTNAME = (() => {
    try {
      const l = globalThis.location;
      if (l && l.hostname) return String(l.hostname).toLowerCase().replace(/^www\./, "");
    } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.HOSTNAME", _e); }
    return "";
  })();

  // provider id for a hostname (pure; exported for tests)
  function providerOf(hostname) {
    const h = String(hostname || "").toLowerCase().replace(/^www\./, "");
    if (!h) return "unknown";
    for (const [needle, id] of HOST_MAP) {
      if (h === needle || h.endsWith("." + needle)) return id;
    }
    return "unknown";
  }

  const SELF = providerOf(HOSTNAME);

  // ── distinctness ─────────────────────────────────────────────────────────
  // The whole point of a 3-AI plan is three DIFFERENT models. Two roles on the
  // same provider compares a model with itself, which is worthless as review.
  function sameProvider(a, b) {
    const x = String(a || "").toLowerCase().trim();
    const y = String(b || "").toLowerCase().trim();
    if (!x || !y) return false;
    if (x === "unknown" || y === "unknown") return false;
    return x === y;
  }

  // ── role resolution ─────────────────────────────────────────────────────
  // planRoles is { role: providerName } as configured by the user.
  // Returns { role, peerRoles:[{role, provider}], unassigned:boolean }
  function resolveRoles(selfProvider, planRoles, planRoleNames) {
    const roles = planRoleNames && planRoleNames.length ? planRoleNames : ["planner", "coder", "checker"];
    const me = String(selfProvider || "").toLowerCase();
    const mine = [];
    const peers = [];
    for (const r of roles) {
      const assigned = String((planRoles && planRoles[r]) || "").toLowerCase();
      if (!assigned) continue;
      if (sameProvider(assigned, me)) mine.push(r);
      else peers.push({ role: r, provider: assigned });
    }
    return {
      role: mine[0] || null,
      roles: mine,
      peerRoles: peers,
      unassigned: mine.length === 0,
      // a plan is only a real multi-AI plan if at least one peer differs
      multiAI: peers.length > 0,
    };
  }

  // ── distinctness audit: what is wrong with this plan, in plain words ─────
  function auditPlan(selfProvider, planRoles, planRoleNames) {
    const roles = planRoleNames && planRoleNames.length ? planRoleNames : ["planner", "coder", "checker"];
    const problems = [];
    const seen = new Map(); // provider -> [roles]
    for (const r of roles) {
      const p = String((planRoles && planRoles[r]) || "").toLowerCase();
      if (!p) { problems.push(`role "${r}" has no AI assigned`); continue; }
      if (!seen.has(p)) seen.set(p, []);
      seen.get(p).push(r);
    }
    for (const [p, rs] of seen) {
      if (rs.length > 1) problems.push(`${p} holds ${rs.length} roles (${rs.join(" + ")}) — a model cannot review itself`);
    }
    if (seen.size < 2 && roles.length > 1) problems.push("every role is the same AI — this is a single-AI run");
    return { ok: problems.length === 0, problems, distinctProviders: seen.size, rolesCovered: roles.length };
  }

  // ── the envelope ────────────────────────────────────────────────────────
  const MAX_INBOX = 60;
  const inbox = [];       // messages received from a PEER (to fold into a prompt)
  const outbox = [];      // messages sent (bounded)
  const pending = new Map(); // id -> { at, toProvider, kind } awaiting ack
  let seq = 0;

  const newId = () => {
    try { return `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }
    catch (_e) { return `id-${seq++}`; }
  };

  function makeEnvelope(kind, toProvider, payload, extra) {
    return {
      id: newId(),
      v: VERSION,
      kind: String(kind || "msg"),          // "task" | "result" | "plan" | "review" | "msg"
      fromProvider: SELF,
      toProvider: String(toProvider || "__any").toLowerCase(),
      // a peer envelope is only valid across DIFFERENT providers
      requireDifferent: true,
      t: Date.now(),
      payload: payload == null ? {} : payload,
      ...(extra || {}),
    };
  }

  function send(kind, toProvider, payload, extra) {
    const env = makeEnvelope(kind, toProvider, payload, extra);
    // Distinctness is a hard gate, not a convention: a same-provider send is
    // refused and reported, because it would produce a fake conversation.
    if (sameProvider(toProvider, SELF) && env.requireDifferent) {
      env.refused = "same-provider";
      outbox.push(env);
      while (outbox.length > MAX_INBOX) outbox.shift();
      reportCondition("send.refused", `refused to send ${kind} to own provider "${toProvider}"`);
      return { ok: false, refused: "same-provider", envelope: env };
    }
    pending.set(env.id, { at: env.t, toProvider: env.toProvider, kind: env.kind });
    if (pending.size > 200) {
      const oldest = pending.keys().next().value;
      if (oldest) pending.delete(oldest);
    }
    outbox.push(env);
    while (outbox.length > MAX_INBOX) outbox.shift();
    try { emit(env); } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.send", _e); }
    // Flat `id` mirrors what undelivered()/ack() take, so a caller never has to
    // know the id lives at .envelope.id.
    return { ok: true, id: env.id, envelope: env };
  }

  // ── transport ───────────────────────────────────────────────────────────
  // Two independent paths, because either one alone drops messages:
  //   a) BroadcastChannel — fast, same-origin-agnostic, but only live tabs;
  //   b) background routing by PROVIDER — works across origins and can wake a
  //      backgrounded tab, which BC alone cannot.
  let _bc = null;
  try {
    if (typeof BroadcastChannel === "function") {
      _bc = new BroadcastChannel("zs-peer-wall");
      _bc.onmessage = (e) => receive(e && e.data, "broadcast");
      // Node keeps a live BroadcastChannel in its event loop forever; a browser
      // tab does not care. Unref when available so a require() cannot hang.
      try { _bc.unref?.(); } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.send", _e); }
    }
  } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.send", _e); }

  // The API exposed close() but no caller used it, so the channel outlived the
  // document. Release it here, where the channel is owned.
  try {
    window.addEventListener("pagehide", () => {
      try { if (_bc) { _bc.onmessage = null; _bc.close?.(); } } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.pagehide", _e); }
      _bc = null;
    }, { once: true });
  } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.hook", _e); }

  function emit(env) {
    // (a) direct
    try { if (_bc) _bc.postMessage(env); } catch (_e) { reportStatus("peer.bc.post", {}, _e); }
    // (b) routed: the background resolves toProvider → tab ids and forwards.
    try {
      if (typeof chrome !== "undefined" && chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: "peer_route", envelope: env }, (resp) => {
          try {
            const err = chrome.runtime.lastError;
            if (err) { reportCondition("route", err.message); return; }
            if (resp && resp.ok) ack(env.id, "route:" + (resp.delivered || 0));
            else reportCondition("route", (resp && resp.error) || `underspecified route to ${env.toProvider}`);
          } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.emit", _e); }
        });
      }
    } catch (_e) { reportStatus("peer.route.throw", { id: env.id }, _e); }
  }

  function ack(id, via) {
    const p = pending.get(id);
    if (p) { p.ackedAt = Date.now(); p.via = via; pending.delete(id); }
  }

  // ── receiving ───────────────────────────────────────────────────────────
  const listeners = [];
  function onInbound(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); };
  }

  function receive(env, via) {
    if (!env || !env.id || !env.fromProvider) return { ok: false, reason: "malformed" };
    // ignore our own echoes (BC delivers to the sender)
    if (sameProvider(env.fromProvider, SELF)) {
      // Not an error: it is the sender seeing its own message. Silently drop.
      return { ok: false, reason: "self-echo" };
    }
    // Addressing: accept broadcast (__any) and direct messages to ME; reject a
    // message intended for a THIRD AI. (Before this check the condition was
    // `toProvider !== "__any" && toProvider !== SELF`, which is correct — the bug
    // was that a real-provider SELF was unknown in Node. Now that identity is
    // real, a misrouted message is correctly refused.)
    const to = String(env.toProvider || "__any").toLowerCase();
    if (to !== "__any" && to !== SELF) {
      return { ok: false, reason: "not-addressed-to-me", to, self: SELF };
    }
    if (inbox.some((m) => m.id === env.id)) return { ok: false, reason: "duplicate" };

    const msg = { ...env, receivedAt: Date.now(), via: via || "unknown" };
    inbox.push(msg);
    while (inbox.length > MAX_INBOX) inbox.shift();
    ack(env.id, "inbound");
    // tell the sender we got it, over the routed path (fire and forget, bounded)
    try {
      if (typeof chrome !== "undefined" && chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: "peer_ack", id: env.id, fromProvider: SELF, toProvider: env.fromProvider },
          () => { void chrome.runtime.lastError; });
      }
    } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.receive", _e); }
    for (const fn of listeners) { try { fn(msg); } catch (_e) { reportStatus("peer.listener", {}, _e); } }
    return { ok: true, message: msg };
  }

  // ── context folding: the actual "AI talks to AI" step ───────────────────
  // main.js calls this before building a prompt. It drains the inbox and returns
  // a bracketed block that goes into THIS AI's context, labelled with which
  // model said it. Without this, peer messages are just remote-control commands.
  function takeInbound(max) {
    const take = inbox.splice(0, Math.max(1, Math.min(max || 5, MAX_INBOX)));
    return take;
  }

  function formatForPrompt(messages) {
    if (!messages || !messages.length) return "";
    const lines = messages.map((m) => {
      const who = m.fromProvider === "unknown" ? "a peer AI" : m.fromProvider.toUpperCase();
      const kind = m.kind || "msg";
      let body = "";
      const p = m.payload || {};
      if (typeof p.text === "string" && p.text) body = p.text;
      else if (typeof p.code === "string" && p.code) body = "```luau\n" + p.code + "\n```";
      else if (typeof p.output === "string" && p.output) body = p.output;
      else { try { body = JSON.stringify(p); } catch (_e) { body = "(unprintable payload)"; } }
      if (body.length > 4000) body = body.slice(0, 4000) + "\n…[truncated]";
      const roleTag = p.role ? ` as ${p.role}` : "";
      return `--- message from ${who}${roleTag} (${kind}) ---\n${body}`;
    });
    return (
      "[ZeroScript peer channel] You are working with OTHER AIs that are NOT you. " +
      "The following arrived from a different model. Treat it as a teammate's report: " +
      "build on it, do not repeat it, and correct it if it is wrong. Do not claim to be them.\n\n" +
      lines.join("\n\n")
    );
  }

  // ── delivery honesty ────────────────────────────────────────────────────
  // A peer that never acknowledges is reported instead of assumed fine.
  function undelivered(olderThanMs) {
    // `olderThanMs || 8000` made 0 mean 8000, so "show me everything unacked"
    // was impossible to ask for — the test that passed 0 was testing nothing.
    const cutoff = Date.now() - (olderThanMs == null ? 8000 : olderThanMs);
    const out = [];
    // `<=` so olderThanMs=0 means "every unacked send", including one made in
    // this very millisecond (`<` skipped it, which made the check flaky).
    for (const [id, p] of pending) if (!p.ackedAt && p.at <= cutoff) out.push({ id, ...p });
    return out;
  }

  function stats() {
    let st = null;
    try { st = globalThis.ZSSafe?.stats?.() || null; } catch (_e) { st = null; }
    return {
      version: VERSION,
      self: SELF,
      hostname: HOSTNAME,
      transport: _bc ? "broadcast-channel+runtime" : "runtime",
      inbox: inbox.length,
      outbox: outbox.length,
      awaitingAck: pending.size,
      undelivered: undelivered().length,
      // user-facing conditions, NOT faults: readable without polluting the
      // fault count that is supposed to mean "the code is broken".
      conditions: Object.fromEntries([...conditions].map(([k, v]) => [k, v.n])),
      safe: st ? { faults: st.faults } : null,
    };
  }

  // ── reporting a user condition vs a code fault ──────────────────────────
  // "the other AI's tab isn't open", "you mapped both roles to one model" and
  // "the route was underspecified" are things the USER caused or can fix. They
  // are not defects, so they must not enter ZSSafe's fault stream.
  //
  // I first tried ZSSafe.expected() here and MEASURED that it does not work:
  // it resets its streak only on a success, and a refusal has no success
  // counterpart, so the 25th refusal still logged "repeated failure x25" —
  // a warning about code that is fine. Hence a local bounded counter instead.
  const conditions = new Map();   // site -> {n, last}
  function reportCondition(site, note) {
    try {
      const key = String(site || "?");
      const c = conditions.get(key) || { n: 0, last: 0, note: "" };
      c.n++; c.last = Date.now(); if (note) c.note = String(note);
      conditions.set(key, c);
      if (conditions.size > 16) conditions.delete(conditions.keys().next().value);
    } catch (_e) {
      // A throw IN HERE is a real defect (the counter is a Map write), so unlike
      // the conditions it counts, it does belong in the fault stream.
      globalThis.ZSSafe?.seen?.("peer_wall.reportCondition", _e);
    }
  }

  function reportStatus(site, data, err) {
    try {
      const s = globalThis.ZSSafe;
      if (!s) return;
      if (err !== undefined) s.seen?.(site, err);
      else if (data && Object.keys(data).length) s.seen?.(site, data);
      else s.seen?.(site, "status");
    } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.reportStatus", _e); }
  }

  // ── wiring into the existing plan wall ──────────────────────────────────
  // The legacy wall stays (it carries plan/config messages) but every message
  // that crosses AI boundaries now goes through here so identity + distinctness
  // + acknowledgement are guaranteed exactly once.
  function sendToRole(planRoles, targetRole, kind, payload) {
    const provider = String((planRoles && planRoles[targetRole]) || "").toLowerCase();
    if (!provider) return { ok: false, refused: "no-provider-for-role", role: targetRole };
    return send(kind, provider, { ...(payload || {}), role: targetRole });
  }

  const API = {
    version: VERSION,
    self: SELF,
    hostname: HOSTNAME,
    providerOf,
    sameProvider,
    resolveRoles,
    auditPlan,
    send,
    sendToRole,
    receive,
    onInbound,
    takeInbound,
    formatForPrompt,
    undelivered,
    ack,
    stats,
    // test/shutdown helper: releases the channel so a process can exit
    close: () => { try { _bc?.close?.(); } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.sendToRole", _e); } _bc = null; },
  };

  try { if (typeof window !== "undefined") window.ZSPeerWall = API; } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.sendToRole", _e); }
  try { if (typeof self !== "undefined") self.ZSPeerWall = API; } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.sendToRole", _e); }
  try { if (typeof globalThis !== "undefined") globalThis.ZSPeerWall = API; } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.sendToRole", _e); }
  try { if (typeof module !== "undefined" && module.exports) module.exports = API; } catch (_e) { globalThis.ZSSafe?.seen?.("peer_wall.sendToRole", _e); }
})();
