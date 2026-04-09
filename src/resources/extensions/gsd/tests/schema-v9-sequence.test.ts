import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getMilestoneSlices,
  getSliceTasks,
  getActiveSliceFromDb,
  getActiveTaskFromDb,
} from '../gsd-db.ts';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-v9-'));
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test('schema v9: migration adds sequence column to slices and tasks', () => {
  const base = makeTmp();
  const dbPath = join(base, 'gsd.db');
  openDatabase(dbPath);
  try {
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    // If sequence column doesn't exist, these would throw
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice 1', sequence: 5 });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task 1', sequence: 3 });

    const slices = getMilestoneSlices('M001');
    assert.equal(slices.length, 1);
    assert.equal(slices[0]!.sequence, 5);

    const tasks = getSliceTasks('M001', 'S01');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.sequence, 3);
  } finally {
    cleanup(base);
  }
});

test('schema v9: getMilestoneSlices returns slices ordered by sequence then id', () => {
  const base = makeTmp();
  openDatabase(join(base, 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });

    // Insert in reverse lexicographic order with sequence overriding id order
    insertSlice({ id: 'S03', milestoneId: 'M001', title: 'Third by id, first by seq', sequence: 1 });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First by id, third by seq', sequence: 3 });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second by id, second by seq', sequence: 2 });

    const slices = getMilestoneSlices('M001');
    assert.equal(slices.length, 3);
    assert.equal(slices[0]!.id, 'S03', 'sequence=1 should be first');
    assert.equal(slices[1]!.id, 'S02', 'sequence=2 should be second');
    assert.equal(slices[2]!.id, 'S01', 'sequence=3 should be third');
  } finally {
    cleanup(base);
  }
});

test('schema v9: getSliceTasks returns tasks ordered by sequence then id', () => {
  const base = makeTmp();
  openDatabase(join(base, 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice' });

    // Insert tasks with sequence overriding id order
    insertTask({ id: 'T03', sliceId: 'S01', milestoneId: 'M001', title: 'Third by id', sequence: 1 });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First by id', sequence: 3 });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second by id', sequence: 2 });

    const tasks = getSliceTasks('M001', 'S01');
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0]!.id, 'T03', 'sequence=1 should be first');
    assert.equal(tasks[1]!.id, 'T02', 'sequence=2 should be second');
    assert.equal(tasks[2]!.id, 'T01', 'sequence=3 should be third');
  } finally {
    cleanup(base);
  }
});

test('schema v9: default sequence (0) falls back to id-based ordering', () => {
  const base = makeTmp();
  openDatabase(join(base, 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });

    // All slices with default sequence=0 should sort by id
    insertSlice({ id: 'S03', milestoneId: 'M001', title: 'Third' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second' });

    const slices = getMilestoneSlices('M001');
    assert.equal(slices[0]!.id, 'S01', 'default seq=0: should sort by id');
    assert.equal(slices[1]!.id, 'S02');
    assert.equal(slices[2]!.id, 'S03');

    // Same for tasks
    insertSlice({ id: 'S04', milestoneId: 'M001', title: 'Container' });
    insertTask({ id: 'T02', sliceId: 'S04', milestoneId: 'M001', title: 'B' });
    insertTask({ id: 'T01', sliceId: 'S04', milestoneId: 'M001', title: 'A' });
    insertTask({ id: 'T03', sliceId: 'S04', milestoneId: 'M001', title: 'C' });

    const tasks = getSliceTasks('M001', 'S04');
    assert.equal(tasks[0]!.id, 'T01');
    assert.equal(tasks[1]!.id, 'T02');
    assert.equal(tasks[2]!.id, 'T03');
  } finally {
    cleanup(base);
  }
});

test('schema v9: getActiveSliceFromDb respects sequence ordering', () => {
  const base = makeTmp();
  openDatabase(join(base, 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });

    // S02 has lower sequence so should be active first despite higher id than S01
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Higher seq', status: 'pending', sequence: 5 });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Lower seq', status: 'pending', sequence: 2 });

    const active = getActiveSliceFromDb('M001');
    assert.ok(active);
    assert.equal(active!.id, 'S02', 'lower sequence should be active first');
  } finally {
    cleanup(base);
  }
});

test('schema v9: getActiveTaskFromDb respects sequence ordering', () => {
  const base = makeTmp();
  openDatabase(join(base, 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice' });

    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Higher seq', status: 'pending', sequence: 10 });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Lower seq', status: 'pending', sequence: 1 });

    const active = getActiveTaskFromDb('M001', 'S01');
    assert.ok(active);
    assert.equal(active!.id, 'T02', 'lower sequence should be active first');
  } finally {
    cleanup(base);
  }
});

test('schema v9: sequence field defaults to 0 when not provided', () => {
  const base = makeTmp();
  openDatabase(join(base, 'gsd.db'));
  try {
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'No seq' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'No seq' });

    const slices = getMilestoneSlices('M001');
    assert.equal(slices[0]!.sequence, 0, 'slice sequence defaults to 0');

    const tasks = getSliceTasks('M001', 'S01');
    assert.equal(tasks[0]!.sequence, 0, 'task sequence defaults to 0');
  } finally {
    cleanup(base);
  }
});
