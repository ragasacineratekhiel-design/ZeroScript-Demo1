// SPDX-License-Identifier: GPL-3.0-or-later
// test-composer.js — the chat box belongs to the user.
//
// The extension used to paint a full-bleed "Agent is working…" panel over the
// composer AND set `.zs-typing` on the editor (transparent text). Between them
// the user could not see what they were typing, could not click into the box,
// and — because several loop-exit paths never reached the `finally` that lifts
// it — could not type at all after the AI had already finished.
//
// The user asked for it removed rather than fixed. These assertions check the
// removal from the outside, so a future edit cannot quietly reintroduce it:
//   * nothing locks the composer,
//   * nothing paints a cover or masks the text,
//   * the stylesheet neutralises any stale cover from an older build,
//   * the send path refuses to overwrite a draft the user is writing.
const fs = require("fs");
const path = require("path");

const EXT = __dirname;
const mainSrc = fs.readFileSync(path.join(EXT, "core", "main.js"), "utf8");
const css = fs.readFileSync(path.join(EXT, "overlay.css"), "utf8");
// Comments are removed first: this codebase records what it USED to do in
// comments, and matching those would fail the test on its own honesty notes.
const code = mainSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

let pass = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

// ── 1. the composer is never locked ────────────────────────────────────────
const locksEngaged = [...code.matchAll(/setInputLock\s*\(\s*true\s*\)/g)];
check("the extension never engages an input lock", locksEngaged.length === 0,
  locksEngaged.length + " setInputLock(true) call(s) remain");

// ── 2. no cover, no mask ───────────────────────────────────────────────────
check("no code creates the #zs-input-cover panel",
  !/zs-input-cover/.test(code.replace(/getElementById\("zs-input-cover"\)/g, "").replace(/\.remove\(\)/g, "")),
  "a creation site survived");
check("no code adds the .zs-typing mask class",
  !/classList\.add\(\s*["']zs-typing["']\s*\)/.test(code));
check("the 'Agent is working' copy is not rendered",
  !/Agent is working/.test(code));

// ── 3. stale builds are neutralised ────────────────────────────────────────
check("overlay.css forces any leftover cover hidden",
  /#zs-input-cover\s*\{[^}]*display:\s*none\s*!important/s.test(css),
  "an old build's panel could still render");
check("overlay.css no longer makes typed text transparent",
  !/\.zs-typing[^{]*\{[^}]*color:\s*transparent/s.test(css));
check("overlay.css no longer caps the composer height",
  !/\.zs-typing[^{]*\{[^}]*max-height/s.test(css));

// ── 4. a stale cover is actively cleaned up ────────────────────────────────
check("inputCover() removes a leftover cover node",
  /getElementById\("zs-input-cover"\)[\s\S]{0,80}?remove\(\)/.test(code));
check("inputCover() strips a leftover mask class",
  /classList\.remove\(\s*["']zs-typing["']\s*\)/.test(code));

// ── 5. the user's draft is protected ───────────────────────────────────────
// Removing the cover means the user CAN type while the agent works, so the send
// path has to stop overwriting them. This is the half of the change that is easy
// to forget and would silently delete someone's message.
check("the send path detects a user draft before typing",
  /send\.userTyping/.test(code), "no draft check in submitAndGetBase");
check("the send path waits for the draft instead of overwriting it",
  /waitFor\(\(\)\s*=>\s*\{[^}]*draft\(\)[^}]*\}/s.test(code) || /Holding your draft/.test(code));
check("holding a draft tells the user why it paused",
  /Holding your draft/.test(mainSrc));


// ── 6. 4.6.0 submitAndGetBase prefix integrity (team inbox never fails landed)
const fnStart = code.indexOf("async function submitAndGetBase");
const fnSlice = code.slice(fnStart, fnStart + 2600);
check("ZSMemoryWall context is computed BEFORE expectedPrefix",
  fnSlice.indexOf("buildTrimmedContext") > 0 && fnSlice.indexOf("buildTrimmedContext") < fnSlice.indexOf("const expectedPrefix"),
  "buildTrimmedContext after expectedPrefix breaks landed() verification");
check("team.active skips MemoryWall prefix mutation on inbox messages",
  /!team\.active/.test(fnSlice.slice(0, fnSlice.indexOf("const expectedPrefix"))));

console.log("\n" + pass + " passed, " + failed + " failed");
if (failed) process.exit(1);
