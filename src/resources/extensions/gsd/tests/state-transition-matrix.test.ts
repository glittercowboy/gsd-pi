import test from "node:test";
import assert from "node:assert/strict";

import {
  STATE_TRANSITION_MATRIX,
  findTransition,
  validateTransitionMatrix,
} from "../state-transition-matrix.ts";

test("state transition matrix covers required swarm hardening events", () => {
  const result = validateTransitionMatrix([
    "context-ready",
    "research-ready",
    "plan-ready",
    "task-dispatched",
    "slice-complete",
    "validation-pass",
    "recovery-plan-ready",
    "closeout-complete",
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.missingEvents, []);
  assert.deepEqual(result.duplicateKeys, []);
});

test("state transition matrix fails closed for recovery and closeout guards", () => {
  const recovery = findTransition("blocked", "recovery-plan-ready");
  assert.equal(recovery?.to, "executing");
  assert.equal(recovery?.onFail, "blocked");
  assert.equal(recovery?.reasonCode, "recovery");

  const closeout = findTransition("completing-milestone", "closeout-complete");
  assert.equal(closeout?.to, "complete");
  assert.equal(closeout?.onFail, "blocked");
});

test("state transition matrix entries all have guard and reason codes", () => {
  assert.ok(STATE_TRANSITION_MATRIX.length >= 8);
  for (const entry of STATE_TRANSITION_MATRIX) {
    assert.ok(entry.guard.length > 0, `${entry.event} must document its guard`);
    assert.ok(entry.reasonCode.length > 0, `${entry.event} must include reason code`);
  }
});
