// SPDX-License-Identifier: GPL-3.0-or-later
const KOFI_URL = "https://ko-fi.com/sebattfg";
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "gemini.google.com", "claude.ai",
  "www.kimi.ai", "kimi.ai",
  "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.meta.ai", "meta.ai",
  "perplexity.ai", "www.perplexity.ai", "copilot.microsoft.com",
  "grok.com", "x.ai", "poe.com", "chat.mistral.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

function safeVer() {
  try { if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) return "v" + chrome.runtime.getManifest().version; } catch {}
  return "v2.3.0";
}
try { document.getElementById("ver").textContent = safeVer(); } catch {}

function render(s) {
  if (!s) return;
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  if (!dot || !state) return;
  const list = s.servers || [];
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
  const studioOff = mcpOk && s.studio === false;
  const ok = mcpOk && !studioOff;
  dot.className = "dot " + (s.connected ? (ok ? "on" : "warn") : "");
  state.textContent = s.connected
    ? (ok ? "Connected · Roblox Studio ready"
        : studioOff ? "Studio not connected · enable the MCP server in Studio"
        : "Bridge OK · open Roblox Studio")
    : "Bridge offline — run start.bat";
  if (tools) tools.textContent = s.connected ? `${s.tools || 0} tools available` : "Run bridge.py (start.bat)";
  if (servers) servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
}

function refresh() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      render({ connected: false, tools: 0, servers: [] });
      return;
    }
    chrome.runtime.sendMessage({ type: "status" }, (s) => s && render(s));
  } catch { render({ connected: false, tools: 0, servers: [] }); }
}

function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", fn);
}

bind("reconnect", () => {
  try { chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600)); } catch {}
});
bind("restart", (e) => {
  const t = e.target; t.textContent = "Restarting…";
  try { chrome.runtime.sendMessage({ type: "restart_mcp" }, () => { t.textContent = "⟳ Restart Roblox server"; setTimeout(refresh, 600); }); } catch { t.textContent = "⟳ Restart Roblox server"; }
});
bind("kofi", () => { try { chrome.tabs.create({ url: KOFI_URL }); } catch { window.open(KOFI_URL, "_blank"); } });
bind("settings", () => {
  try {
    if (typeof chrome === "undefined" || !chrome.tabs) { window.open(DEFAULT_AI_URL, "_blank"); return; }
    chrome.tabs.query({}, (tabs) => {
      const active = tabs.find((t) => t.active && t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
      const anySupported = active || tabs.find((t) => t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
      if (anySupported) {
        chrome.tabs.sendMessage(anySupported.id, { type: "zs-open-menu" });
        chrome.tabs.update(anySupported.id, { active: true });
      } else {
        chrome.tabs.create({ url: DEFAULT_AI_URL });
      }
    });
  } catch { window.open(DEFAULT_AI_URL, "_blank"); }
});

try {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage)
    chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "zs-status") render(msg); });
} catch {}

refresh();
setInterval(refresh, 2000);

// If opened as plain file:// HTML (not extension popup), show demo state
try { if (location.protocol === "file:") setTimeout(() => render({ connected:false, tools:14, servers:[] }), 100); } catch {}
