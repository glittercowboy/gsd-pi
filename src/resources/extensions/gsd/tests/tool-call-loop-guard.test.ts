// tool-call-loop-guard — Tests for the tool-call loop detection guard.
//
// Verifies that identical consecutive tool calls are detected and blocked
// after exceeding the threshold, and that the guard resets properly.

import { createTestContext } from './test-helpers.ts';
import {
  checkToolCallLoop,
  resetToolCallLoopGuard,
  disableToolCallLoopGuard,
  getToolCallLoopCount,
} from '../bootstrap/tool-call-loop-guard.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Allows first N calls, blocks after threshold
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: blocks after threshold ──');

{
  resetToolCallLoopGuard();

  // First 4 identical calls should be allowed (threshold is 4)
  for (let i = 1; i <= 4; i++) {
    const result = checkToolCallLoop('web_search', { query: 'same query' });
    assertTrue(result.block === false, `Call ${i} should be allowed`);
    assertEq(result.count, i, `Count should be ${i} after call ${i}`);
  }

  // 5th identical call should be blocked
  const blocked = checkToolCallLoop('web_search', { query: 'same query' });
  assertTrue(blocked.block === true, '5th identical call should be blocked');
  assertTrue(blocked.reason!.includes('web_search'), 'Reason should mention tool name');
  assertTrue(blocked.reason!.includes('5'), 'Reason should mention count');
}

// ═══════════════════════════════════════════════════════════════════════════
// Different tool calls reset the streak
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: different calls reset streak ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query A' });
  assertEq(getToolCallLoopCount(), 3, 'Count should be 3 after 3 identical calls');

  // A different call resets the streak
  const different = checkToolCallLoop('bash', { command: 'ls' });
  assertTrue(different.block === false, 'Different tool call should be allowed');
  assertEq(getToolCallLoopCount(), 1, 'Count should reset to 1 after different call');

  // Same tool but different args also resets
  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query B' }); // different args
  assertEq(getToolCallLoopCount(), 1, 'Different args should reset count');
}

// ═══════════════════════════════════════════════════════════════════════════
// Reset clears the guard
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: reset clears state ──');

{
  resetToolCallLoopGuard();
  checkToolCallLoop('web_search', { query: 'q' });
  checkToolCallLoop('web_search', { query: 'q' });
  checkToolCallLoop('web_search', { query: 'q' });
  assertEq(getToolCallLoopCount(), 3, 'Count should be 3 before reset');

  resetToolCallLoopGuard();
  assertEq(getToolCallLoopCount(), 0, 'Count should be 0 after reset');

  // After reset, the same call starts fresh
  const result = checkToolCallLoop('web_search', { query: 'q' });
  assertTrue(result.block === false, 'Call after reset should be allowed');
  assertEq(getToolCallLoopCount(), 1, 'Count should be 1 after first call post-reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Disable makes guard permissive
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: disable allows everything ──');

{
  disableToolCallLoopGuard();

  for (let i = 0; i < 10; i++) {
    const result = checkToolCallLoop('web_search', { query: 'same' });
    assertTrue(result.block === false, `Call ${i + 1} should be allowed when disabled`);
  }

  // Re-enable via reset
  resetToolCallLoopGuard();
  checkToolCallLoop('web_search', { query: 'q' });
  assertEq(getToolCallLoopCount(), 1, 'Guard should be active again after reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Arg order doesn't affect hash
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: arg order is normalized ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('web_search', { query: 'test', limit: 5 });
  const result = checkToolCallLoop('web_search', { limit: 5, query: 'test' }); // same args, different order
  assertTrue(result.block === false, 'Same args in different order should count as consecutive');
  assertEq(getToolCallLoopCount(), 2, 'Should detect as same call regardless of key order');
}

// ═══════════════════════════════════════════════════════════════════════════

report();
