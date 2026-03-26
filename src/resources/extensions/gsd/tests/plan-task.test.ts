import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, getTask } from '../gsd-db.ts';
import { handlePlanTask } from '../tools/plan-task.ts';
import { parseTaskPlanFile } from '../files.ts';

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-plan-task-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'tasks'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedParent(): void {
  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.' });
}

function validParams() {
  return {
    milestoneId: 'M001',
    sliceId: 'S02',
    taskId: 'T02',
    title: 'Write task handler',
    description: 'Implement the DB-backed task planning handler.',
    estimate: '30m',
    files: ['src/resources/extensions/gsd/tools/plan-task.ts'],
    verify: 'node --test src/resources/extensions/gsd/tests/plan-task.test.ts',
    inputs: ['src/resources/extensions/gsd/tools/plan-task.ts'],
    expectedOutput: ['src/resources/extensions/gsd/tests/plan-task.test.ts'],
    observabilityImpact: 'Tests exercise validation, render failure, and cache refresh behavior.',
  };
}

test('handlePlanTask writes planning state and renders task plan', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const task = getTask('M001', 'S02', 'T02');
    assert.ok(task);
    assert.equal(task?.title, 'Write task handler');
    assert.equal(task?.description, 'Implement the DB-backed task planning handler.');
    assert.equal(task?.estimate, '30m');

    const taskPlanPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'tasks', 'T02-PLAN.md');
    assert.ok(existsSync(taskPlanPath), 'task plan should be rendered to disk');
    const taskPlan = parseTaskPlanFile(readFileSync(taskPlanPath, 'utf-8'));
    assert.equal(taskPlan.frontmatter.estimated_files, 1);
    assert.deepEqual(taskPlan.frontmatter.skills_used, []);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects invalid payloads', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({ ...validParams(), files: [''] }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: files must contain only non-empty strings/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects missing parent slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    const result = await handlePlanTask(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /missing parent slice: M001\/S02/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask surfaces render failures without changing parse-visible task plan state', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    insertTask({ id: 'T02', sliceId: 'S02', milestoneId: 'M001', title: 'Cached task', status: 'pending' });
    const taskPlanPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'tasks', 'T02-PLAN.md');
    writeFileSync(taskPlanPath, '---\nestimated_steps: 1\nestimated_files: 1\nskills_used: []\n---\n\n# T02: Cached task\n', 'utf-8');
    rmSync(taskPlanPath, { force: true });
    mkdirSync(taskPlanPath, { recursive: true });

    const result = await handlePlanTask(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /render failed:/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask reruns idempotently and refreshes parse-visible state', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const taskPlanPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'tasks', 'T02-PLAN.md');
    writeFileSync(taskPlanPath, '---\nestimated_steps: 1\nestimated_files: 1\nskills_used: []\n---\n\n# T02: Cached task\n', 'utf-8');

    const first = await handlePlanTask(validParams(), base);
    assert.ok(!('error' in first));

    const second = await handlePlanTask({
      ...validParams(),
      description: 'Updated task handler description.',
      estimate: '1h',
    }, base);
    assert.ok(!('error' in second));

    const task = getTask('M001', 'S02', 'T02');
    assert.equal(task?.description, 'Updated task handler description.');
    assert.equal(task?.estimate, '1h');

    const parsed = parseTaskPlanFile(readFileSync(taskPlanPath, 'utf-8'));
    assert.equal(parsed.frontmatter.estimated_steps, 1);
    assert.match(readFileSync(taskPlanPath, 'utf-8'), /Updated task handler description\./);
  } finally {
    cleanup(base);
  }
});
