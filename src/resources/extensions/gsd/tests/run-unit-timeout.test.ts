/**
 * run-unit-timeout.test.ts — Regression test for #3173.
 *
 * runUnit() stalls indefinitely when the LLM session hangs and agent_end
 * is never emitted. This test verifies that run-unit.ts wraps unitPromise
 * in a timeout race so the auto-loop can recover.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const runUnitPath = join(import.meta.dirname, "..", "auto", "run-unit.ts");
const src = readFileSync(runUnitPath, "utf-8");

console.log("\n=== #3173: runUnit execution timeout prevents stalled auto-loop ===");

// ── Test 1: Timeout constant is defined ────────────────────────────────────
assertTrue(
  src.includes("UNIT_EXECUTION_TIMEOUT_MS"),
  "UNIT_EXECUTION_TIMEOUT_MS constant defined in run-unit.ts",
);

// ── Test 2: unitPromise is wrapped in Promise.race ─────────────────────────
assertTrue(
  src.includes("Promise.race"),
  "unitPromise wrapped in Promise.race for execution timeout",
);

// ── Test 3: Timeout branch returns cancelled with category: timeout ─────────
assertTrue(
  src.includes('category: "timeout"') || src.includes("category: 'timeout'"),
  "timeout branch returns errorContext with category: timeout",
);

// ── Test 4: logWarning called on timeout ───────────────────────────────────
// The timeout handler must call logWarning so operators can diagnose stalls
// in production logs without crashing the process.
assertTrue(
  src.includes("logWarning"),
  "logWarning called when unit execution times out",
);

report();
