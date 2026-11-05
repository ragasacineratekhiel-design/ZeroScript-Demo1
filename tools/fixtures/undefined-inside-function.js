// SPDX-License-Identifier: GPL-3.0-or-later
// tools/fixtures/undefined-inside-function.js
// INTENTIONAL FAILURE FIXTURE — never loaded by the extension.
//
// The verifier's scope check missed this exact shape for the entire life of the
// project: a call to a name that is declared NOWHERE, placed INSIDE a function
// body. Two bugs hid it:
//   1. a dangling `else` made the AST walk skip every function body;
//   2. `if (!declaredAnywhere.has(name)) continue;` treated an unknown name as
//      "probably a host global", so typos were exempt by default.
// This fixture makes that shape permanent. If the checker goes blind again,
// tools/verify.js [4b] fails.
function outer() {
  function inner() {
    ghostVarInsideFunction();
  }
  return inner;
}
outer();
