// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude-connector.js — Claude-specific handshake + wall/enhancer bootstrap v4.6.0
// Loaded BEFORE providers/claude.js on claude.ai via manifest content_scripts.
// Parallelizes bridge status + tool prefetch with a 1.5s warm handshake cache,
// and preserves raw system/feedback/Bridge-team messages untouched so landed()
// verification and multi-AI team turns never desynchronize.
const ZSClaudeConnector = (() => {
  "use strict";

  const CONNECTOR_VERSION = "4.8.0";
  const CONNECTOR_ID = "claude-custom-connector";
  const HANDSHAKE_TTL_MS = 1500;

  let _connected = false, _studio = null, _tools = [], _connectAt = 0;
  let _wallReady = false, _promptReady = false, _lastHs = null;

  function log(...a) {
    try { console.log(`[zs-claude-connector ${CONNECTOR_VERSION}]`, ...a); }
    catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.log", _e); }
  }

  async function pingBridge() {
    try {
      const r = await new Promise((res) => {
        try { chrome.runtime.sendMessage({ type: "status" }, (x) => res(x)); }
        catch (e) { globalThis.ZSSafe?.seen?.("claude-connector.ping", e); res(null); }
      });
      if (!r) return { connected: false, studio: null, tools: [], toolsLen: 0 };
      _connected = !!r.connected;
      _studio = typeof r.studio === "boolean" ? r.studio : null;
      const toolsCount = Array.isArray(r.tools) ? r.tools.length : (typeof r.tools === "number" ? r.tools : 0);
      if (Array.isArray(r.servers)) {
        const roblox = r.servers.find((s) => s.id === "roblox");
        if (roblox) _studio = roblox.alive;
      }
      return { connected: _connected, studio: _studio, toolsLen: toolsCount, raw: r };
    } catch (e) {
      globalThis.ZSSafe?.seen?.("claude-connector.pingBridge", e);
      log("pingBridge err", e);
      return { connected: false, studio: null, tools: [], toolsLen: 0 };
    }
  }

  async function ensureStudioReady(maxWaitMs = 4000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < maxWaitMs) {
      last = await pingBridge();
      if (last.connected && last.studio === true) return last;
      if (last.studio === false) {
        log("Studio degraded — no place, Edit mode ok");
        return last;
      }
      await new Promise((r) => setTimeout(r, 12));
    }
    return last;
  }

  async function handshake(force = false) {
    const now = Date.now();
    if (!force && _lastHs && _connected && now - _connectAt < HANDSHAKE_TTL_MS) {
      return _lastHs;
    }
    const t0 = now;
    const [s, wallRes, toolsRes] = await Promise.all([
      pingBridge(),
      Promise.resolve().then(() => (window.ZSMemoryWall && window.ZSMemoryWall.load ? window.ZSMemoryWall.load() : null)).catch((e) => { globalThis.ZSSafe?.seen?.("claude-connector.wall", e); return null; }),
      new Promise((res) => {
        try { chrome.runtime.sendMessage({ type: "list_tools" }, (x) => res(x)); }
        catch (e) { globalThis.ZSSafe?.seen?.("claude-connector.tools", e); res(null); }
      }),
    ]);
    _wallReady = wallRes !== undefined;
    _promptReady = !!window.ZSPromptEnhancer;
    if (toolsRes && Array.isArray(toolsRes.tools)) _tools = toolsRes.tools;
    _connectAt = Date.now();
    const ms = _connectAt - t0;
    _lastHs = s;
    try {
      let el = document.getElementById("zs-claude-wall");
      if (!el) {
        el = document.createElement("script");
        el.type = "application/json";
        el.id = "zs-claude-wall";
        (document.documentElement || document.body).appendChild(el);
      }
      el.textContent = JSON.stringify({
        version: CONNECTOR_VERSION, at: new Date().toISOString(), ms,
        connected: s.connected, studio: s.studio, tools: _tools?.length || s.toolsLen || 0,
        wall: _wallReady, prompt: _promptReady,
      });
      window.__zsClaudeConnector = {
        version: CONNECTOR_VERSION, connected: s.connected, studio: s.studio,
        tools: _tools, ms, wall: _wallReady, prompt: _promptReady,
      };
    } catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.beacon", _e); }
    return s;
  }

  function attachToProvider() {
    const P = typeof ZSProvider !== "undefined" ? ZSProvider : window.ZSProvider;
    if (!P || P._zsClaudeConnectorAttached) return false;
    if (P.id !== "claude") return false;

    P._zsClaudeConnectorAttached = true;
    P._connectorVersion = CONNECTOR_VERSION;

    const _origEnsure = P.ensureComposerReady ? P.ensureComposerReady.bind(P) : null;
    P.ensureComposerReady = async (reason) => {
      const hs = await handshake(false);
      let base = null;
      if (_origEnsure) {
        try { base = await _origEnsure(reason); }
        catch (e) { globalThis.ZSSafe?.seen?.("claude-connector.ensure", e); base = { ready: !!P.getEditor() }; }
      } else {
        base = { ready: !!P.getEditor() };
      }
      return {
        ...base, claudeConnector: true, connectorVersion: CONNECTOR_VERSION,
        bridgeConnected: hs.connected, studio: hs.studio, studioReady: hs.studio === true,
      };
    };

    // Expose enhancer + memory wall without mutating injected system/team messages
    // behind main.js submitAndGetBase's expectedPrefix check.
    P.getMemoryWall = () => window.ZSMemoryWall || null;
    P.getPromptEnhancer = () => window.ZSPromptEnhancer || null;
    P.claudeHandshake = handshake;
    log("attached to ZSProvider claude v" + CONNECTOR_VERSION);
    return true;
  }

  try { setTimeout(attachToProvider, 20); } catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.attach", _e); }
  try { setTimeout(attachToProvider, 100); } catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.attach", _e); }
  try {
    let tries = 0;
    const iv = setInterval(() => { if (attachToProvider() || ++tries > 40) clearInterval(iv); }, 50);
  } catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.attach", _e); }

  return { version: CONNECTOR_VERSION, id: CONNECTOR_ID, handshake, pingBridge, ensureStudioReady, attachToProvider };
})();
try { window.ZSClaudeConnector = ZSClaudeConnector; } catch (_e) { globalThis.ZSSafe?.seen?.("claude-connector.export", _e); }
