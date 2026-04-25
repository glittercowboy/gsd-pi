/**
 * false-degraded-mode-warning.test.ts — Regression tests for #3922.
 *
 * Before this fix, deriveState() logged a "DB unavailable — degraded mode"
 * warning even when the DB simply hadn't been opened yet (e.g. during
 * before_agent_start context injection). The fix introduces wasDbOpenAttempted()
 * to distinguish "not yet initialized" from "genuinely unavailable."
 *
 * Two aspects:
 * 1. gsd-db: wasDbOpenAttempted() tracks whether openDatabase() was ever called.
 * 2. state: the degraded-mode warning is gated behind wasDbOpenAttempted().
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  wasDbOpenAttempted,
} from "../gsd-db.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateSource = readFileSync(join(__dirname, "..", "state.ts"), "utf-8");

// ═══════════════════════════════════════════════════════════════════════════
// 1. gsd-db: wasDbOpenAttempted flag
// ═══════════════════════════════════════════════════════════════════════════

describe("wasDbOpenAttempted (#3922)", () => {

  test("wasDbOpenAttempted returns true after openDatabase is called", () => {
    // By this point in the test suite, openDatabase may or may not have been
    // called by other tests. So we call it explicitly and verify it returns true.
    openDatabase(":memory:");
    assert.strictEqual(wasDbOpenAttempted(), true,
      "wasDbOpenAttempted should be true after openDatabase call");
    closeDatabase();
  });

  test("openDatabase sets the flag even if it fails on invalid path", () => {
    // openDatabase with an unreachable path may fail, but the flag should
    // still be set because the attempt was made.
    try { openDatabase("/nonexistent/path/that/will/fail.db"); } catch { /* expected */ }
    assert.strictEqual(wasDbOpenAttempted(), true,
      "wasDbOpenAttempted should be true even after a failed open attempt");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. state.ts: degraded-mode warning is gated behind wasDbOpenAttempted
// ═══════════════════════════════════════════════════════════════════════════

describe("degraded-mode warning guard (#3922)", () => {

  test("state.ts imports wasDbOpenAttempted from gsd-db", () => {
    assert.ok(
      stateSource.includes("wasDbOpenAttempted"),
      "state.ts must import wasDbOpenAttempted to gate the degraded-mode warning",
    );
  });

  test("degraded-mode warning is inside a wasDbOpenAttempted() guard", () => {
    // Find the degraded-mode warning string
    const warningStr = 'DB unavailable — using filesystem state derivation (degraded mode)';
    const warningIdx = stateSource.indexOf(warningStr);
    assert.ok(warningIdx > 0, "degraded-mode warning string must exist in state.ts");

    // The wasDbOpenAttempted() check must appear BEFORE the warning,
    // within the same else-branch (i.e. within a reasonable distance).
    // Look backwards from the warning for the guard.
    const searchWindow = stateSource.slice(Math.max(0, warningIdx - 300), warningIdx);
    assert.ok(
      searchWindow.includes("wasDbOpenAttempted()"),
      "wasDbOpenAttempted() guard must appear shortly before the degraded-mode warning " +
      "to prevent false warnings when DB has not been initialized yet",
    );
  });

  test("warning is NOT emitted unconditionally in the else branch", () => {
    // The old code had `logWarning(...)` directly in the else branch.
    // The fix wraps it in `if (wasDbOpenAttempted())`.
    // Verify the logWarning call is inside a conditional, not bare.
    const lines = stateSource.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes("DB unavailable") && lines[i]!.includes("degraded mode")) {
        // This line has the warning. Check that the preceding non-empty line
        // contains an if-condition (wasDbOpenAttempted), not a bare else.
        let prev = i - 1;
        while (prev >= 0 && lines[prev]!.trim() === "") prev--;
        const prevLine = lines[prev]!.trim();
        assert.ok(
          prevLine.includes("wasDbOpenAttempted"),
          `Line ${i + 1} emits degraded-mode warning — preceding line ${prev + 1} must ` +
          `contain wasDbOpenAttempted guard, but found: "${prevLine}"`,
        );
        break;
      }
    }
  });
});
