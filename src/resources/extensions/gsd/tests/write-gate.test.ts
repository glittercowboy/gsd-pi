/**
 * Unit tests for the CONTEXT.md write-gate (D031 guard chain).
 *
 * Exercises shouldBlockContextWrite() — a pure function that implements:
 *   (a) toolName !== "write" → pass
 *   (b) milestone context must resolve to a verified milestone
 *   (c) path doesn't match /M\d+-CONTEXT\.md$/ → pass
 *   (d) non-context files → pass
 *   (e) else → block with actionable reason
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDepthConfirmationAnswer,
  shouldBlockContextWrite,
  setQueuePhaseActive,
} from '../index.ts';
import {
  markDepthVerified,
  isMilestoneDepthVerified,
  shouldBlockContextArtifactSave,
  clearDiscussionFlowState,
  resetWriteGateState,
} from '../bootstrap/write-gate.ts';

// ─── Scenario 1: Blocks CONTEXT.md write during discussion without depth verification (absolute path) ──

test('write-gate: blocks CONTEXT.md write during discussion without depth verification (absolute path)', () => {
  const result = shouldBlockContextWrite(
    'write',
    '/Users/dev/project/.gsd/milestones/M001/M001-CONTEXT.md',
    'M001',
    false,
  );
  assert.strictEqual(result.block, true, 'should block the write');
  assert.ok(result.reason, 'should provide a reason');
});

// ─── Scenario 2: Blocks CONTEXT.md write during discussion without depth verification (relative path) ──

test('write-gate: blocks CONTEXT.md write during discussion without depth verification (relative path)', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M005/M005-CONTEXT.md',
    'M005',
    false,
  );
  assert.strictEqual(result.block, true, 'should block the write');
  assert.ok(result.reason, 'should provide a reason');
});

// ─── Scenario 3: Allows CONTEXT.md write after depth verification ──

test('write-gate: allows CONTEXT.md write after depth verification', () => {
  clearDiscussionFlowState();
  markDepthVerified('M001');
  const result = shouldBlockContextWrite(
    'write',
    '/Users/dev/project/.gsd/milestones/M001/M001-CONTEXT.md',
    'M001',
  );
  assert.strictEqual(result.block, false, 'should not block after depth verification');
  assert.strictEqual(result.reason, undefined, 'should have no reason');
  clearDiscussionFlowState();
});

// ─── Scenario 4: Ambiguous session context no longer bypasses the gate ──

test('write-gate: blocks CONTEXT.md write when milestoneId is ambiguous', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-CONTEXT.md',
    null,
  );
  assert.strictEqual(result.block, true, 'should block when milestone context is ambiguous');
});

// ─── Scenario 5: Allows non-CONTEXT.md writes during discussion ──

test('write-gate: allows non-CONTEXT.md writes during discussion', () => {
  // DISCUSSION.md
  const r1 = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-DISCUSSION.md',
    'M001',
  );
  assert.strictEqual(r1.block, false, 'DISCUSSION.md should pass');

  // Slice file
  const r2 = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/slices/S01/S01-PLAN.md',
    'M001',
  );
  assert.strictEqual(r2.block, false, 'slice plan should pass');

  // Regular code file
  const r3 = shouldBlockContextWrite(
    'write',
    'src/index.ts',
    'M001',
  );
  assert.strictEqual(r3.block, false, 'regular code file should pass');
});

// ─── Scenario 6: Regex specificity — doesn't match S01-CONTEXT.md ──

test('write-gate: regex does not match slice context files (S01-CONTEXT.md)', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/slices/S01/S01-CONTEXT.md',
    'M001',
  );
  assert.strictEqual(result.block, false, 'S01-CONTEXT.md should not be blocked');
});

// ─── Scenario 7: Error message contains actionable instruction and anti-bypass language ──

test('write-gate: blocked reason contains depth_verification keyword and anti-bypass language', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M999/M999-CONTEXT.md',
    'M999',
  );
  assert.strictEqual(result.block, true);
  assert.ok(result.reason!.includes('depth_verification'), 'reason should mention depth_verification question id');
  assert.ok(result.reason!.includes('ask_user_questions'), 'reason should mention ask_user_questions tool');
  assert.ok(result.reason!.includes('MUST NOT'), 'reason should include anti-bypass language');
  assert.ok(result.reason!.includes('(Recommended)'), 'reason should specify the required confirmation option');
});

// ─── Scenario 8: Queue mode blocks CONTEXT.md write without depth verification ──

test('write-gate: blocks CONTEXT.md write in queue mode without depth verification', () => {
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-CONTEXT.md',
    null,   // no milestoneId in queue mode
    true,   // queue phase active
  );
  assert.strictEqual(result.block, true, 'should block in queue mode without depth verification');
  assert.ok(result.reason, 'should provide a reason');
});

// ─── Scenario 9: Queue mode allows CONTEXT.md write after depth verification ──

test('write-gate: allows CONTEXT.md write in queue mode after depth verification', () => {
  clearDiscussionFlowState();
  markDepthVerified('M001');
  const result = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-CONTEXT.md',
    null,   // no milestoneId in queue mode
    true,   // queue phase active
  );
  assert.strictEqual(result.block, false, 'should not block in queue mode after depth verification');
  clearDiscussionFlowState();
});

// ─── Scenario 10: depth verification is scoped per milestone, not global ──

test('write-gate: markDepthVerified unlocks only the matching milestone', () => {
  clearDiscussionFlowState();
  markDepthVerified('M001');

  const allowed = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M001/M001-CONTEXT.md',
    null,
  );
  assert.strictEqual(allowed.block, false, 'should allow the verified milestone');

  const blockedOther = shouldBlockContextWrite(
    'write',
    '.gsd/milestones/M002/M002-CONTEXT.md',
    null,
  );
  assert.strictEqual(blockedOther.block, true, 'other milestones should remain blocked');
  assert.strictEqual(isMilestoneDepthVerified('M001'), true);
  assert.strictEqual(isMilestoneDepthVerified('M002'), false);

  clearDiscussionFlowState();
});

// ─── Scenario 11: gsd_summary_save CONTEXT contract is milestone-scoped ──

test('write-gate: gsd_summary_save only blocks final milestone CONTEXT writes', () => {
  clearDiscussionFlowState();

  assert.strictEqual(
    shouldBlockContextArtifactSave('CONTEXT-DRAFT', 'M001').block,
    false,
    'draft CONTEXT should be allowed',
  );
  assert.strictEqual(
    shouldBlockContextArtifactSave('CONTEXT', 'M001', 'S01').block,
    false,
    'slice CONTEXT should be allowed',
  );
  assert.strictEqual(
    shouldBlockContextArtifactSave('CONTEXT', 'M001').block,
    true,
    'final milestone CONTEXT should block before verification',
  );

  markDepthVerified('M001');
  assert.strictEqual(
    shouldBlockContextArtifactSave('CONTEXT', 'M001').block,
    false,
    'final milestone CONTEXT should pass after verification',
  );

  clearDiscussionFlowState();
});

// ═══════════════════════════════════════════════════════════════════════
// Discussion gate enforcement tests (pending gate mechanism)
// ═══════════════════════════════════════════════════════════════════════

import {
  isGateQuestionId,
  shouldBlockPendingGate,
  shouldBlockPendingGateBash,
  setPendingGate,
  clearPendingGate,
  getPendingGate,
} from '../bootstrap/write-gate.ts';

// ─── Scenario 19: isGateQuestionId recognizes all gate patterns ──

test('write-gate: isGateQuestionId recognizes all gate patterns', () => {
  assert.strictEqual(isGateQuestionId('depth_verification'), true);
  assert.strictEqual(isGateQuestionId('depth_verification_M002'), true);
  assert.strictEqual(isGateQuestionId('depth_verification_confirm'), true);
  // Non-gate question IDs
  assert.strictEqual(isGateQuestionId('project_intent'), false);
  assert.strictEqual(isGateQuestionId('feature_priority'), false);
  assert.strictEqual(isGateQuestionId('layer1_scope_gate'), false);
  assert.strictEqual(isGateQuestionId(''), false);
});

// ─── Scenario 20: setPendingGate / getPendingGate / clearPendingGate lifecycle ──

test('write-gate: pending gate lifecycle (set, get, clear)', () => {
  clearDiscussionFlowState();
  assert.strictEqual(getPendingGate(), null, 'starts null');

  setPendingGate('depth_verification');
  assert.strictEqual(getPendingGate(), 'depth_verification', 'set correctly');

  clearPendingGate();
  assert.strictEqual(getPendingGate(), null, 'cleared correctly');

  // clearDiscussionFlowState also clears pending gate
  setPendingGate('depth_verification_M002');
  clearDiscussionFlowState();
  assert.strictEqual(getPendingGate(), null, 'clearDiscussionFlowState clears pending gate');
});

// ─── Scenario 21: shouldBlockPendingGate blocks non-safe tools when gate is pending ──

test('write-gate: shouldBlockPendingGate blocks write/edit during pending gate', () => {
  clearDiscussionFlowState();
  setPendingGate('depth_verification');

  // write should be blocked during discussion
  const writeResult = shouldBlockPendingGate('write', 'M001', false);
  assert.strictEqual(writeResult.block, true, 'write should be blocked');
  assert.ok(writeResult.reason!.includes('depth_verification'), 'reason mentions the gate');

  // edit should be blocked
  const editResult = shouldBlockPendingGate('edit', 'M001', false);
  assert.strictEqual(editResult.block, true, 'edit should be blocked');

  // gsd tools should be blocked
  const gsdResult = shouldBlockPendingGate('gsd_plan_milestone', 'M001', false);
  assert.strictEqual(gsdResult.block, true, 'gsd tools should be blocked');

  clearDiscussionFlowState();
});

// ─── Scenario 22: shouldBlockPendingGate allows safe tools when gate is pending ──

test('write-gate: shouldBlockPendingGate allows read-only and ask_user_questions during pending gate', () => {
  clearDiscussionFlowState();
  setPendingGate('depth_verification');

  // ask_user_questions is always safe (model needs to re-ask)
  assert.strictEqual(shouldBlockPendingGate('ask_user_questions', 'M001').block, false);
  // read-only tools are safe
  assert.strictEqual(shouldBlockPendingGate('read', 'M001').block, false);
  assert.strictEqual(shouldBlockPendingGate('grep', 'M001').block, false);
  assert.strictEqual(shouldBlockPendingGate('glob', 'M001').block, false);
  assert.strictEqual(shouldBlockPendingGate('ls', 'M001').block, false);

  clearDiscussionFlowState();
});

// ─── Scenario 23: shouldBlockPendingGate still blocks when the session is ambiguous ──

test('write-gate: shouldBlockPendingGate blocks outside discussion when a gate is pending', () => {
  clearDiscussionFlowState();
  setPendingGate('depth_verification');

  // No milestoneId and no queue phase — still block because the gate is pending
  const result = shouldBlockPendingGate('write', null, false);
  assert.strictEqual(result.block, true, 'should block even when milestoneId is null');

  clearDiscussionFlowState();
});

// ─── Scenario 24: shouldBlockPendingGate blocks in queue mode ──

test('write-gate: shouldBlockPendingGate blocks in queue mode when gate is pending', () => {
  clearDiscussionFlowState();
  setQueuePhaseActive(true);
  setPendingGate('depth_verification');

  const result = shouldBlockPendingGate('write', null, true);
  assert.strictEqual(result.block, true, 'should block in queue mode');

  clearDiscussionFlowState();
});

// ─── Scenario 25: shouldBlockPendingGateBash allows read-only commands ──

test('write-gate: shouldBlockPendingGateBash allows read-only commands during pending gate', () => {
  clearDiscussionFlowState();
  setPendingGate('depth_verification');

  assert.strictEqual(shouldBlockPendingGateBash('cat file.txt', 'M001').block, false);
  assert.strictEqual(shouldBlockPendingGateBash('git log --oneline', 'M001').block, false);
  assert.strictEqual(shouldBlockPendingGateBash('grep -r pattern .', 'M001').block, false);
  assert.strictEqual(shouldBlockPendingGateBash('ls -la', 'M001').block, false);

  clearDiscussionFlowState();
});

// ─── Scenario 26: shouldBlockPendingGateBash blocks mutating commands ──

test('write-gate: shouldBlockPendingGateBash blocks mutating commands during pending gate', () => {
  clearDiscussionFlowState();
  setPendingGate('depth_verification');

  const result = shouldBlockPendingGateBash('npm run build', 'M001');
  assert.strictEqual(result.block, true, 'mutating bash should be blocked');
  assert.ok(result.reason!.includes('depth_verification'));

  clearDiscussionFlowState();
});

// ─── Scenario 27: no pending gate means no blocking ──

test('write-gate: no pending gate means no blocking', () => {
  clearDiscussionFlowState();

  assert.strictEqual(shouldBlockPendingGate('write', 'M001').block, false);
  assert.strictEqual(shouldBlockPendingGateBash('npm run build', 'M001').block, false);
});

// ─── Scenario 28: resetWriteGateState clears pending gate ──

test('write-gate: resetWriteGateState clears pending gate', () => {
  setPendingGate('depth_verification');
  resetWriteGateState();
  assert.strictEqual(getPendingGate(), null);
});

// ─── Standard options fixture used across depth confirmation tests ──

const STANDARD_OPTIONS = [
  { label: 'Yes, you got it (Recommended)' },
  { label: 'Not quite — let me clarify' },
];

// ─── Scenario 11: accepts first option (confirmation) with structural validation ──

test('write-gate: isDepthConfirmationAnswer accepts first option with options present', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer('Yes, you got it (Recommended)', STANDARD_OPTIONS),
    true,
    'should accept exact match of first option label',
  );
});

// ─── Scenario 12: rejects second option (decline) ──

test('write-gate: isDepthConfirmationAnswer rejects decline option', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer('Not quite — let me clarify', STANDARD_OPTIONS),
    false,
    'should reject the clarification option',
  );
});

// ─── Scenario 13: rejects "None of the above" ──

test('write-gate: isDepthConfirmationAnswer rejects None of the above', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer('None of the above', STANDARD_OPTIONS),
    false,
    'should reject None of the above',
  );
});

// ─── Scenario 14: rejects garbage/empty input ──

test('write-gate: isDepthConfirmationAnswer rejects garbage and edge cases', () => {
  assert.strictEqual(isDepthConfirmationAnswer('discord', STANDARD_OPTIONS), false, 'garbage string');
  assert.strictEqual(isDepthConfirmationAnswer('', STANDARD_OPTIONS), false, 'empty string');
  assert.strictEqual(isDepthConfirmationAnswer(undefined, STANDARD_OPTIONS), false, 'undefined');
  assert.strictEqual(isDepthConfirmationAnswer(null, STANDARD_OPTIONS), false, 'null');
  assert.strictEqual(isDepthConfirmationAnswer(42, STANDARD_OPTIONS), false, 'number');
});

// ─── Scenario 15: handles array-wrapped selection ──

test('write-gate: isDepthConfirmationAnswer handles array-wrapped selected value', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer(['Yes, you got it (Recommended)'], STANDARD_OPTIONS),
    true,
    'should accept array-wrapped confirmation',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer(['Not quite — let me clarify'], STANDARD_OPTIONS),
    false,
    'should reject array-wrapped decline',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer([], STANDARD_OPTIONS),
    false,
    'should reject empty array',
  );
});

// ─── Scenario 16: rejects free-form "Other" text that contains "(Recommended)" ──

test('write-gate: isDepthConfirmationAnswer rejects free-form text containing Recommended', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer('I think this is fine (Recommended)', STANDARD_OPTIONS),
    false,
    'free-form text with (Recommended) substring must not unlock gate',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer('(Recommended)', STANDARD_OPTIONS),
    false,
    'bare (Recommended) string must not unlock gate',
  );
});

// ─── Scenario 17: works with changed label text (decoupled from specific copy) ──

test('write-gate: isDepthConfirmationAnswer works with different label text', () => {
  const customOptions = [
    { label: 'Looks good, proceed' },
    { label: 'Needs more discussion' },
  ];
  assert.strictEqual(
    isDepthConfirmationAnswer('Looks good, proceed', customOptions),
    true,
    'should accept first option regardless of label text',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer('Needs more discussion', customOptions),
    false,
    'should reject second option',
  );
  // Old label should NOT work with new options
  assert.strictEqual(
    isDepthConfirmationAnswer('Yes, you got it (Recommended)', customOptions),
    false,
    'old label text should not match new options',
  );
});

// ─── Scenario 18: fallback when options not available ──

test('write-gate: isDepthConfirmationAnswer falls back to (Recommended) match without options', () => {
  assert.strictEqual(
    isDepthConfirmationAnswer('Yes, you got it (Recommended)'),
    true,
    'should accept via fallback when no options provided',
  );
  assert.strictEqual(
    isDepthConfirmationAnswer('Not quite — let me clarify'),
    false,
    'should reject non-Recommended via fallback',
  );
});
