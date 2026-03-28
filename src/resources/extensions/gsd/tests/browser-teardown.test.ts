/**
 * browser-teardown.test.ts — Verifies browser cleanup at unit boundaries (#1733).
 *
 * Tests that the browser-tools lifecycle module is correctly called to tear
 * down Chrome/Playwright processes during stopAuto() and between units.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
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

describe("browser teardown", () => {
  beforeEach(() => {
    resetAllState();
  });

  afterEach(() => {
    resetAllState();
  });

  // ─── closeBrowser clears state ──────────────────────────────────────────────

  it("closeBrowser resets browser state even when no browser is running", async () => {
    assert.equal(getBrowser(), null, "browser should be null initially");
    assert.equal(getContext(), null, "context should be null initially");

    // closeBrowser should be safe to call with no active browser
    await closeBrowser();

    assert.equal(getBrowser(), null, "browser should remain null after closeBrowser");
    assert.equal(getContext(), null, "context should remain null after closeBrowser");
  });

  it("closeBrowser calls browser.close() and resets all state", async () => {
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

  it("getBrowser() guard prevents unnecessary closeBrowser calls", async () => {
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

  it("getBrowser() guard triggers closeBrowser when browser is active", async () => {
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
});
