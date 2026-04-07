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

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  withTimeout,
  FINALIZE_POST_TIMEOUT_MS,
} from "../auto/finalize-timeout.ts";

describe("#2344: withTimeout utility", () => {
  test("passes through when promise resolves promptly", async () => {
    const result = await withTimeout(
      Promise.resolve("ok"),
      1000,
      "test-timeout",
    );
    assert.deepStrictEqual(result.value, "ok");
    assert.deepStrictEqual(result.timedOut, false);
  });

  test("returns fallback on hang", async () => {
    const startTime = Date.now();
    const result = await withTimeout(
      new Promise<string>(() => { /* Never resolves */ }),
      100,
      "test-timeout",
    );
    const elapsed = Date.now() - startTime;

    assert.deepStrictEqual(result.timedOut, true);
    assert.deepStrictEqual(result.value, undefined);
    assert.ok(elapsed >= 90, `should wait at least 90ms (took ${elapsed}ms)`);
    assert.ok(elapsed < 500, `should not wait too long (took ${elapsed}ms)`);
  });

  test("propagates rejection", async () => {
    await assert.rejects(
      () => withTimeout(
        Promise.reject(new Error("boom")),
        1000,
        "test-timeout",
      ),
      { message: "boom" },
    );
  });

  test("FINALIZE_POST_TIMEOUT_MS is defined and reasonable", () => {
    assert.ok(typeof FINALIZE_POST_TIMEOUT_MS === "number");
    assert.ok(FINALIZE_POST_TIMEOUT_MS >= 30_000, `timeout should be >= 30s (got ${FINALIZE_POST_TIMEOUT_MS}ms)`);
    assert.ok(FINALIZE_POST_TIMEOUT_MS <= 120_000, `timeout should be <= 120s (got ${FINALIZE_POST_TIMEOUT_MS}ms)`);
  });

  test("cleans up timer on success", async () => {
    const result = await withTimeout(
      new Promise<string>((r) => setTimeout(() => r("delayed"), 50)),
      5000,
      "cleanup-test",
    );
    assert.deepStrictEqual(result.value, "delayed");
    assert.deepStrictEqual(result.timedOut, false);
  });
});
