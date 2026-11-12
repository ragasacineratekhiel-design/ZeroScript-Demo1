// SPDX-License-Identifier: GPL-3.0-or-later
// zeroscript-extension-v2/test-sandbox.js — regression suite for core/sandbox.js.
//
// These assertions exist because the 4.2.0 analyser REJECTED valid Luau
// (three sequential for-loops, a paren inside a comment) and main.js blocks
// execute_luau on a syntax failure — so correct AI code was thrown away before it
// reached Studio. Every "must pass" case below was a false positive in 4.2.0.
const S = require("./core/sandbox.js");
let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// ── must be ACCEPTED (these are all valid Luau) ────────────────────────────
const VALID = {
  "three sequential for-loops (4.2.0 false positive)":
    "local t = {}\nfor i = 1, 10 do\n  t[i] = i\nend\nfor j = 1, 5 do\n  t[j] = j\nend\nreturn #t",
  "paren inside a line comment (4.2.0 false positive)":
    "local x = (1 + 2)\n-- build (fast)\nreturn x",
  "while ... do (do must not double count)":
    "local n = 0\nwhile n < 5 do\n  n = n + 1\nend\nreturn n",
  "for ... in ... do":
    "for k, v in pairs(t) do\n  print(k, v)\nend\nreturn 1",
  "standalone do block":
    "do\n  local a = 1\nend\nreturn 2",
  "repeat ... until":
    "local i = 0\nrepeat i = i + 1 until i > 3\nreturn i",
  "nested if/elseif/else":
    "if a then\nelseif b then\nelse\nend\nreturn 1",
  "function returning function":
    "local function f(a)\n  if a then return function() return 1 end end\nend\nreturn f",
  "long comment with unbalanced brackets":
    "--[==[ ( ( ( ]==]\nreturn (1)",
  "long string containing braces":
    "local s = [[ } ( ]]\nreturn s",
  "levelled long string containing ]]":
    "local s = [==[ ]] ) ]==]\nreturn s",
  "escaped quote in string":
    'local s = "a\\"b("\nreturn s',
  "escaped newline in string":
    'local s = "line1\\\nline2"\nreturn s',
  "task.spawn with infinite while":
    "task.spawn(function()\n  while true do\n    task.wait(1)\n  end\nend)\nreturn 1",
  "pcall-wrapped DataStore":
    'local ok, err = pcall(function()\n  return DS:SetAsync("k", 1)\nend)\nif not ok then warn(err) end\nreturn ok',
  "Luau type annotations":
    "local x: number = 5\nlocal f: (number) -> string = function(a) return tostring(a) end\nreturn f(x)",
  "continue keyword":
    "for i = 1, 10 do\n  if i % 2 == 0 then continue end\nend",
  "hex + exponent literals":
    "return 0xFF + 1e3 + 0x1p4",
  "string containing a keyword":
    'local s = "if for while do end"\nreturn s',
};
for (const [name, code] of Object.entries(VALID)) {
  const r = S.analyseLuau(code);
  check("valid: " + name, r.ok, r.error);
}

// ── must be REJECTED, with an accurate message ─────────────────────────────
const INVALID = {
  "missing end": ["local function f()\n  if true then\n    return 1\nend\nreturn f", /needs 'end'/],
  "stray end": ["return 1\nend", /unexpected 'end'/],
  "until without repeat": ["local i = 0\nuntil i > 1", /unexpected 'until'/],
  "unterminated string": ['local s = "abc\nreturn s', /unterminated string/],
  "unterminated long string": ["local s = [[abc\nreturn s", /unterminated long string/],
  "unterminated long comment": ["--[[ abc\nreturn 1", /unterminated long comment/],
  "empty input": ["   ", /empty/],
};
for (const [name, [code, re]] of Object.entries(INVALID)) {
  const r = S.analyseLuau(code);
  check("reject: " + name, !r.ok && re.test(String(r.error || "")), r.ok ? "was accepted" : r.error);
}

// ── warnings never block ───────────────────────────────────────────────────
const w = S.analyseLuau("local p = game.Workspace.Part\np.Position = Vector3.new(1,2,3)\nprint(p)\nreturn p");
check("warning: print() is flagged but not fatal", w.ok && (w.warnings || []).some((x) => /print/.test(x)));
check("warning: string Position is flagged", (S.analyseLuau('local p = game:GetService("Workspace")\np.Position = "1,2,3"').warnings || []).some((x) => /Position/.test(x)));

// ── honest capability statement ────────────────────────────────────────────
check("honest: no runtime execution is claimed", S.capabilities && S.capabilities.runtimeExecution === false);
check("honest: luau is static-only", S.capabilities && S.capabilities.luau === "static-only");

// ── reply scanning ─────────────────────────────────────────────────────────
const reply = "Here you go:\n```lua\nfor i=1,3 do\n print(i)\nend\n```\ndone";
const dr = S.dryRunReply(reply);
check("extracts a fenced lua block", dr.ok && dr.blocks === 1);
check("rejects a broken block in a reply", !S.dryRunReply("```lua\nfor i=1,3 do\n```").ok);
check("no code is not an error", S.dryRunReply("just prose").kind === "no-code");
const fb = S.formatFixFeedback({ ok: false, error: "x", line: 12 });
check("feedback includes the line number", typeof fb === "string" && /line 12/.test(fb));

// ── JS parse check is real ─────────────────────────────────────────────────
check("js: valid parses", S.checkJS("const a = 1;").ok);
check("js: invalid rejected", !S.checkJS("const a = ;").ok);


// ── 4.6.0 version + memoized static analysis immutability ──────────────────
check("sandbox version is 4.6.0", S.version === "4.6.0", S.version);
const c1 = S.analyseLuau("local a = 1\nprint(a)\nreturn a");
c1.warnings.push("mutated-by-caller");
const c2 = S.analyseLuau("local a = 1\nprint(a)\nreturn a");
check("cached analyseLuau clones warnings so caller mutation cannot corrupt cache", !c2.warnings.includes("mutated-by-caller"));

console.log("\n" + pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
