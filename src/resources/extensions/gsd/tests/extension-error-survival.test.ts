// Regression test for #3163: _gsdEpipeGuard re-threw unrecognised errors,
// killing the GSD session whenever an extension raised a runtime error.
import test from "node:test";
import assert from "node:assert/strict";

import { handleUncaughtExtensionError, handleRecoverableExtensionProcessError } from "../bootstrap/register-extension.ts";

// ---------------------------------------------------------------------------
// Test 1: unrecognised error must NOT throw — process should survive
// ---------------------------------------------------------------------------
test("_gsdEpipeGuard logs unrecognised error to stderr and does not throw (#3163)", () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const err = new TypeError("Cannot read properties of undefined");
    // Must not throw — previously `throw err` propagated here
    assert.doesNotThrow(() => handleUncaughtExtensionError(err));
  } finally {
    process.stderr.write = originalWrite;
  }
});

// ---------------------------------------------------------------------------
// Test 2: stderr output for unrecognised error contains [gsd] uncaught: tag
// ---------------------------------------------------------------------------
test("_gsdEpipeGuard writes [gsd] uncaught: tag to stderr for unrecognised errors (#3163)", () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const err = new TypeError("Cannot read properties of undefined");
    handleUncaughtExtensionError(err);
    assert.match(stderr, /\[gsd\] uncaught:/);
    assert.match(stderr, /Cannot read properties of undefined/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

// ---------------------------------------------------------------------------
// Test 3: handleRecoverableExtensionProcessError returns false for unrecognised error
// (confirms the fallback path is reached in handleUncaughtExtensionError)
// ---------------------------------------------------------------------------
test("handleRecoverableExtensionProcessError returns false for unrecognised TypeError (#3163)", () => {
  const err = new TypeError("Cannot read properties of undefined");
  const handled = handleRecoverableExtensionProcessError(err);
  assert.equal(handled, false);
});
