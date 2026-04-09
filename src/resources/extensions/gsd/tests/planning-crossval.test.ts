// planning-crossval.test.ts — Cross-validation: DB→render→parse round-trip parity
// Proves R014: DB state matches rendered-then-parsed state during the transition window.
// Each test seeds planning data into DB via insert functions, renders markdown via
// renderers, parses back via existing parsers, and asserts field-by-field parity.

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
} from '../gsd-db.ts';
import {
  renderRoadmapFromDb,
  renderPlanFromDb,
} from '../markdown-renderer.ts';
import { parseRoadmapSlices } from '../roadmap-slices.ts';
import { parsePlan } from '../parsers-legacy.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-planning-crossval-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

/** Scaffold the minimal directory structure the renderers need on disk. */
function scaffoldDirs(base: string, milestoneId: string, sliceIds: string[]): void {
  mkdirSync(join(base, '.gsd', 'milestones', milestoneId), { recursive: true });
  for (const sid of sliceIds) {
    mkdirSync(join(base, '.gsd', 'milestones', milestoneId, 'slices', sid, 'tasks'), { recursive: true });
  }
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: ROADMAP DB→render→parse round-trip parity
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== planning-crossval Test 1: ROADMAP round-trip parity ===');
{
  const base = createFixtureBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  try {
    scaffoldDirs(base, 'M001', ['S01', 'S02', 'S03', 'S04']);

    // Insert milestone
    insertMilestone({
      id: 'M001',
      title: 'Crossval Test Project',
      status: 'active',
      planning: { vision: 'Test round-trip parity.' },
    });

    // Insert 4 slices with varied status, depends, risk, and demo
    const dbSlices = [
      { id: 'S01', title: 'Foundation', status: 'complete', risk: 'low', depends: [] as string[], demo: 'Foundation laid.', sequence: 1 },
      { id: 'S02', title: 'Core Logic', status: 'complete', risk: 'medium', depends: ['S01'], demo: 'Core working.', sequence: 2 },
      { id: 'S03', title: 'Integration', status: 'pending', risk: 'high', depends: ['S01', 'S02'], demo: 'Integrated.', sequence: 3 },
      { id: 'S04', title: 'Polish', status: 'pending', risk: 'low', depends: ['S03'], demo: 'Polished.', sequence: 4 },
    ];

    for (const s of dbSlices) {
      insertSlice({
        id: s.id,
        milestoneId: 'M001',
        title: s.title,
        status: s.status,
        risk: s.risk,
        depends: s.depends,
        demo: s.demo,
        sequence: s.sequence,
      });
    }

    // Render ROADMAP.md from DB
    const rendered = await renderRoadmapFromDb(base, 'M001');
    const content = readFileSync(rendered.roadmapPath, 'utf-8');

    // Parse back
    const parsedSlices = parseRoadmapSlices(content);

    // Assert slice count
    assertEq(parsedSlices.length, dbSlices.length, 'T1: slice count matches');

    // Assert field parity for each slice
    for (let i = 0; i < dbSlices.length; i++) {
      const db = dbSlices[i];
      const parsed = parsedSlices[i];
      assertEq(parsed.id, db.id, `T1: slice[${i}].id`);
      assertEq(parsed.title, db.title, `T1: slice[${i}].title`);
      assertEq(parsed.done, db.status === 'complete', `T1: slice[${i}].done matches status`);
      assertEq(parsed.risk, db.risk, `T1: slice[${i}].risk`);
      assertEq(JSON.stringify(parsed.depends), JSON.stringify(db.depends), `T1: slice[${i}].depends`);
    }
  } finally {
    closeDatabase();
    cleanup(base);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: PLAN DB→render→parse round-trip parity
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== planning-crossval Test 2: PLAN round-trip parity ===');
{
  const base = createFixtureBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  try {
    scaffoldDirs(base, 'M001', ['S01']);

    insertMilestone({
      id: 'M001',
      title: 'Plan Crossval',
      status: 'active',
      planning: { vision: 'Test plan round-trip.' },
    });

    insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Core Slice',
      status: 'pending',
      demo: 'Core working.',
      planning: {
        goal: 'Build the core feature.',
        successCriteria: '- Tests pass\n- Coverage above 80%',
      },
    });

    // Insert 3 tasks with planning fields populated
    const dbTasks = [
      {
        id: 'T01',
        title: 'Setup types',
        status: 'complete',
        description: 'Define TypeScript interfaces for all domain types.',
        files: ['src/types.ts', 'src/interfaces.ts'],
        verify: 'node --test types.test.ts',
        estimate: '30m',
        sequence: 1,
      },
      {
        id: 'T02',
        title: 'Implement logic',
        status: 'pending',
        description: 'Build the core business logic module.',
        files: ['src/logic.ts'],
        verify: 'node --test logic.test.ts',
        estimate: '1h',
        sequence: 2,
      },
      {
        id: 'T03',
        title: 'Write tests',
        status: 'pending',
        description: 'Create comprehensive test coverage.',
        files: ['src/tests/core.test.ts', 'src/tests/edge.test.ts'],
        verify: 'npm test',
        estimate: '45m',
        sequence: 3,
      },
    ];

    for (const t of dbTasks) {
      insertTask({
        id: t.id,
        sliceId: 'S01',
        milestoneId: 'M001',
        title: t.title,
        status: t.status,
        sequence: t.sequence,
        planning: {
          description: t.description,
          files: t.files,
          verify: t.verify,
          estimate: t.estimate,
        },
      });
    }

    // Render PLAN from DB
    const rendered = await renderPlanFromDb(base, 'M001', 'S01');
    const content = readFileSync(rendered.planPath, 'utf-8');

    // Parse back
    const parsedPlan = parsePlan(content);

    // Assert task count
    assertEq(parsedPlan.tasks.length, 3, 'T2: task count matches');

    // Assert field parity for each task
    for (let i = 0; i < dbTasks.length; i++) {
      const db = dbTasks[i];
      const parsed = parsedPlan.tasks[i];
      assertEq(parsed.id, db.id, `T2: task[${i}].id`);
      assertEq(parsed.title, db.title, `T2: task[${i}].title`);
      assertEq(parsed.verify, db.verify, `T2: task[${i}].verify`);
      assertEq(parsed.done, db.status === 'complete', `T2: task[${i}].done matches status`);
    }

    // Assert filesLikelyTouched contains all files from all tasks
    const allFiles = dbTasks.flatMap(t => t.files);
    for (const file of allFiles) {
      assertTrue(
        parsedPlan.filesLikelyTouched.includes(file),
        `T2: filesLikelyTouched contains ${file}`,
      );
    }

    // Assert task order matches sequence ordering (T01, T02, T03)
    assertEq(parsedPlan.tasks[0].id, 'T01', 'T2: first task is T01 (sequence 1)');
    assertEq(parsedPlan.tasks[1].id, 'T02', 'T2: second task is T02 (sequence 2)');
    assertEq(parsedPlan.tasks[2].id, 'T03', 'T2: third task is T03 (sequence 3)');

    // Assert task files preserved
    assertEq(
      JSON.stringify(parsedPlan.tasks[0].files),
      JSON.stringify(dbTasks[0].files),
      'T2: task[0].files match DB',
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: Sequence ordering parity — non-sequential insertion order
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== planning-crossval Test 3: Sequence ordering parity ===');
{
  const base = createFixtureBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  try {
    scaffoldDirs(base, 'M001', ['S01', 'S02', 'S03', 'S04']);

    insertMilestone({
      id: 'M001',
      title: 'Sequence Test',
      status: 'active',
      planning: { vision: 'Test sequence ordering.' },
    });

    // Insert slices in scrambled order with explicit sequence values
    // Insertion order: S03(seq=3), S01(seq=1), S04(seq=4), S02(seq=2)
    // Expected render/parse order: S01, S02, S03, S04 (by sequence)
    insertSlice({ id: 'S03', milestoneId: 'M001', title: 'Third', status: 'pending', risk: 'low', demo: 'Third done.', sequence: 3 });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First', status: 'complete', risk: 'low', demo: 'First done.', sequence: 1 });
    insertSlice({ id: 'S04', milestoneId: 'M001', title: 'Fourth', status: 'pending', risk: 'high', demo: 'Fourth done.', sequence: 4 });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second', status: 'complete', risk: 'medium', demo: 'Second done.', sequence: 2 });

    // Verify DB query returns sequence-ordered results
    const dbSlices = getMilestoneSlices('M001');
    assertEq(dbSlices.length, 4, 'T3: DB returns 4 slices');
    assertEq(dbSlices[0].id, 'S01', 'T3: DB first slice is S01 (sequence 1)');
    assertEq(dbSlices[1].id, 'S02', 'T3: DB second slice is S02 (sequence 2)');
    assertEq(dbSlices[2].id, 'S03', 'T3: DB third slice is S03 (sequence 3)');
    assertEq(dbSlices[3].id, 'S04', 'T3: DB fourth slice is S04 (sequence 4)');

    // Render ROADMAP from DB — should produce slices in sequence order
    const rendered = await renderRoadmapFromDb(base, 'M001');
    const content = readFileSync(rendered.roadmapPath, 'utf-8');

    // Parse back
    const parsedSlices = parseRoadmapSlices(content);

    // Assert parsed order matches sequence order, NOT insertion order
    assertEq(parsedSlices.length, 4, 'T3: parsed 4 slices');
    assertEq(parsedSlices[0].id, 'S01', 'T3: parsed first slice is S01 (sequence 1)');
    assertEq(parsedSlices[1].id, 'S02', 'T3: parsed second slice is S02 (sequence 2)');
    assertEq(parsedSlices[2].id, 'S03', 'T3: parsed third slice is S03 (sequence 3)');
    assertEq(parsedSlices[3].id, 'S04', 'T3: parsed fourth slice is S04 (sequence 4)');

    // Assert full parity through DB→render→parse round-trip
    for (let i = 0; i < 4; i++) {
      assertEq(parsedSlices[i].id, dbSlices[i].id, `T3: round-trip slice[${i}].id`);
      assertEq(parsedSlices[i].done, dbSlices[i].status === 'complete', `T3: round-trip slice[${i}].done`);
      assertEq(parsedSlices[i].title, dbSlices[i].title, `T3: round-trip slice[${i}].title`);
    }
  } finally {
    closeDatabase();
    cleanup(base);
  }
}

report();
