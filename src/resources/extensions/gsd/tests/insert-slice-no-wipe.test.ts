import test from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, closeDatabase, insertMilestone, insertSlice, getSlice } from '../gsd-db.ts';

test('insertSlice with minimal args does not wipe populated fields', (t) => {
  t.after(() => { try { closeDatabase(); } catch { /* noop */ } });
  openDatabase(":memory:");

  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });

  // First insert: full data
  insertSlice({
    id: 'S01',
    milestoneId: 'M001',
    title: 'Auth flow',
    status: 'in-progress',
    risk: 'high',
    demo: 'Login page renders.',
    sequence: 3,
    planning: {
      goal: 'Secure authentication',
      successCriteria: 'All tests pass',
      proofLevel: 'integration',
      integrationClosure: 'Fully integrated',
      observabilityImpact: 'Metrics available',
    },
  });

  const before = getSlice('M001', 'S01');
  assert.ok(before, 'slice should exist after first insert');
  assert.equal(before.title, 'Auth flow');
  assert.equal(before.demo, 'Login page renders.');
  assert.equal(before.risk, 'high');

  // Second insert: minimal "ensure exists" call (mirrors complete-task.ts usage)
  insertSlice({ id: 'S01', milestoneId: 'M001' });

  const after = getSlice('M001', 'S01');
  assert.ok(after, 'slice should still exist after second insert');

  // These must NOT be wiped to empty strings
  assert.equal(after.title, 'Auth flow', 'title must survive minimal re-insert');
  assert.equal(after.demo, 'Login page renders.', 'demo must survive minimal re-insert');
  assert.equal(after.risk, 'high', 'risk must survive minimal re-insert');
  assert.equal(after.sequence, 3, 'sequence must survive minimal re-insert');

  // Planning fields must also survive
  assert.equal(after.goal, 'Secure authentication', 'goal must survive minimal re-insert');
  assert.equal(after.success_criteria, 'All tests pass', 'success_criteria must survive');
  assert.equal(after.proof_level, 'integration', 'proof_level must survive');
  assert.equal(after.integration_closure, 'Fully integrated', 'integration_closure must survive');
  assert.equal(after.observability_impact, 'Metrics available', 'observability_impact must survive');
});

test('insertSlice ON CONFLICT preserves completed status', (t) => {
  t.after(() => { try { closeDatabase(); } catch { /* noop */ } });
  openDatabase(":memory:");

  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });

  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Done slice', status: 'complete' });

  // Re-insert with pending status (default) should NOT overwrite complete
  insertSlice({ id: 'S01', milestoneId: 'M001' });

  const after = getSlice('M001', 'S01');
  assert.ok(after);
  assert.equal(after.status, 'complete', 'completed status must not be overwritten');
});

test('insertSlice ON CONFLICT allows explicit updates to non-empty values', (t) => {
  t.after(() => { try { closeDatabase(); } catch { /* noop */ } });
  openDatabase(":memory:");

  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });

  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Original', demo: 'Old demo', risk: 'low' });

  // Explicit update with real values should overwrite
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Updated', demo: 'New demo', risk: 'high' });

  const after = getSlice('M001', 'S01');
  assert.ok(after);
  assert.equal(after.title, 'Updated', 'explicit title update should apply');
  assert.equal(after.demo, 'New demo', 'explicit demo update should apply');
  assert.equal(after.risk, 'high', 'explicit risk update should apply');
});
