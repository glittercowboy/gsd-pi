import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  upsertTaskPlanning,
  getSliceTasks,
  getTask,
  getReplanHistory,
  _getAdapter,
} from '../gsd-db.ts';
import { handleReplanSlice } from '../tools/replan-slice.ts';
import { parsePlan } from '../parsers-legacy.ts';

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-replan-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedSliceWithTasks(opts?: {
  t01Status?: string;
  t02Status?: string;
  t03Status?: string;
}): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'active', demo: 'Demo.' });

  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task One', status: opts?.t01Status ?? 'complete' });
  upsertTaskPlanning('M001', 'S01', 'T01', {
    description: 'First task description.',
    estimate: '30m',
    files: ['src/a.ts'],
    verify: 'node --test a.test.ts',
    inputs: ['src/a.ts'],
    expectedOutput: ['src/a.ts'],
  });

  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Task Two', status: opts?.t02Status ?? 'pending' });
  upsertTaskPlanning('M001', 'S01', 'T02', {
    description: 'Second task description.',
    estimate: '45m',
    files: ['src/b.ts'],
    verify: 'node --test b.test.ts',
    inputs: ['src/b.ts'],
    expectedOutput: ['src/b.ts'],
  });

  if (opts?.t03Status !== undefined || !opts) {
    insertTask({ id: 'T03', sliceId: 'S01', milestoneId: 'M001', title: 'Task Three', status: opts?.t03Status ?? 'pending' });
    upsertTaskPlanning('M001', 'S01', 'T03', {
      description: 'Third task description.',
      estimate: '20m',
      files: ['src/c.ts'],
      verify: 'node --test c.test.ts',
      inputs: ['src/c.ts'],
      expectedOutput: ['src/c.ts'],
    });
  }
}

function validReplanParams() {
  return {
    milestoneId: 'M001',
    sliceId: 'S01',
    blockerTaskId: 'T01',
    blockerDescription: 'T01 discovered a blocker in the API.',
    whatChanged: 'Updated T02 to use new API, removed T03, added T04.',
    updatedTasks: [
      {
        taskId: 'T02',
        title: 'Updated Task Two',
        description: 'Revised description for T02.',
        estimate: '1h',
        files: ['src/b-v2.ts'],
        verify: 'node --test b-v2.test.ts',
        inputs: ['src/b.ts'],
        expectedOutput: ['src/b-v2.ts'],
      },
    ],
    removedTaskIds: ['T03'],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('handleReplanSlice rejects invalid payloads (missing milestoneId)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedSliceWithTasks();
    const result = await handleReplanSlice({ ...validReplanParams(), milestoneId: '' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed/);
    assert.match(result.error, /milestoneId/);
  } finally {
    cleanup(base);
  }
});

test('handleReplanSlice rejects structural violation: updating a completed task', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedSliceWithTasks({ t01Status: 'complete', t02Status: 'pending' });

    const result = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: 'T01',
          title: 'Trying to update completed T01',
          description: 'Should be rejected.',
          estimate: '1h',
          files: [],
          verify: '',
          inputs: [],
          expectedOutput: [],
        },
      ],
      removedTaskIds: [],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /completed task/);
    assert.match(result.error, /T01/);
  } finally {
    cleanup(base);
  }
});

test('handleReplanSlice rejects structural violation: removing a completed task', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedSliceWithTasks({ t01Status: 'complete', t02Status: 'pending' });

    const result = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [],
      removedTaskIds: ['T01'],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /completed task/);
    assert.match(result.error, /T01/);
  } finally {
    cleanup(base);
  }
});

test('handleReplanSlice succeeds when modifying only incomplete tasks', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedSliceWithTasks({ t01Status: 'complete', t02Status: 'pending', t03Status: 'pending' });

    const params = {
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: 'T02',
          title: 'Updated Task Two',
          description: 'Revised description for T02.',
          estimate: '1h',
          files: ['src/b-v2.ts'],
          verify: 'node --test b-v2.test.ts',
          inputs: ['src/b.ts'],
          expectedOutput: ['src/b-v2.ts'],
        },
        {
          taskId: 'T04',
          title: 'New Task Four',
          description: 'Brand new task added during replan.',
          estimate: '30m',
          files: ['src/d.ts'],
          verify: 'node --test d.test.ts',
          inputs: [],
          expectedOutput: ['src/d.ts'],
        },
      ],
      removedTaskIds: ['T03'],
    };

    const result = await handleReplanSlice(params, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    // Verify replan_history row exists
    const history = getReplanHistory('M001', 'S01');
    assert.ok(history.length > 0, 'replan_history should have at least one entry');
    assert.equal(history[0]['milestone_id'], 'M001');
    assert.equal(history[0]['slice_id'], 'S01');
    assert.equal(history[0]['task_id'], 'T01');

    // Verify T02 was updated
    const t02 = getTask('M001', 'S01', 'T02');
    assert.ok(t02, 'T02 should still exist');
    assert.equal(t02?.title, 'Updated Task Two');
    assert.equal(t02?.description, 'Revised description for T02.');

    // Verify T03 was deleted
    const t03 = getTask('M001', 'S01', 'T03');
    assert.equal(t03, null, 'T03 should have been deleted');

    // Verify T04 was inserted
    const t04 = getTask('M001', 'S01', 'T04');
    assert.ok(t04, 'T04 should exist as a new task');
    assert.equal(t04?.title, 'New Task Four');
    assert.equal(t04?.status, 'pending');

    // Verify T01 (completed) was NOT touched
    const t01 = getTask('M001', 'S01', 'T01');
    assert.ok(t01, 'T01 should still exist');
    assert.equal(t01?.status, 'complete');

    // Verify rendered PLAN.md exists on disk
    const planPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
    assert.ok(existsSync(planPath), 'PLAN.md should be rendered to disk');

    // Verify REPLAN.md exists on disk
    const replanPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-REPLAN.md');
    assert.ok(existsSync(replanPath), 'REPLAN.md should be rendered to disk');
    const replanContent = readFileSync(replanPath, 'utf-8');
    assert.ok(replanContent.includes('Blocker Description'), 'REPLAN.md should contain blocker section');
    assert.ok(replanContent.includes('T01'), 'REPLAN.md should reference blocker task');
  } finally {
    cleanup(base);
  }
});

