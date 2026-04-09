// GSD — reopen-task handler tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
} from '../gsd-db.ts';
import { handleReopenTask } from '../tools/reopen-task.ts';

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-reopen-task-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedCompleteTask(): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'in_progress' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task One', status: 'complete' });
  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Task Two', status: 'pending' });
}

// ─── Success path ────────────────────────────────────────────────────────

test('handleReopenTask: resets a complete task to pending', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteTask();

    const result = await handleReopenTask({
      milestoneId: 'M001',
      sliceId: 'S01',
      taskId: 'T01',
      reason: 'verification failed after merge',
    }, base);

    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
    assert.equal(result.taskId, 'T01');

    const task = getTask('M001', 'S01', 'T01');
    assert.ok(task, 'task should still exist');
    assert.equal(task!.status, 'pending', 'task status should be reset to pending');
  } finally {
    cleanup(base);
  }
});

test('handleReopenTask: does not affect other tasks in the slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteTask();

    await handleReopenTask({ milestoneId: 'M001', sliceId: 'S01', taskId: 'T01' }, base);

    const t02 = getTask('M001', 'S01', 'T02');
    assert.ok(t02, 'T02 should still exist');
    assert.equal(t02!.status, 'pending', 'T02 status should be unchanged');
  } finally {
    cleanup(base);
  }
});

// ─── Failure paths ───────────────────────────────────────────────────────

test('handleReopenTask: rejects empty taskId', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    const result = await handleReopenTask({ milestoneId: 'M001', sliceId: 'S01', taskId: '' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /taskId/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenTask: rejects non-existent milestone', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    const result = await handleReopenTask({ milestoneId: 'M999', sliceId: 'S01', taskId: 'T01' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /milestone not found/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenTask: rejects task in a closed milestone', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Done', status: 'complete' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'complete' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete' });

    const result = await handleReopenTask({ milestoneId: 'M001', sliceId: 'S01', taskId: 'T01' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /closed milestone/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenTask: rejects task inside a closed slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Active', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'complete' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete' });

    const result = await handleReopenTask({ milestoneId: 'M001', sliceId: 'S01', taskId: 'T01' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /closed slice/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenTask: rejects reopening a task that is not complete', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteTask();

    const result = await handleReopenTask({ milestoneId: 'M001', sliceId: 'S01', taskId: 'T02' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /not complete/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenTask: rejects non-existent task', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Active', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'in_progress' });

    const result = await handleReopenTask({ milestoneId: 'M001', sliceId: 'S01', taskId: 'T99' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /task not found/);
  } finally {
    cleanup(base);
  }
});
