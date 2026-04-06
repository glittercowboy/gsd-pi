/**
 * Regression test for #2344: Auto-loop hangs after plan-slice completes
 * because postUnitPostVerification() never resolves.
 *
 * When postUnitPostVerification() hangs (e.g., due to a module import
 * deadlock or SQLite transaction hang), the auto-loop blocks forever
 * with no error message, no notification, and no recovery.
 *
 * The fix adds a timeout guard around postUnitPostVerification() in
 * runFinalize(). If it doesn't resolve within the timeout, the function
 * force-returns "continue" and logs an error, allowing the loop to
 * proceed to the next iteration.
 *
 * This test verifies the timeout utility used by the fix, since the
 * full runFinalize function has too many transitive dependencies for
 * isolated unit testing.
 */

import { createTestContext } from "./test-helpers.ts";
import {
  withTimeout,
  FINALIZE_POST_TIMEOUT_MS,
} from "../auto/finalize-timeout.ts";

const { assertTrue, assertEq, report } = createTestContext();

// ═══ Test: withTimeout resolves when inner promise resolves promptly ══════════

{
  console.log("\n=== #2344: withTimeout passes through when promise resolves ===");

  const result = await withTimeout(
    Promise.resolve("ok"),
    1000,
    "test-timeout",
  );
  assertEq(result.value, "ok", "should return inner value");
  assertEq(result.timedOut, false, "should not be timed out");
}

// ═══ Test: withTimeout returns fallback when inner promise hangs ══════════════

{
  console.log("\n=== #2344: withTimeout returns fallback on hang ===");

  const startTime = Date.now();
  const result = await withTimeout(
    new Promise<string>(() => {
      // Never resolves
    }),
    100, // short timeout for testing
    "test-timeout",
  );
  const elapsed = Date.now() - startTime;

  assertEq(result.timedOut, true, "should report timeout");
  assertEq(result.value, undefined, "value should be undefined on timeout");
  assertTrue(elapsed >= 90, `should wait at least 90ms (took ${elapsed}ms)`);
  assertTrue(elapsed < 500, `should not wait too long (took ${elapsed}ms)`);
}

// ═══ Test: withTimeout handles rejection gracefully ═══════════════════════════

{
  console.log("\n=== #2344: withTimeout propagates rejection ===");

  let caught = false;
  try {
    await withTimeout(
      Promise.reject(new Error("boom")),
      1000,
      "test-timeout",
    );
  } catch (err: any) {
    caught = true;
    assertEq(err.message, "boom", "should propagate the error");
  }
  assertTrue(caught, "rejection should propagate");
}

// ═══ Test: FINALIZE_POST_TIMEOUT_MS is defined and reasonable ═════════════════

{
  console.log("\n=== #2344: timeout constant is defined and reasonable ===");

  assertTrue(
    typeof FINALIZE_POST_TIMEOUT_MS === "number",
    "FINALIZE_POST_TIMEOUT_MS should be a number",
  );
  assertTrue(
    FINALIZE_POST_TIMEOUT_MS >= 30_000,
    `timeout should be >= 30s (got ${FINALIZE_POST_TIMEOUT_MS}ms)`,
  );
  assertTrue(
    FINALIZE_POST_TIMEOUT_MS <= 120_000,
    `timeout should be <= 120s (got ${FINALIZE_POST_TIMEOUT_MS}ms)`,
  );
}

// ═══ Test: withTimeout cleans up timer on success ════════════════════════════

{
  console.log("\n=== #2344: withTimeout cleans up timer on success ===");

  // If the timer isn't cleaned up, this test would keep the process alive.
  // Relying on process.exit behavior — if test completes, timers were cleaned.
  const result = await withTimeout(
    new Promise<string>((r) => setTimeout(() => r("delayed"), 50)),
    5000,
    "cleanup-test",
  );
  assertEq(result.value, "delayed", "should resolve with delayed value");
  assertEq(result.timedOut, false, "should not time out");
}

report();
