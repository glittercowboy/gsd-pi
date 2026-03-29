/**
 * Unit tests for the queue-mode execution guard (#2545).
 *
 * When queue phase is active, the agent should only create milestones —
 * not execute work. This guard blocks write/edit/bash tool calls that
 * target source code (non-.gsd/ paths) during queue mode.
 *
 * Exercises shouldBlockQueueExecution() — a pure function that checks:
 *   (a) queuePhaseActive false → pass (not in queue mode)
 *   (b) toolName is read-only (read, grep, find, ls) → pass
 *   (c) toolName is ask_user_questions → pass (discussion tool)
 *   (d) write/edit to .gsd/ path → pass (planning artifacts)
 *   (e) write/edit to source path → block
 *   (f) bash command → block (could execute work)
 *   (g) registered GSD tools (gsd_milestone_generate_id, gsd_summary_save) → pass
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockQueueExecution } from '../bootstrap/write-gate.ts';

// ─── Scenario 1: Not in queue mode — all tools pass ──

test('queue-guard: allows all tools when queue phase is not active', () => {
  const r1 = shouldBlockQueueExecution('write', '/src/index.ts', false);
  assert.strictEqual(r1.block, false, 'write should pass outside queue mode');

  const r2 = shouldBlockQueueExecution('bash', 'npm test', false);
  assert.strictEqual(r2.block, false, 'bash should pass outside queue mode');

  const r3 = shouldBlockQueueExecution('edit', '/src/index.ts', false);
  assert.strictEqual(r3.block, false, 'edit should pass outside queue mode');
});

// ─── Scenario 2: Read-only tools always pass in queue mode ──

test('queue-guard: allows read-only tools during queue mode', () => {
  for (const tool of ['read', 'grep', 'find', 'ls', 'glob']) {
    const result = shouldBlockQueueExecution(tool, '/src/index.ts', true);
    assert.strictEqual(result.block, false, `${tool} should pass in queue mode`);
  }
});

// ─── Scenario 3: Discussion/planning tools pass in queue mode ──

test('queue-guard: allows discussion and planning tools during queue mode', () => {
  const r1 = shouldBlockQueueExecution('ask_user_questions', '', true);
  assert.strictEqual(r1.block, false, 'ask_user_questions should pass');

  const r2 = shouldBlockQueueExecution('gsd_milestone_generate_id', '', true);
  assert.strictEqual(r2.block, false, 'gsd_milestone_generate_id should pass');

  const r3 = shouldBlockQueueExecution('gsd_summary_save', '', true);
  assert.strictEqual(r3.block, false, 'gsd_summary_save should pass');
});

// ─── Scenario 4: Write to .gsd/ paths passes (planning artifacts) ──

test('queue-guard: allows writes to .gsd/ paths during queue mode', () => {
  const r1 = shouldBlockQueueExecution('write', '.gsd/milestones/M001/M001-CONTEXT.md', true);
  assert.strictEqual(r1.block, false, 'write to .gsd/ should pass');

  const r2 = shouldBlockQueueExecution('write', '/project/.gsd/PROJECT.md', true);
  assert.strictEqual(r2.block, false, 'write to .gsd/PROJECT.md should pass');

  const r3 = shouldBlockQueueExecution('edit', '.gsd/QUEUE.md', true);
  assert.strictEqual(r3.block, false, 'edit to .gsd/QUEUE.md should pass');

  const r4 = shouldBlockQueueExecution('write', '.gsd/REQUIREMENTS.md', true);
  assert.strictEqual(r4.block, false, 'write to .gsd/REQUIREMENTS.md should pass');

  const r5 = shouldBlockQueueExecution('write', '.gsd/DECISIONS.md', true);
  assert.strictEqual(r5.block, false, 'write to .gsd/DECISIONS.md should pass');
});

// ─── Scenario 5: Write/edit to source code paths blocked ──

test('queue-guard: blocks writes to source code during queue mode', () => {
  const r1 = shouldBlockQueueExecution('write', 'src/index.ts', true);
  assert.strictEqual(r1.block, true, 'write to src/ should be blocked');
  assert.ok(r1.reason, 'should provide a reason');
  assert.ok(r1.reason!.includes('queue'), 'reason should mention queue');

  const r2 = shouldBlockQueueExecution('write', '/project/src/components/App.tsx', true);
  assert.strictEqual(r2.block, true, 'write to component file should be blocked');

  const r3 = shouldBlockQueueExecution('edit', 'package.json', true);
  assert.strictEqual(r3.block, true, 'edit to package.json should be blocked');

  const r4 = shouldBlockQueueExecution('edit', '/project/lib/utils.ts', true);
  assert.strictEqual(r4.block, true, 'edit to lib/ should be blocked');
});

// ─── Scenario 6: Bash commands blocked during queue mode ──

test('queue-guard: blocks bash commands during queue mode', () => {
  const r1 = shouldBlockQueueExecution('bash', 'npm install some-package', true);
  assert.strictEqual(r1.block, true, 'npm install should be blocked');
  assert.ok(r1.reason, 'should provide a reason');

  const r2 = shouldBlockQueueExecution('bash', 'node src/index.ts', true);
  assert.strictEqual(r2.block, true, 'running node should be blocked');
});

// ─── Scenario 7: Bash read-only commands pass during queue mode ──

test('queue-guard: allows read-only bash commands during queue mode', () => {
  const r1 = shouldBlockQueueExecution('bash', 'cat src/index.ts', true);
  assert.strictEqual(r1.block, false, 'cat should pass');

  const r2 = shouldBlockQueueExecution('bash', 'ls -la src/', true);
  assert.strictEqual(r2.block, false, 'ls should pass');

  const r3 = shouldBlockQueueExecution('bash', 'git log --oneline -10', true);
  assert.strictEqual(r3.block, false, 'git log should pass');

  const r4 = shouldBlockQueueExecution('bash', 'find . -name "*.ts"', true);
  assert.strictEqual(r4.block, false, 'find should pass');

  const r5 = shouldBlockQueueExecution('bash', 'grep -rn "TODO" src/', true);
  assert.strictEqual(r5.block, false, 'grep should pass');

  const r6 = shouldBlockQueueExecution('bash', 'head -20 src/index.ts', true);
  assert.strictEqual(r6.block, false, 'head should pass');

  const r7 = shouldBlockQueueExecution('bash', 'wc -l src/index.ts', true);
  assert.strictEqual(r7.block, false, 'wc should pass');

  const r8 = shouldBlockQueueExecution('bash', 'git diff HEAD~1', true);
  assert.strictEqual(r8.block, false, 'git diff should pass');

  const r9 = shouldBlockQueueExecution('bash', 'gh issue view 42', true);
  assert.strictEqual(r9.block, false, 'gh issue view should pass');
});

// ─── Scenario 8: mkdir for .gsd/ milestone directories passes ──

test('queue-guard: allows mkdir for .gsd/ milestone directories', () => {
  const r1 = shouldBlockQueueExecution('bash', 'mkdir -p .gsd/milestones/M010/slices', true);
  assert.strictEqual(r1.block, false, 'mkdir -p .gsd/ should pass');
});

// ─── Scenario 9: Web search and library tools pass ──

test('queue-guard: allows web search and library tools during queue mode', () => {
  const r1 = shouldBlockQueueExecution('search-the-web', '', true);
  assert.strictEqual(r1.block, false, 'search-the-web should pass');

  const r2 = shouldBlockQueueExecution('resolve_library', '', true);
  assert.strictEqual(r2.block, false, 'resolve_library should pass');

  const r3 = shouldBlockQueueExecution('get_library_docs', '', true);
  assert.strictEqual(r3.block, false, 'get_library_docs should pass');

  const r4 = shouldBlockQueueExecution('fetch_page', '', true);
  assert.strictEqual(r4.block, false, 'fetch_page should pass');
});
