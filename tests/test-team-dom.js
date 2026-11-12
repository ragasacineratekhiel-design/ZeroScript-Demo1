// Integration check for actual shared core against a simulated chat DOM (v4.6.0).
// Exercises MemoryWall + PromptEnhancer coexistence, /new -> /chat/test landing
// navigation, bounded inbox chunking, WS push wakeup, and strict role enforcement.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");
const root = path.join(__dirname, "..", "zeroscript-extension-v2");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

async function scenario({ sendWorks = true, hidden = false, deliverInbox = false, largeInbox = false, roleViolation = false, role = "planner", userRequest = "" } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e));
  const dom = new JSDOM(
    '<!doctype html><html><body><main id="messages"></main><form><textarea id="editor"></textarea></form></body></html>',
    { url: "https://claude.ai/new", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole }
  );
  const w = dom.window;
  if (hidden) Object.defineProperty(w.document, "hidden", { value: true, configurable: true });
  let gen = false, requests = [], listeners = [], ready = 0, submissions = [], key = "/new", replyIdx = 0;
  const editor = w.document.getElementById("editor");
  const status = {
    ok: true,
    self: { id: "mock-" + role, name: "Claude", role, team: "studio", ready: false },
    peers: [{ id: "mock-coder", name: "DeepSeek", role: role === "coder" ? "planner" : "coder", ready: true }],
    active: true,
    run_id: 1,
    communication_confirmed: false,
    phrase: "I am not directly communicating with the others try joining the other tabs",
  };
  const items = () => [...w.document.querySelectorAll("[data-role]")];
  w.fakeProvider = {
    id: "claude", displayName: "Claude", version: "4.7.0",
    timings: { RESPONSE_TIMEOUT_MS: 10000, STABLE_MS: 200, WARMUP_MS: 200, REASON_NOREPLY_MS: 500 },
    init() {}, snapshot: () => ({}), getEditor: () => editor, editorText: () => editor.value,
    chatIsEmpty: () => items().length === 0, isFreshChat: () => items().length === 0,
    conversationKey: () => key, composerFrame: () => editor.parentElement, barMount: () => null,
    allItems: items, isUserItem: (el) => el.dataset.role === "user", isAssistantItem: (el) => el.dataset.role === "assistant",
    assistantCount: () => items().filter((i) => i.dataset.role === "assistant").length,
    userCount: () => items().filter((i) => i.dataset.role === "user").length,
    lastAssistant: () => items().filter((i) => i.dataset.role === "assistant").slice(-1)[0] || null,
    itemText: (el) => el.textContent, classifyText: (el) => el.textContent,
    streamLen: (el) => (el || w.fakeProvider.lastAssistant())?.textContent.length || 0,
    readAssistant: () => { const item = w.fakeProvider.lastAssistant(); return { present: !!item, reply: item?.textContent || "", thinking: "", item }; },
    isGenerating: () => gen, isHardGenerating: () => gen, isBusyNow: () => gen,
    setInputLock() {}, stopGeneration() { gen = false; },
    enforceComposer: () => ({ ready: true }), ensureComposerReady: async () => ({ ready: true }),
    turnHalted: () => false, findContinueBtn: () => null, scanError: () => null, isTooLongMsg: () => false,
    installSendHooks() {}, findToolBlockSpot: () => null,
    typeAndSend: async (text) => {
      submissions.push(text);
      if (!sendWorks) { editor.value = ""; return; }
      const user = w.document.createElement("div");
      user.dataset.role = "user";
      user.textContent = text;
      w.document.getElementById("messages").appendChild(user);
      editor.value = "";
      gen = true;
      const idx = replyIdx++;
      setTimeout(() => {
        // Real AI sites transition from /new to /chat/<uuid> on the first submitted prompt!
        key = "/chat/test";
        const assistant = w.document.createElement("div");
        assistant.dataset.role = "assistant";
        assistant.textContent = (roleViolation && idx === 0)
          ? "###LUA###\nInstance.new('Part', workspace)\n###END_LUA###"
          : "I am the " + role + "; standing by for bridge team messages.";
        w.document.getElementById("messages").appendChild(assistant);
        gen = false;
      }, 25);
    },
  };
  w.chrome = {
    runtime: {
      id: "test-extension",
      getManifest: () => ({ version: "4.6.0" }),
      onMessage: { addListener: (fn) => listeners.push(fn) },
      lastError: null,
      sendMessage: (msg, callback) => {
        requests.push(msg);
        const r =
          msg.type === "team_register" ? status :
          msg.type === "team_status" ? status :
          msg.type === "team_ready" ? (ready++, status.self.ready = true, status) :
          msg.type === "team_inbox" ? {
            ok: true,
            messages: deliverInbox && ready && !requests.some((m) => m.type === "team_ack")
              ? Array.from({ length: largeInbox ? 8 : 1 }, (_, i) => ({
                  id: 17 + i,
                  timestamp: "2026-11-12T00:00:00+00:00",
                  from: "Gemini",
                  role: "checker",
                  text: largeInbox ? "Please inspect " + "x".repeat(11900) : "Please inspect this task.",
                }))
              : [],
          } :
          msg.type === "status" ? { connected: true, studio: true, tools: 4, servers: [] } :
          { ok: true };
        queueMicrotask(() => callback?.(r));
      },
    },
    storage: {
      local: { get: (_key, callback) => queueMicrotask(() => callback({})), set() {} },
      onChanged: { addListener() {} },
    },
  };
  try {
    // Load ALL real modules including memory_wall.js & prompt_enhancer.js!
    w.eval(
      [
        "core/safe.js", "core/config.js", "core/transport.js",
        "core/parser.js", "core/memory_wall.js", "core/prompt_enhancer.js",
      ].map(read).join("\n") +
      "\nconst ZSProvider=window.fakeProvider;\n" +
      read("core/main.js")
    );
    w.ZSMemoryWall.setWallText("# Studio Wall\n## Overview\nStageService checkpoints");
    function message(msg) {
      return new Promise((resolve) => {
        let handled = false;
        for (const listener of listeners) {
          if (listener(msg, { id: "test-extension" }, resolve) === true) handled = true;
        }
        if (!handled) resolve({ ok: false, error: "no listener" });
      });
    }
    await new Promise((r) => setImmediate(r));
    const joined = await message({ type: "zs-team-join", role, team: "studio" });
    assert.equal(joined.ok, true);
    const result = await message({ type: "zs-team-start" });
    assert.equal(result.ok, sendWorks, JSON.stringify(result));
    assert.equal(ready, sendWorks ? 1 : 0, "ready requires actual submitted-turn evidence");
    if (sendWorks) {
      assert.ok(!submissions[0].includes("━━━ ZeroScript MAX AUTO-SPEC"), "team role prompt must NOT be hijacked by PromptEnhancer");
      assert.ok(!submissions[0].includes("# Studio Wall"), "team role prompt must NOT be prefixed by MemoryWall");
    }
    if (deliverInbox) {
      // Trigger WS push event wakeup and verify rapid inbox acknowledgement!
      for (const listener of listeners) listener({ type: "zs-team-push", event: { kind: "message", team: "studio" } }, { id: "test-extension" }, () => {});
      const deadline = Date.now() + 5000;
      while (!requests.some((m) => m.type === "team_ack" && m.ids.includes(17)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(requests.some((m) => m.type === "team_ack" && m.ids.includes(17)), "background team inbox must be submitted and acknowledged");
      assert.equal(submissions.length, 2, "one startup and one real inbox submission");
      assert.match(submissions[1], /Gemini \/ checker/);
      if (largeInbox) {
        assert.equal(requests.find((m) => m.type === "team_ack").ids.length, 1, "only fully submitted message is acknowledged");
        assert.ok(submissions[1].length <= 24000);
      }
    }
    if (roleViolation) {
      const deadline = Date.now() + 3000;
      while (!submissions.some((s) => /ROLE VIOLATION/i.test(s)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(requests.some((m) => m.type === "call_tool" && m.name === "execute_luau"), false, `${role} execute_luau must NEVER reach call_tool`);
      assert.ok(submissions.some((s) => /ROLE VIOLATION/i.test(s)), `${role} receives explicit ROLE VIOLATION feedback`);
    }
    assert.ok(!requests.some((m) => m.type === "team_leave"), "/new -> /chat/test landing redirect must NOT leave the team");
    assert.ok(!requests.some((m) => m.type === "list_tools"), "team startup does not wait for Studio catalogue");
    if (userRequest) {
      // The user types a request in THIS tab. It must be relayed into the
      // team so the other agents work on the SAME task - and the extension's
      // own injections must never be relayed back.
      const typed = w.document.createElement("div");
      typed.dataset.role = "user";
      typed.textContent = userRequest;
      w.document.getElementById("messages").appendChild(typed);
      const relayDeadline = Date.now() + 6000;
      while (!requests.some((m) => m.type === "team_send" && m.kind === "request") && Date.now() < relayDeadline) {
        await new Promise((r) => setTimeout(r, 30));
      }
      const relay = requests.find((m) => m.type === "team_send" && m.kind === "request");
      assert.ok(relay, "the user's own request must be relayed into the team");
      assert.equal(relay.to, "all");
      assert.match(relay.text, /build a tycoon game/);
      assert.ok(!requests.some((m) => m.type === "team_send" && /System note: Bridge team inbox/.test(m.text || "")),
        "the extension must never relay its own inbox injection back into the team");
    }
    await message({ type: "zs-team-stop" });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(errors.length, 0, errors.map(String).join("\n"));
    console.log("PASS actual core DOM startup:", sendWorks ? "submitted" : "refused empty-editor false positive", hidden ? "(background tab)" : "", roleViolation ? `(${role} role-gate blocked execute_luau)` : "");
  } finally {
    dom.window.close();
  }
}

(async () => {
  await scenario();
  await scenario({ hidden: true, deliverInbox: true, largeInbox: true });
  await scenario({ role: "planner", roleViolation: true });
  await scenario({ role: "checker", roleViolation: true });
  await scenario({ sendWorks: false });
  await scenario({ deliverInbox: true, userRequest: "build a tycoon game" });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
