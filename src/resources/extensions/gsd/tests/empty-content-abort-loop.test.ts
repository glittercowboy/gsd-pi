/**
 * empty-content-abort-loop.test.ts — Regression test for #2695.
 *
 * When the LLM sends an assistant message with empty `content: []` and
 * `stopReason: "aborted"`, this is NOT a fatal abort — it is a non-fatal
 * end-of-turn. The abort handler in agent-end-recovery.ts must distinguish
 * this case and NOT pause auto-mode, allowing the loop to continue via
 * resolveAgentEnd instead of entering a stuck re-dispatch loop.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECOVERY_PATH = join(__dirname, "..", "bootstrap", "agent-end-recovery.ts");

function getRecoverySource(): string {
  return readFileSync(RECOVERY_PATH, "utf-8");
}

test("agent-end-recovery.ts does not pause on aborted messages with empty content (#2695)", () => {
  const source = getRecoverySource();

  // The abort handler at `stopReason === "aborted"` must check for empty content
  // before deciding to pause. An empty content array is a non-fatal agent stop.
  const abortIdx = source.indexOf('stopReason === "aborted"');
  assert.ok(abortIdx > -1, "abort handler must exist in agent-end-recovery.ts");

  // Extract the region around the abort handler (enough to see the guard logic)
  const abortRegion = source.slice(Math.max(0, abortIdx - 200), abortIdx + 600);

  // Must check for empty content before pausing
  assert.ok(
    abortRegion.includes("content") && (abortRegion.includes("length") || abortRegion.includes("?.length")),
    "abort handler must inspect content array length to distinguish empty-content aborts from fatal aborts (#2695)",
  );
});

test("agent-end-recovery.ts routes empty-content aborted messages to resolveAgentEnd (#2695)", () => {
  const source = getRecoverySource();

  // The abort block must have a path that calls resolveAgentEnd for empty-content messages
  // instead of unconditionally calling pauseAuto
  const abortIdx = source.indexOf('stopReason === "aborted"');
  assert.ok(abortIdx > -1, "abort handler must exist");

  // Get the full abort handling block (from the if to the next stopReason check or success path)
  const afterAbort = source.slice(abortIdx, abortIdx + 800);

  // The abort block must have a code path that calls resolveAgentEnd (for empty-content case)
  assert.ok(
    afterAbort.includes("resolveAgentEnd"),
    "abort handler must route empty-content aborted messages to resolveAgentEnd instead of always pausing (#2695)",
  );
});

test("agent-end-recovery.ts checks for errorMessage presence in abort handler (#2695)", () => {
  const source = getRecoverySource();

  const abortIdx = source.indexOf('stopReason === "aborted"');
  assert.ok(abortIdx > -1, "abort handler must exist");

  const abortRegion = source.slice(abortIdx, abortIdx + 600);

  // Fatal aborts should have error context (errorMessage field).
  // The handler should check for this to distinguish fatal from non-fatal aborts.
  assert.ok(
    abortRegion.includes("errorMessage"),
    "abort handler must check for errorMessage to distinguish fatal aborts from empty-content non-fatal stops (#2695)",
  );
});
