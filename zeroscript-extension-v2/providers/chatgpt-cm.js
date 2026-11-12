// SPDX-License-Identifier: GPL-3.0-or-later
// providers/chatgpt-cm.js - ChatGPT CodeMirror tap (runs in the MAIN world).
//
// WHY THIS EXISTS: ChatGPT renders fenced code blocks with CodeMirror, and the
// rendered DOM is NOT the document. Two separate defects stack up:
//
//  1. There is no "\n" text node anywhere - one <div class="cm-line"> per source
//     line - so textContent returns the whole script on ONE line. (Handled in
//     providers/chatgpt.js textWithout, which terminates every .cm-line.)
//  2. Long lines are rendered PARTIALLY. Measured live 2026-08 on this very
//     conversation: a block whose document is 10040 chars over 15 lines had all
//     15 .cm-line nodes present but only 2339 chars of text in them - 7701 chars
//     missing. A second block: 10077 chars of document, 2033 rendered, and the
//     rendered text stopped mid-JSON with no closing brace. Blocks under ~4000
//     chars came out whole, which is why short commands always worked and long
//     ones "cut off" - the user saw the chip's token counter climb to ~1000,
//     drop to ~500 and freeze there while ChatGPT was visibly still generating.
//     That ~500-token ceiling IS this ~2000-char rendering cap.
//     It is NOT caused by our camouflage: revealing the block (removing
//     .zs-tool-hide / .zs-cmd-mask) and re-measuring after a layout + 800ms gave
//     the exact same 2339 chars. CodeMirror simply does not put the whole
//     document in the DOM.
//
// The full text IS available - in CodeMirror's own state. ChatGPT's build hangs
// its view off a `cmTile` expando on the .cm-content node
// (content.cmTile.view.viewState.state.doc). An expando set by page JS is
// invisible from a content script's isolated world, hence this MAIN-world tap:
// it republishes each block's true document into a DOM attribute, which IS
// shared across worlds, so providers/chatgpt.js can read it.
//
// Protocol: the isolated world dispatches a "zs-cm-sync" CustomEvent on
// document; DOM event dispatch runs listeners SYNCHRONOUSLY across worlds, so by
// the time dispatchEvent() returns, every attribute is up to date and can be read
// in the same tick. If this script is not loaded, the attribute is simply absent
// and chatgpt.js falls back to joining .cm-line nodes (correct for short blocks).
(() => {
  "use strict";
  if (window.__zsChatgptCm) return;
  window.__zsChatgptCm = true;

  const VERSION = "4.6.0";
  const ATTR = "data-zs-cm";
  const LEN = "data-zs-cm-len";
  try { document.documentElement.setAttribute("data-zs-cm-ver", VERSION); } catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm.ver", _e); }

  // Republishing a 10k-char attribute on every sample would churn the DOM (the
  // core samples the stream ~8x/s). Only write when the document actually grew
  // or changed length, tracked per node so a re-render starts clean.
  const seen = new WeakMap();

  // The view can hang off the content node directly, or off its own dom's tile.
  function viewOf(content) {
    const t = content && content.cmTile;
    if (!t) return null;
    return t.view || (t.dom && t.dom.cmTile && t.dom.cmTile.view) || null;
  }

  function docOf(content) {
    const v = viewOf(content);
    if (!v) return null;
    // v.state is the public getter; viewState.state is where this build keeps it.
    const st = v.state || (v.viewState && v.viewState.state);
    return st && st.doc ? st.doc : null;
  }

  function syncOne(content) {
    const doc = docOf(content);
    if (!doc) return false;
    const len = doc.length;
    if (seen.get(content) === len && content.hasAttribute(ATTR)) return true;
    let text;
    try { text = doc.toString(); } catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm.docStr", _e); return false; }
    try {
      content.setAttribute(ATTR, text);
      content.setAttribute(LEN, String(len));
      seen.set(content, len);
    } catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm.setAttr", _e); return false; }
    return true;
  }

  function syncAll() {
    let n = 0;
    for (const c of document.querySelectorAll(".cm-content")) if (syncOne(c)) n++;
    return n;
  }

  document.addEventListener("zs-cm-sync", () => { try { syncAll(); } catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm.syncAll", _e); } }, true);

  // A streaming block changes without anyone asking, and the isolated world only
  // syncs when it reads. That is enough for correctness, but a cheap idle sync
  // keeps the attribute warm so the very first read of a finished block is
  // already current.
  // HONEST (max-speed pass): this called a FULL DOM sweep every 250ms forever
  // — on a long conversation that is hundreds of node reads 4x/second, on every
  // tab, whether or not anything changed. It is now idempotent and change-gated:
  // cheap signature first, full sync only when the transcript actually moved,
  // and it idles completely when the tab is hidden.
  let _lastSig = "";
  const sig = () => {
    try {
      // No getItems() here: this module's unit is `.cm-content` (CodeMirror).
      // Signature = how many blocks + the tail of the last one.
      const nodes = document.querySelectorAll(".cm-content");
      const n = nodes.length;
      const last = n ? (nodes[n - 1].textContent || "") : "";
      return n + "|" + last.length + "|" + last.slice(-24);
    } catch (_e) { return ""; }
  };
  const tick = () => {
    try {
      if (typeof document !== "undefined" && document.hidden) return;
      const now = sig();
      if (now === _lastSig) return;      // nothing changed → no work at all
      _lastSig = now;
      syncAll();
    } catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm.tick", _e); }
  };
  // Paused when hidden (a background tab has nothing to sync) and stoppable —
  // the previous version had no way to stop it at all.
  let _tickTimer = setInterval(() => { tick(); }, 400);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearInterval(_tickTimer); _tickTimer = 0; }
    else if (!_tickTimer) _tickTimer = setInterval(() => { tick(); }, 400);
  });
  window.addEventListener("pagehide", () => { if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = 0; } });
  tick();

// ── ULTRA+ footer v2.1 — super-stable Studio + never-lose-connection ─
// Ensures provider stays alive during Roblox Studio restarts, SPA navigations,
// and editor DOM churn. Logic-only, no GUI changes.
try {
  const _zsApply = () => { try { if (typeof ZSAgentStability !== "undefined" && ZSAgentStability.tryPatch) ZSAgentStability.tryPatch(); } catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm._zsApply", _e); } };
  _zsApply(); setTimeout(_zsApply, 30); setTimeout(_zsApply, 100);
  // SPA nav guard: re-apply after pushState/replaceState
  try {
    const _origPush = history.pushState, _origReplace = history.replaceState;
    history.pushState = function(){ try{ _origPush.apply(this, arguments); }catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm._zsApply", _e); } setTimeout(_zsApply, 30); };
    history.replaceState = function(){ try{ _origReplace.apply(this, arguments); }catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm._zsApply", _e); } setTimeout(_zsApply, 30); };
  } catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm._zsApply", _e); }
} catch (_e) { globalThis.ZSSafe?.seen?.("chatgpt-cm._zsApply", _e); }

})();
