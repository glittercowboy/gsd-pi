// GSD State Machine — Wave 3 Session Regression Tests
// Validates tri-state hasImplementationArtifacts and AutoSession.consecutiveCompleteBootstraps.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { hasImplementationArtifacts } from "../auto-recovery.js";
import { AutoSession } from "../auto/session.js";

// ── Fix 9: hasImplementationArtifacts returns tri-state ──

describe("hasImplementationArtifacts tri-state return", () => {
  test("returns 'unknown' for non-git directory", () => {
    const result = hasImplementationArtifacts("/tmp/not-a-git-repo-" + Date.now());
    assert.strictEqual(result, "unknown");
  });

  test("return type is one of present/absent/unknown", () => {
    const result = hasImplementationArtifacts(process.cwd());
    assert.ok(
      result === "present" || result === "absent" || result === "unknown",
      `Expected present/absent/unknown, got: ${result}`,
    );
  });
});

// ── Fix 11: consecutiveCompleteBootstraps is per-session ──

describe("AutoSession.consecutiveCompleteBootstraps", () => {
  test("initial value is 0", () => {
    const s = new AutoSession();
    assert.strictEqual(s.consecutiveCompleteBootstraps, 0);
  });

  test("reset() clears the counter", () => {
    const s = new AutoSession();
    s.consecutiveCompleteBootstraps = 5;
    s.reset();
    assert.strictEqual(s.consecutiveCompleteBootstraps, 0);
  });

  test("two sessions have independent counters", () => {
    const s1 = new AutoSession();
    const s2 = new AutoSession();
    s1.consecutiveCompleteBootstraps = 3;
    assert.strictEqual(s2.consecutiveCompleteBootstraps, 0);
  });
});
