// SPDX-License-Identifier: GPL-3.0-or-later
// tools/fixtures/trapped-declaration.js — INTENTIONAL FAILURE FIXTURE (v4.6.0, must be flagged by verify.js [4b]).
// This reproduces the exact 4.2.0 defect: agentLoop reads `currentExec`, whose
// only declaration lives inside a different closure further down the file.
(() => {
  "use strict";
  function agentLoop() {
    if (currentExec === "single") return "single"; // ← trapped: declared below, elsewhere
    return "other";
  }
  const ui = (() => {
    let currentExec = "single";
    return { get exec() { return currentExec; }, agentLoop };
  })();
  module.exports = ui;
})();
