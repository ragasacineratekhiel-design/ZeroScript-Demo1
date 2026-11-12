const { JSDOM } = require("jsdom");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.join(__dirname, "..", "zeroscript-extension-v2");
(async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "popup.html"), "utf8"), { url: "chrome-extension://ext/popup.html", runScripts: "outside-only" });
  try {
    const w = dom.window, sent = [];
    w.chrome = {
      tabs: {
        query: async () => [{ id: 5, url: "https://claude.ai/new" }],
        sendMessage: async (_id, m) => ({
          ok: true, name: "Claude", version: "4.7.0", composer: true, toolbar: true, toolbarVisible: true,
          running: false, starting: false, generating: false, background: false, draftPresent: false,
          team: { joined: true, active: true, role: "planner", can_mutate: false, communication_confirmed: true },
          note: m.type === "zs-stop-tab" ? "Stopped" : "",
        }),
      },
      storage: {
        local: {
          get: (_k, cb) => cb?.({ zsTeamName: "studio" }),
          set: async () => {},
        },
      },
      runtime: {
        getManifest: () => ({ version: "4.7.0" }),
        onMessage: { addListener() {} },
        sendMessage(m, cb) {
          sent.push(m);
          cb(m.type === "status"
            ? { connected: true, studio: false, studioProc: true, tools: 4, servers: [{ id: "roblox", alive: true, tools: 4 }], teamBindings: [{ role: "planner", name: "Claude" }, { role: "coder", name: "DeepSeek" }], faults: 1, faultSites: ["x"] }
            : { ok: true, active: true, started: [5], phrase: "I am communicating with DeepSeek and ready to help in your code" });
        },
      },
    };
    w.eval(fs.readFileSync(path.join(root, "core/safe.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "popup.js"), "utf8"));
    w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(w.document.getElementById("ver").textContent, "v4.7.0");
    assert.match(w.document.getElementById("team-roster").textContent, /planner=Claude[\s\S]*coder=DeepSeek/);
    assert.match(w.document.getElementById("tab-result").textContent, /Claude[\s\S]*planner/);
    w.document.getElementById("tab-recover").click();
    await new Promise((r) => setTimeout(r, 20));
    w.document.getElementById("tab-stop").click();
    await new Promise((r) => setTimeout(r, 20));
    w.document.getElementById("team-join").click();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(w.document.getElementById("team-result").textContent, /Joined as planner/);
    w.document.getElementById("team-start").click();
    await new Promise((r) => setTimeout(r, 30));
    assert.match(w.document.getElementById("team-result").textContent, /communicating with DeepSeek/);
    assert.equal(w.document.getElementById("faults").style.display, "block");
    console.log("PASS popup controls, roster, role-mutation badge, and v4.6.0 status");
  } finally {
    dom.window.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