test('handleReplanSlice cache invalidation: re-parsing PLAN.md reflects mutations', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedSliceWithTasks({ t01Status: 'complete', t02Status: 'pending', t03Status: 'pending' });

    const params = {
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: 'T02',
          title: 'Cache-Test Updated T02',
          description: 'This title should appear in re-parsed plan.',
          estimate: '1h',
          files: ['src/b.ts'],
          verify: 'test',
          inputs: [],
          expectedOutput: [],
        },
      ],
      removedTaskIds: ['T03'],
    };

    const result = await handleReplanSlice(params, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    // Re-parse PLAN.md from disk to verify cache invalidation worked
    const planPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
    const content = readFileSync(planPath, 'utf-8');
    const parsed = parsePlan(content);

    // T01 should still be present (completed, untouched)
    const t01Task = parsed.tasks.find(t => t.id === 'T01');
    assert.ok(t01Task, 'completed T01 should remain in parsed plan');

    // T02 should show updated title
    const t02Task = parsed.tasks.find(t => t.id === 'T02');
    assert.ok(t02Task, 'T02 should be in parsed plan');
    assert.ok(t02Task?.title?.includes('Cache-Test Updated T02'), 'T02 title should be updated');

    // T03 should be gone
    const t03Task = parsed.tasks.find(t => t.id === 'T03');
    assert.equal(t03Task, undefined, 'T03 should not appear in parsed plan after removal');
  } finally {
    cleanup(base);
  }
});

test('handleReplanSlice is idempotent: calling twice with same params succeeds', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedSliceWithTasks({ t01Status: 'complete', t02Status: 'pending', t03Status: 'pending' });

    const params = {
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: 'T02',
          title: 'Idempotent Update',
          description: 'Same update applied twice.',
          estimate: '1h',
          files: ['src/b.ts'],
          verify: 'test',
          inputs: [],
          expectedOutput: [],
        },
      ],
      removedTaskIds: ['T03'],
    };

    const first = await handleReplanSlice(params, base);
    assert.ok(!('error' in first), `first call error: ${'error' in first ? first.error : ''}`);

    const second = await handleReplanSlice(params, base);
    assert.ok(!('error' in second), `second call error: ${'error' in second ? second.error : ''}`);

    // Both should succeed and replan_history should have 2 entries
    const history = getReplanHistory('M001', 'S01');
    assert.ok(history.length >= 2, 'replan_history should have at least 2 entries after idempotent rerun');
  } finally {
    cleanup(base);
  }
});

test('handleReplanSlice returns missing parent slice error', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    // No slice inserted

    const result = await handleReplanSlice(validReplanParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /missing parent slice/);
  } finally {
    cleanup(base);
  }
});

test('handleReplanSlice rejects task with status "done" (alias for complete)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedSliceWithTasks({ t01Status: 'done', t02Status: 'pending' });

    const result = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: 'T01',
          title: 'Trying to update done T01',
          description: 'Should be rejected.',
          estimate: '1h',
          files: [],
          verify: '',
          inputs: [],
          expectedOutput: [],
        },
      ],
      removedTaskIds: [],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /completed task/);
    assert.match(result.error, /T01/);
  } finally {
    cleanup(base);
  }
});

test('handleReplanSlice returns structured error payloads with actionable messages', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedSliceWithTasks({ t01Status: 'complete', t02Status: 'complete', t03Status: 'pending' });

    // Try to modify T01 (completed)
    const modifyResult = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [{ taskId: 'T01', title: 'x', description: '', estimate: '', files: [], verify: '', inputs: [], expectedOutput: [] }],
      removedTaskIds: [],
    }, base);
    assert.ok('error' in modifyResult);
    assert.ok(typeof modifyResult.error === 'string', 'error should be a string');
    assert.ok(modifyResult.error.includes('T01'), 'error should name the specific task ID');

    // Try to remove T02 (completed)
    const removeResult = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [],
      removedTaskIds: ['T02'],
    }, base);
    assert.ok('error' in removeResult);
    assert.ok(removeResult.error.includes('T02'), 'error should name the specific task ID T02');
  } finally {
    cleanup(base);
  }
});
