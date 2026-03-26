// GSD — reopen-slice handler tests
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
  getSlice,
  getSliceTasks,
} from '../gsd-db.ts';
import { handleReopenSlice } from '../tools/reopen-slice.ts';

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-reopen-slice-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedCompleteSlice(): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'complete' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task One', status: 'complete' });
  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Task Two', status: 'complete' });
}

// ─── Success path ────────────────────────────────────────────────────────

test('handleReopenSlice: resets a complete slice to in_progress and all tasks to pending', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedCompleteSlice();

    const result = await handleReopenSlice({
      milestoneId: 'M001',
      sliceId: 'S01',
      reason: 'need to redo after requirements change',
    }, base);

    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
    assert.equal(result.sliceId, 'S01');
    assert.equal(result.tasksReset, 2, 'should report 2 tasks reset');

    const slice = getSlice('M001', 'S01');
    assert.ok(slice, 'slice should still exist');
    assert.equal(slice!.status, 'in_progress', 'slice status should be in_progress');

    const tasks = getSliceTasks('M001', 'S01');
    assert.equal(tasks.length, 2, 'both tasks should still exist');
    assert.ok(tasks.every(t => t.status === 'pending'), 'all tasks should be pending');
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: works with a single task', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'complete' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete' });

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);

    assert.ok(!('error' in result));
    assert.equal(result.tasksReset, 1);
  } finally {
    cleanup(base);
  }
});

// ─── Failure paths ───────────────────────────────────────────────────────

test('handleReopenSlice: rejects empty sliceId', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: '' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /sliceId/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: rejects non-existent milestone', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    const result = await handleReopenSlice({ milestoneId: 'M999', sliceId: 'S01' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /milestone not found/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: rejects slice in a closed milestone', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Done', status: 'complete' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'complete' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete' });

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /closed milestone/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: rejects reopening a slice that is not complete', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Active', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', status: 'in_progress' });

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S01' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /not complete/);
  } finally {
    cleanup(base);
  }
});

test('handleReopenSlice: rejects non-existent slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Active', status: 'active' });

    const result = await handleReopenSlice({ milestoneId: 'M001', sliceId: 'S99' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /slice not found/);
  } finally {
    cleanup(base);
  }
});
