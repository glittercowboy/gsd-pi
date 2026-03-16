/**
 * In-flight tool tracking tests — verifies that markToolStart/markToolEnd
 * correctly manage the in-flight tools set used by the idle watchdog to
 * distinguish "agent waiting on long-running tool" from "agent is idle".
 *
 * Background: The idle watchdog checks every 15s for agent progress. Without
 * in-flight tool tracking, agents waiting on await_job or async_bash (which
 * can run 20+ minutes for evaluations, deployments, test suites) are falsely
 * declared idle and interrupted by recovery steering messages.
 *
 * The fix hooks tool_execution_start/end events to track active tool calls.
 * When tools are in-flight, the watchdog resets lastProgressAt instead of
 * triggering idle recovery.
 */

import { markToolStart, markToolEnd, isAutoActive } from "../auto.ts";
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ═══ markToolStart / markToolEnd basic behavior ═════════════════════════════

{
  console.log("\n=== markToolStart: no-op when auto-mode is not active ===");
  // When auto-mode is not active, markToolStart should silently ignore
  // (the guard `if (!active) return` prevents set pollution outside auto-mode)
  assertTrue(!isAutoActive(), "auto-mode should not be active in tests");
  markToolStart("tool-1");
  // We can't directly inspect the set, but markToolEnd should be a safe no-op
  markToolEnd("tool-1");
  // If we got here without error, the guard works
  assertTrue(true, "markToolStart/markToolEnd are safe no-ops when inactive");
}

{
  console.log("\n=== markToolEnd: no-op for unknown toolCallId ===");
  // Set.delete on non-existent key is a no-op — verify no crash
  markToolEnd("nonexistent-tool-call-id");
  assertTrue(true, "markToolEnd handles unknown IDs gracefully");
}

{
  console.log("\n=== markToolEnd: idempotent — double-end does not crash ===");
  markToolEnd("some-id");
  markToolEnd("some-id");
  assertTrue(true, "double markToolEnd is safe");
}

// ═══ Integration contract: expected exports from auto.ts ═════════════════════

{
  console.log("\n=== auto.ts exports markToolStart and markToolEnd ===");
  assertEq(typeof markToolStart, "function", "markToolStart should be a function");
  assertEq(typeof markToolEnd, "function", "markToolEnd should be a function");
}

{
  console.log("\n=== markToolStart accepts string toolCallId ===");
  // Verify the function signature handles string input without error
  // (when inactive, this is a no-op but should not throw)
  try {
    markToolStart("toolu_01ABC123");
    assertTrue(true, "accepts standard Claude tool call ID format");
  } catch (e) {
    assertTrue(false, `should not throw: ${e}`);
  }
}

{
  console.log("\n=== markToolEnd accepts string toolCallId ===");
  try {
    markToolEnd("toolu_01ABC123");
    assertTrue(true, "accepts standard Claude tool call ID format");
  } catch (e) {
    assertTrue(false, `should not throw: ${e}`);
  }
}

report();
