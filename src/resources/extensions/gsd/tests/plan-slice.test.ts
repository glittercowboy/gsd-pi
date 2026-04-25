import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase, insertMilestone, insertSlice, getSlice, getSliceTasks, getTask } from '../gsd-db.ts';
import { handlePlanSlice } from '../tools/plan-slice.ts';
import { parsePlan } from '../parsers-legacy.ts';
import { parseTaskPlanFile } from '../files.ts';

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-plan-slice-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'tasks'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedParentSlice(): void {
  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.' });
}

function validParams() {
  return {
    milestoneId: 'M001',
    sliceId: 'S02',
    goal: 'Persist slice planning through the DB.',
    successCriteria: '- Slice plan renders from DB\n- Task plan files are regenerated',
    proofLevel: 'integration',
    integrationClosure: 'Planning handlers now write DB rows and render plan artifacts.',
    observabilityImpact: '- Validation failures return structured errors\n- Cache invalidation is proven by parse-visible state updates',
    tasks: [
      {
        taskId: 'T01',
        title: 'Write slice handler',
        description: 'Implement the slice planning handler.',
        estimate: '45m',
        files: ['src/resources/extensions/gsd/tools/plan-slice.ts'],
        verify: 'node --test src/resources/extensions/gsd/tests/plan-slice.test.ts',
        inputs: ['src/resources/extensions/gsd/tools/plan-milestone.ts'],
        expectedOutput: ['src/resources/extensions/gsd/tools/plan-slice.ts'],
        observabilityImpact: 'Tests exercise cache invalidation and render failure paths.',
      },
      {
        taskId: 'T02',
        title: 'Write task handler',
        description: 'Implement the task planning handler.',
        estimate: '30m',
        files: ['src/resources/extensions/gsd/tools/plan-task.ts'],
        verify: 'node --test src/resources/extensions/gsd/tests/plan-task.test.ts',
        inputs: ['src/resources/extensions/gsd/tools/plan-task.ts'],
        expectedOutput: ['src/resources/extensions/gsd/tests/plan-task.test.ts'],
        observabilityImpact: 'Task-plan renders remain parse-compatible.',
      },
    ],
  };
}

test('handlePlanSlice writes slice/task planning state and renders plan artifacts', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();

    const result = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const slice = getSlice('M001', 'S02');
    assert.ok(slice);
    assert.equal(slice?.goal, 'Persist slice planning through the DB.');
    assert.equal(slice?.proof_level, 'integration');

    const tasks = getSliceTasks('M001', 'S02');
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]?.title, 'Write slice handler');
    assert.equal(tasks[0]?.description, 'Implement the slice planning handler.');
    assert.equal(tasks[1]?.estimate, '30m');

    const planPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'S02-PLAN.md');
    assert.ok(existsSync(planPath), 'slice plan should be rendered to disk');
    const parsedPlan = parsePlan(readFileSync(planPath, 'utf-8'));
    assert.equal(parsedPlan.goal, 'Persist slice planning through the DB.');
    assert.equal(parsedPlan.tasks.length, 2);
    assert.equal(parsedPlan.tasks[0]?.id, 'T01');

    const taskPlanPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'tasks', 'T01-PLAN.md');
    assert.ok(existsSync(taskPlanPath), 'task plan should be rendered to disk');
    const taskPlan = parseTaskPlanFile(readFileSync(taskPlanPath, 'utf-8'));
    assert.deepEqual(taskPlan.frontmatter.skills_used, []);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects invalid payloads', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const result = await handlePlanSlice({ ...validParams(), tasks: [] }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: tasks must be a non-empty array/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects missing parent slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    const result = await handlePlanSlice(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /missing parent slice: M001\/S02/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice surfaces render failures without changing parse-visible task-plan state for the failing task', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const failingTaskPlanPath = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'tasks', 'T01-PLAN.md');
    writeFileSync(failingTaskPlanPath, '---\nestimated_steps: 1\nestimated_files: 1\nskills_used: []\n---\n\n# T01: Cached task\n', 'utf-8');
    rmSync(failingTaskPlanPath, { force: true });
    mkdirSync(failingTaskPlanPath, { recursive: true });

    const result = await handlePlanSlice(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /render failed:/);

    assert.ok(existsSync(failingTaskPlanPath), 'failing task plan path should remain the blocking directory');
    assert.equal(getTask('M001', 'S02', 'T01')?.description, 'Implement the slice planning handler.');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice reactivates a deferred parent slice to pending', async (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'deferred', demo: 'Rendered plans exist.' });

  const result = await handlePlanSlice(validParams(), base);
  assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

  const slice = getSlice('M001', 'S02');
  assert.ok(slice);
  assert.equal(slice?.status, 'pending', 'deferred slice must be reactivated to pending so auto-mode can dispatch it');
  assert.equal(slice?.goal, 'Persist slice planning through the DB.');
});

test('handlePlanSlice reruns idempotently and refreshes parse-visible state', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    writeFileSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'S02-PLAN.md'), '# S02: Cached\n\n**Goal:** old value\n\n## Tasks\n\n- [ ] **T01: Cached task**\n', 'utf-8');

    const first = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in first));

    const second = await handlePlanSlice({
      ...validParams(),
      goal: 'Updated goal from rerun.',
      tasks: [
        { ...validParams().tasks[0], description: 'Updated slice handler description.' },
        validParams().tasks[1],
      ],
    }, base);
    assert.ok(!('error' in second));

    const parsedAfter = parsePlan(readFileSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'S02-PLAN.md'), 'utf-8'));
    assert.equal(parsedAfter.goal, 'Updated goal from rerun.');
    const task = getTask('M001', 'S02', 'T01');
    assert.equal(task?.description, 'Updated slice handler description.');
  } finally {
    cleanup(base);
  }
});
