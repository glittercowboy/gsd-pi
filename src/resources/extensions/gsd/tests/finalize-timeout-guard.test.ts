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
  FINALIZE_PRE_TIMEOUT_MS,
  FINALIZE_POST_TIMEOUT_MS,
} from "../auto/finalize-timeout.ts";
import { MAX_FINALIZE_TIMEOUTS } from "../auto/types.ts";

const { assertTrue, assertEq, report } = createTestContext();

function getRunFinalizeBody(phasesSource: string): string {
  const fnIdx = phasesSource.indexOf("export async function runFinalize(");
  assertTrue(fnIdx > 0, "runFinalize function should exist in phases.ts");

  const nextExportIdx = phasesSource.indexOf("\nexport ", fnIdx + 1);
  return phasesSource.slice(fnIdx, nextExportIdx > fnIdx ? nextExportIdx : undefined);
}

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

// ═══ Test: FINALIZE_PRE_TIMEOUT_MS is defined and reasonable ═════════════════

{
  console.log("\n=== #3757: pre-verification timeout constant is defined and reasonable ===");

  assertTrue(
    typeof FINALIZE_PRE_TIMEOUT_MS === "number",
    "FINALIZE_PRE_TIMEOUT_MS should be a number",
  );
  assertTrue(
    FINALIZE_PRE_TIMEOUT_MS >= 30_000,
    `pre timeout should be >= 30s (got ${FINALIZE_PRE_TIMEOUT_MS}ms)`,
  );
  assertTrue(
    FINALIZE_PRE_TIMEOUT_MS <= 120_000,
    `pre timeout should be <= 120s (got ${FINALIZE_PRE_TIMEOUT_MS}ms)`,
  );
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

// ═══ Test: runFinalize wraps BOTH pre and post verification with withTimeout ═

{
  console.log("\n=== #3757: runFinalize wraps preVerification with timeout guard ===");

  const { readFileSync } = await import("node:fs");
  const phasesSource = readFileSync(
    new URL("../auto/phases.ts", import.meta.url),
    "utf-8",
  );

  const fnBody = getRunFinalizeBody(phasesSource);

  // postUnitPreVerification must be wrapped in withTimeout
  const preTimeoutIdx = fnBody.indexOf("withTimeout(");
  assertTrue(preTimeoutIdx > 0, "withTimeout should appear in runFinalize");

  const preVerIdx = fnBody.indexOf("postUnitPreVerification");
  assertTrue(preVerIdx > 0, "postUnitPreVerification should appear in runFinalize");

  // The first withTimeout should wrap postUnitPreVerification (not postUnitPostVerification)
  const firstWithTimeout = fnBody.slice(preTimeoutIdx, preTimeoutIdx + 200);
  assertTrue(
    firstWithTimeout.includes("postUnitPreVerification"),
    "first withTimeout in runFinalize should wrap postUnitPreVerification",
  );

  // postUnitPostVerification must also be wrapped
  const postVerIdx = fnBody.indexOf("postUnitPostVerification");
  assertTrue(postVerIdx > 0, "postUnitPostVerification should appear in runFinalize");

  // Count withTimeout occurrences — should be at least 2 (pre + post)
  const timeoutCount = (fnBody.match(/withTimeout\(/g) || []).length;
  assertTrue(
    timeoutCount >= 2,
    `runFinalize should have at least 2 withTimeout guards (found ${timeoutCount})`,
  );
}

// ═══ Test: MAX_FINALIZE_TIMEOUTS is defined and reasonable ═══════════════════

{
  console.log("\n=== #3757: MAX_FINALIZE_TIMEOUTS is defined and reasonable ===");

  assertTrue(
    typeof MAX_FINALIZE_TIMEOUTS === "number",
    "MAX_FINALIZE_TIMEOUTS should be a number",
  );
  assertTrue(
    MAX_FINALIZE_TIMEOUTS >= 2,
    `threshold should be >= 2 (got ${MAX_FINALIZE_TIMEOUTS})`,
  );
  assertTrue(
    MAX_FINALIZE_TIMEOUTS <= 10,
    `threshold should be <= 10 (got ${MAX_FINALIZE_TIMEOUTS})`,
  );
}

// ═══ Test: timeout handlers escalate after consecutive timeouts ══════════════

{
  console.log("\n=== #3757: timeout handlers escalate and detach currentUnit ===");

  const { readFileSync } = await import("node:fs");
  const phasesSource = readFileSync(
    new URL("../auto/phases.ts", import.meta.url),
    "utf-8",
  );

  const fnBody = getRunFinalizeBody(phasesSource);

  const helperCallCount = (fnBody.match(/failClosedOnFinalizeTimeout\(/g) || []).length;
  assertTrue(
    helperCallCount >= 2,
    `runFinalize should route both timeout branches through failClosedOnFinalizeTimeout (found ${helperCallCount})`,
  );

  const helperStart = phasesSource.indexOf("async function failClosedOnFinalizeTimeout");
  assertTrue(helperStart > 0, "failClosedOnFinalizeTimeout helper should exist");
  const helperEnd = phasesSource.indexOf("// ─── runPreDispatch", helperStart);
  const helperBody = phasesSource.slice(helperStart, helperEnd > helperStart ? helperEnd : undefined);

  const incrementCount = (helperBody.match(/consecutiveFinalizeTimeouts\+\+/g) || []).length;
  assertTrue(
    incrementCount >= 1,
    `timeout helper should increment consecutiveFinalizeTimeouts (found ${incrementCount})`,
  );

  const detachCount = (helperBody.match(/s\.currentUnit\s*=\s*null/g) || []).length;
  assertTrue(
    detachCount >= 1,
    `timeout helper should detach s.currentUnit (found ${detachCount})`,
  );

  const pauseCount = (helperBody.match(/pauseAuto\(/g) || []).length;
  assertTrue(
    pauseCount >= 1,
    `timeout helper should pause auto-mode (found ${pauseCount})`,
  );

  assertTrue(
    helperBody.includes('eventType: "unit-end"'),
    "timeout helper should emit a terminal unit-end event",
  );
  assertTrue(
    helperBody.includes('phase: "finalize-timeout"'),
    "timeout helper should persist finalize-timeout runtime state",
  );

  // Successful finalize should reset the counter
  assertTrue(
    fnBody.includes("consecutiveFinalizeTimeouts = 0"),
    "should reset consecutiveFinalizeTimeouts on successful finalize",
  );
}

report();
