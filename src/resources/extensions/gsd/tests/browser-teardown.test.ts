/**
 * browser-teardown.test.ts — Verifies browser cleanup at unit boundaries (#1733).
 *
 * Tests that the browser-tools lifecycle module is correctly called to tear
 * down Chrome/Playwright processes during stopAuto() and between units.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Direct imports of browser-tools state to verify teardown behavior
import {
  getBrowser,
  setBrowser,
  getContext,
  setContext,
  resetAllState,
} from "../../browser-tools/state.ts";
import { closeBrowser } from "../../browser-tools/lifecycle.ts";

// ─── closeBrowser clears state ──────────────────────────────────────────────

test("closeBrowser resets browser state even when no browser is running", async () => {
  // Ensure clean state
  resetAllState();
  assert.equal(getBrowser(), null, "browser should be null initially");
  assert.equal(getContext(), null, "context should be null initially");

  // closeBrowser should be safe to call with no active browser
  await closeBrowser();

  assert.equal(getBrowser(), null, "browser should remain null after closeBrowser");
  assert.equal(getContext(), null, "context should remain null after closeBrowser");
});

test("closeBrowser calls browser.close() and resets all state", async () => {
  resetAllState();

  let closeCalled = false;
  const fakeBrowser = {
    close: async () => { closeCalled = true; },
  } as any;

  setBrowser(fakeBrowser);
  setContext({ /* fake context */ } as any);

  assert.ok(getBrowser(), "browser should be set before teardown");
  assert.ok(getContext(), "context should be set before teardown");

  await closeBrowser();

  assert.equal(closeCalled, true, "browser.close() should have been called");
  assert.equal(getBrowser(), null, "browser should be null after teardown");
  assert.equal(getContext(), null, "context should be null after teardown");
});

// ─── getBrowser guard pattern ───────────────────────────────────────────────

test("getBrowser() guard prevents unnecessary closeBrowser calls", async () => {
  resetAllState();

  // This is the pattern used in stopAuto and postUnitPreVerification:
  //   if (getBrowser()) { await closeBrowser(); }
  // Verify the guard works correctly when no browser is active.

  let teardownAttempted = false;
  if (getBrowser()) {
    await closeBrowser();
    teardownAttempted = true;
  }

  assert.equal(teardownAttempted, false, "should not attempt teardown when no browser is active");
});

test("getBrowser() guard triggers closeBrowser when browser is active", async () => {
  resetAllState();

  let closeCalled = false;
  setBrowser({
    close: async () => { closeCalled = true; },
  } as any);

  let teardownAttempted = false;
  if (getBrowser()) {
    await closeBrowser();
    teardownAttempted = true;
  }

  assert.equal(teardownAttempted, true, "should attempt teardown when browser is active");
  assert.equal(closeCalled, true, "browser.close() should have been called");
  assert.equal(getBrowser(), null, "browser should be null after guarded teardown");
});

// ─── Source code verification ───────────────────────────────────────────────

test("stopAuto finally block includes browser teardown", async () => {
  // Verify the source code contains the browser teardown call
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const autoSource = readFileSync(resolve(import.meta.dirname, "..", "auto.ts"), "utf-8");

  assert.ok(
    autoSource.includes("closeBrowser"),
    "auto.ts should reference closeBrowser for teardown in stopAuto",
  );
  assert.ok(
    autoSource.includes("getBrowser"),
    "auto.ts should check getBrowser() before calling closeBrowser",
  );
  assert.ok(
    autoSource.includes("browser-tools/lifecycle"),
    "auto.ts should import from browser-tools/lifecycle",
  );
});

test("postUnitPreVerification includes browser teardown between units", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const postUnitSource = readFileSync(resolve(import.meta.dirname, "..", "auto-post-unit.ts"), "utf-8");

  assert.ok(
    postUnitSource.includes("closeBrowser"),
    "auto-post-unit.ts should reference closeBrowser for inter-unit teardown",
  );
  assert.ok(
    postUnitSource.includes("getBrowser"),
    "auto-post-unit.ts should check getBrowser() before calling closeBrowser",
  );
  assert.ok(
    postUnitSource.includes("browser-teardown"),
    "auto-post-unit.ts should have browser-teardown debug phase",
  );
});
