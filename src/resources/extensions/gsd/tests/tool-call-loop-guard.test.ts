// tool-call-loop-guard — Tests for the tool-call loop detection guard.
//
// Verifies that identical consecutive tool calls are detected and blocked
// after exceeding the threshold, and that the guard resets properly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkToolCallLoop,
  resetToolCallLoopGuard,
  disableToolCallLoopGuard,
  getToolCallLoopCount,
} from '../bootstrap/tool-call-loop-guard.ts';


// ═══════════════════════════════════════════════════════════════════════════
// Allows first N calls, blocks after threshold
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: blocks after threshold ──');

{
  resetToolCallLoopGuard();

  // First 4 identical calls should be allowed (threshold is 4)
  for (let i = 1; i <= 4; i++) {
    const result = checkToolCallLoop('web_search', { query: 'same query' });
    assert.ok(result.block === false, `Call ${i} should be allowed`);
    assert.deepStrictEqual(result.count, i, `Count should be ${i} after call ${i}`);
  }

  // 5th identical call should be blocked
  const blocked = checkToolCallLoop('web_search', { query: 'same query' });
  assert.ok(blocked.block === true, '5th identical call should be blocked');
  assert.ok(blocked.reason!.includes('web_search'), 'Reason should mention tool name');
  assert.ok(blocked.reason!.includes('5'), 'Reason should mention count');
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
  assert.deepStrictEqual(getToolCallLoopCount(), 3, 'Count should be 3 after 3 identical calls');

  // A different call resets the streak
  const different = checkToolCallLoop('bash', { command: 'ls' });
  assert.ok(different.block === false, 'Different tool call should be allowed');
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Count should reset to 1 after different call');

  // Same tool but different args also resets
  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query B' }); // different args
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Different args should reset count');
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
  assert.deepStrictEqual(getToolCallLoopCount(), 3, 'Count should be 3 before reset');

  resetToolCallLoopGuard();
  assert.deepStrictEqual(getToolCallLoopCount(), 0, 'Count should be 0 after reset');

  // After reset, the same call starts fresh
  const result = checkToolCallLoop('web_search', { query: 'q' });
  assert.ok(result.block === false, 'Call after reset should be allowed');
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Count should be 1 after first call post-reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Disable makes guard permissive
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: disable allows everything ──');

{
  disableToolCallLoopGuard();

  for (let i = 0; i < 10; i++) {
    const result = checkToolCallLoop('web_search', { query: 'same' });
    assert.ok(result.block === false, `Call ${i + 1} should be allowed when disabled`);
  }

  // Re-enable via reset
  resetToolCallLoopGuard();
  checkToolCallLoop('web_search', { query: 'q' });
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Guard should be active again after reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Arg order doesn't affect hash
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: arg order is normalized ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('web_search', { query: 'test', limit: 5 });
  const result = checkToolCallLoop('web_search', { limit: 5, query: 'test' }); // same args, different order
  assert.ok(result.block === false, 'Same args in different order should count as consecutive');
  assert.deepStrictEqual(getToolCallLoopCount(), 2, 'Should detect as same call regardless of key order');
}

// ═══════════════════════════════════════════════════════════════════════════
// Nested/array arguments produce distinct hashes
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: nested args are not stripped ──');

{
  resetToolCallLoopGuard();

  // Simulate ask_user_questions-style calls with different nested content
  for (let i = 1; i <= 5; i++) {
    const result = checkToolCallLoop('ask_user_questions', {
      questions: [{ id: `q${i}`, question: `Question ${i}?` }],
    });
    assert.ok(result.block === false, `Nested call ${i} with unique content should be allowed`);
    assert.deepStrictEqual(getToolCallLoopCount(), 1, `Each unique nested call should reset count to 1`);
  }

  // Truly identical nested calls should still be detected.
  // ask_user_questions has a strict threshold of 1, so the 2nd identical call is blocked.
  resetToolCallLoopGuard();
  const first = checkToolCallLoop('ask_user_questions', {
    questions: [{ id: 'same', question: 'Same?' }],
  });
  assert.ok(first.block === false, 'First ask_user_questions call should be allowed');
  const blocked = checkToolCallLoop('ask_user_questions', {
    questions: [{ id: 'same', question: 'Same?' }],
  });
  assert.ok(blocked.block === true, '2nd identical ask_user_questions call should be blocked (strict threshold)');

  // Non-strict tools still allow up to 4 identical calls
  resetToolCallLoopGuard();
  for (let i = 1; i <= 4; i++) {
    const r = checkToolCallLoop('web_search', {
      questions: [{ id: 'same', question: 'Same?' }],
    });
    assert.ok(r.block === false, `web_search call ${i} should be allowed (normal threshold)`);
  }
  const blockedNormal = checkToolCallLoop('web_search', {
    questions: [{ id: 'same', question: 'Same?' }],
  });
  assert.ok(blockedNormal.block === true, '5th identical web_search call should be blocked');
}

// ═══════════════════════════════════════════════════════════════════════════
// Nested object key order is normalized
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: nested key order is normalized ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('tool', { outer: { b: 2, a: 1 } });
  const result = checkToolCallLoop('tool', { outer: { a: 1, b: 2 } });
  assert.deepStrictEqual(getToolCallLoopCount(), 2, 'Same nested args in different key order should match');
}

// ═══════════════════════════════════════════════════════════════════════════
