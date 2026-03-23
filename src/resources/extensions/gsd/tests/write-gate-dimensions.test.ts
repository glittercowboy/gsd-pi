/**
 * Unit tests for multi-dimension depth verification in the CONTEXT.md write gate.
 *
 * Verifies the three-dimension model (what, risks, dependencies) introduced
 * alongside the legacy boolean fast-path. Covers:
 *   - Individual dimension marking
 *   - All-three-verified promotes to boolean
 *   - Partial verification blocks with specific reason
 *   - Bare markDepthVerified() backward compat marks all dimensions
 *   - Reset clears dimension state
 *   - Mixed dimension + legacy flow
 *   - Queue mode with dimensions
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldBlockContextWrite,
  isDepthVerified,
  isQueuePhaseActive,
  setQueuePhaseActive,
  markDimensionVerified,
  isDimensionVerified,
  areAllDimensionsVerified,
  REQUIRED_DIMENSIONS,
} from '../index.ts';
import {
  markDepthVerified,
  clearDiscussionFlowState,
  resetWriteGateState,
} from '../bootstrap/write-gate.ts';

// Helper: standard CONTEXT.md path for testing
const CTX_PATH = '.gsd/milestones/M001/M001-CONTEXT.md';

// ─── Scenario 1: Individual dimension marking ──

test('dimensions: marking one dimension sets only that dimension', () => {
  clearDiscussionFlowState();
  markDimensionVerified('what');
  assert.strictEqual(isDimensionVerified('what'), true, "'what' should be verified");
  assert.strictEqual(isDimensionVerified('risks'), false, "'risks' should still be false");
  assert.strictEqual(isDimensionVerified('dependencies'), false, "'dependencies' should still be false");
  assert.strictEqual(areAllDimensionsVerified(), false, 'not all dimensions verified');
  assert.strictEqual(isDepthVerified(), false, 'boolean should not be set from one dimension');
  clearDiscussionFlowState();
});

// ─── Scenario 2: All three verified promotes to boolean ──

test('dimensions: marking all three dimensions sets the legacy boolean', () => {
  clearDiscussionFlowState();
  markDimensionVerified('what');
  markDimensionVerified('risks');
  markDimensionVerified('dependencies');
  assert.strictEqual(areAllDimensionsVerified(), true, 'all dimensions verified');
  assert.strictEqual(isDepthVerified(), true, 'boolean should be set after all dimensions');
  clearDiscussionFlowState();
});

// ─── Scenario 3: Partial verification blocks with specific reason ──

test('dimensions: partial verification blocks CONTEXT.md write with unverified dimension in reason', () => {
  clearDiscussionFlowState();
  markDimensionVerified('what');
  markDimensionVerified('risks');
  // 'dependencies' still unverified

  const result = shouldBlockContextWrite(
    'write',
    CTX_PATH,
    'M001',
    isDepthVerified(),
  );
  assert.strictEqual(result.block, true, 'should block with partial dimensions');
  assert.ok(result.reason, 'should provide a reason');
  assert.ok(result.reason!.includes('dependencies'), 'reason should mention unverified dimension');
  clearDiscussionFlowState();
});

// ─── Scenario 4: Bare markDepthVerified() backward compat marks all dimensions ──

test('dimensions: markDepthVerified() marks all dimensions and the boolean', () => {
  clearDiscussionFlowState();
  markDepthVerified();
  assert.strictEqual(isDepthVerified(), true, 'boolean should be set');
  for (const dim of REQUIRED_DIMENSIONS) {
    assert.strictEqual(isDimensionVerified(dim), true, `dimension '${dim}' should be verified`);
  }
  assert.strictEqual(areAllDimensionsVerified(), true, 'all dimensions should be verified');
  clearDiscussionFlowState();
});

// ─── Scenario 5: Reset clears dimension state ──

test('dimensions: resetWriteGateState clears all dimensions', () => {
  clearDiscussionFlowState();
  markDimensionVerified('what');
  markDimensionVerified('risks');
  markDimensionVerified('dependencies');
  assert.strictEqual(areAllDimensionsVerified(), true, 'pre-condition: all verified');

  resetWriteGateState();
  assert.strictEqual(isDepthVerified(), false, 'boolean should be cleared');
  for (const dim of REQUIRED_DIMENSIONS) {
    assert.strictEqual(isDimensionVerified(dim), false, `dimension '${dim}' should be cleared`);
  }
  assert.strictEqual(areAllDimensionsVerified(), false, 'no dimensions verified after reset');
  clearDiscussionFlowState();
});

// ─── Scenario 6: clearDiscussionFlowState clears dimensions ──

test('dimensions: clearDiscussionFlowState clears all dimensions', () => {
  markDimensionVerified('what');
  markDimensionVerified('risks');
  clearDiscussionFlowState();
  for (const dim of REQUIRED_DIMENSIONS) {
    assert.strictEqual(isDimensionVerified(dim), false, `dimension '${dim}' should be cleared`);
  }
});

// ─── Scenario 7: Mixed flow — dimension then legacy ──

test('dimensions: marking one dimension then calling markDepthVerified completes all', () => {
  clearDiscussionFlowState();
  markDimensionVerified('what');
  assert.strictEqual(isDimensionVerified('risks'), false);

  markDepthVerified();
  assert.strictEqual(isDepthVerified(), true, 'boolean should be set');
  assert.strictEqual(areAllDimensionsVerified(), true, 'all dimensions verified');
  for (const dim of REQUIRED_DIMENSIONS) {
    assert.strictEqual(isDimensionVerified(dim), true, `dimension '${dim}' should be verified`);
  }
  clearDiscussionFlowState();
});

// ─── Scenario 8: Queue mode with partial dimensions blocks ──

test('dimensions: partial dimensions in queue mode still block', () => {
  clearDiscussionFlowState();
  setQueuePhaseActive(true);
  markDimensionVerified('what');

  const result = shouldBlockContextWrite(
    'write',
    CTX_PATH,
    null,
    isDepthVerified(),
    isQueuePhaseActive(),
  );
  assert.strictEqual(result.block, true, 'should block in queue mode with partial dimensions');
  assert.ok(result.reason!.includes('risks'), 'reason should mention unverified risks');
  assert.ok(result.reason!.includes('dependencies'), 'reason should mention unverified dependencies');
  clearDiscussionFlowState();
});

// ─── Scenario 9: Queue mode with all dimensions allows write ──

test('dimensions: all dimensions verified in queue mode allows write', () => {
  clearDiscussionFlowState();
  setQueuePhaseActive(true);
  markDimensionVerified('what');
  markDimensionVerified('risks');
  markDimensionVerified('dependencies');

  const result = shouldBlockContextWrite(
    'write',
    CTX_PATH,
    null,
    isDepthVerified(),
    isQueuePhaseActive(),
  );
  assert.strictEqual(result.block, false, 'should allow in queue mode after all dimensions');
  clearDiscussionFlowState();
});

// ─── Scenario 10: REQUIRED_DIMENSIONS constant is correct ──

test('dimensions: REQUIRED_DIMENSIONS contains exactly what/risks/dependencies', () => {
  assert.deepStrictEqual([...REQUIRED_DIMENSIONS], ['what', 'risks', 'dependencies']);
});

// ─── Scenario 11: Unknown dimension does not affect required check ──

test('dimensions: marking unknown dimension does not satisfy areAllDimensionsVerified', () => {
  clearDiscussionFlowState();
  markDimensionVerified('unknown_dim');
  assert.strictEqual(isDimensionVerified('unknown_dim'), true, 'custom dimension stored');
  assert.strictEqual(areAllDimensionsVerified(), false, 'required dimensions still unmet');
  clearDiscussionFlowState();
});

// ─── Scenario 12: Full flow — dimension-by-dimension then verify write ──

test('dimensions: full dimension-by-dimension flow unblocks write', () => {
  clearDiscussionFlowState();

  // Initially blocked
  let result = shouldBlockContextWrite('write', CTX_PATH, 'M001', isDepthVerified());
  assert.strictEqual(result.block, true, 'should block before any verification');

  // Mark what
  markDimensionVerified('what');
  result = shouldBlockContextWrite('write', CTX_PATH, 'M001', isDepthVerified());
  assert.strictEqual(result.block, true, 'should block after one dimension');

  // Mark risks
  markDimensionVerified('risks');
  result = shouldBlockContextWrite('write', CTX_PATH, 'M001', isDepthVerified());
  assert.strictEqual(result.block, true, 'should block after two dimensions');

  // Mark dependencies — all three done, boolean auto-set
  markDimensionVerified('dependencies');
  result = shouldBlockContextWrite('write', CTX_PATH, 'M001', isDepthVerified());
  assert.strictEqual(result.block, false, 'should allow after all three dimensions');

  clearDiscussionFlowState();
});
