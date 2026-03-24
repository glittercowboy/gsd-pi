// migrate-hierarchy.test.ts — Tests for migrateHierarchyToDb()
// Verifies that the markdown → DB hierarchy migration populates
// milestones, slices, and tasks tables correctly.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  getAllMilestones,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  getActiveMilestoneFromDb,
  getActiveSliceFromDb,
  getActiveTaskFromDb,
} from '../gsd-db.ts';
import { migrateHierarchyToDb } from '../md-importer.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-migrate-hier-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, '.gsd', relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ─── Fixture Content ──────────────────────────────────────────────────────

const ROADMAP_2_SLICES = `# M001: Test Milestone

**Vision:** Testing hierarchy migration.

## Slices

- [ ] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: First slice done.

- [ ] **S02: Second Slice** \`risk:high\` \`depends:[S01]\`
  > After this: All slices done.
`;

const PLAN_S01_3_TASKS = `---
estimated_steps: 3
estimated_files: 2
skills_used: []
---

# S01: First Slice

**Goal:** Test tasks.
**Demo:** Tasks pass.

## Must-Haves

- Task T01 works
- Task T02 works

## Tasks

- [ ] **T01: First Task** \`est:30m\`
  First task description.

- [x] **T02: Second Task** \`est:15m\`
  Already completed task.

- [ ] **T03: Third Task** \`est:1h\`
  Third task description.
`;

const PLAN_S02_1_TASK = `# S02: Second Slice

**Goal:** Test second slice.
**Demo:** S02 works.

## Tasks

- [ ] **T01: Only Task** \`est:20m\`
  The only task in S02.
`;

// ═══════════════════════════════════════════════════════════════════════════
// Test Cases
// ═══════════════════════════════════════════════════════════════════════════

  // ─── Test (a): Single milestone with 2 slices, 3 tasks ────────────────

test('migrate-hier: single milestone with 2 slices, 3 tasks', () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_2_SLICES);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_S01_3_TASKS);
      writeFile(base, 'milestones/M001/slices/S02/S02-PLAN.md', PLAN_S02_1_TASK);

      openDatabase(':memory:');
      const counts = migrateHierarchyToDb(base);

      assert.deepStrictEqual(counts.milestones, 1, 'single-ms: 1 milestone inserted');
      assert.deepStrictEqual(counts.slices, 2, 'single-ms: 2 slices inserted');
      assert.deepStrictEqual(counts.tasks, 4, 'single-ms: 4 tasks inserted (3 + 1)');

      const milestones = getAllMilestones();
      assert.deepStrictEqual(milestones.length, 1, 'single-ms: 1 milestone in DB');
      assert.deepStrictEqual(milestones[0]!.id, 'M001', 'single-ms: milestone ID is M001');
      assert.deepStrictEqual(milestones[0]!.title, 'M001: Test Milestone', 'single-ms: milestone title correct');
      assert.deepStrictEqual(milestones[0]!.status, 'active', 'single-ms: milestone status is active');

      const slices = getMilestoneSlices('M001');
      assert.deepStrictEqual(slices.length, 2, 'single-ms: 2 slices in DB');
      assert.deepStrictEqual(slices[0]!.id, 'S01', 'single-ms: first slice is S01');
      assert.deepStrictEqual(slices[0]!.title, 'First Slice', 'single-ms: S01 title correct');
      assert.deepStrictEqual(slices[0]!.risk, 'low', 'single-ms: S01 risk is low');
      assert.deepStrictEqual(slices[0]!.status, 'pending', 'single-ms: S01 status is pending');
      assert.deepStrictEqual(slices[1]!.id, 'S02', 'single-ms: second slice is S02');
      assert.deepStrictEqual(slices[1]!.risk, 'high', 'single-ms: S02 risk is high');

      const s01Tasks = getSliceTasks('M001', 'S01');
      assert.deepStrictEqual(s01Tasks.length, 3, 'single-ms: 3 tasks for S01');
      assert.deepStrictEqual(s01Tasks[0]!.id, 'T01', 'single-ms: first task is T01');
      assert.deepStrictEqual(s01Tasks[0]!.title, 'First Task', 'single-ms: T01 title correct');
      assert.deepStrictEqual(s01Tasks[0]!.status, 'pending', 'single-ms: T01 status is pending');
      assert.deepStrictEqual(s01Tasks[1]!.id, 'T02', 'single-ms: second task is T02');
      assert.deepStrictEqual(s01Tasks[1]!.status, 'complete', 'single-ms: T02 status is complete (was [x])');
      assert.deepStrictEqual(s01Tasks[2]!.id, 'T03', 'single-ms: third task is T03');

      const s02Tasks = getSliceTasks('M001', 'S02');
      assert.deepStrictEqual(s02Tasks.length, 1, 'single-ms: 1 task for S02');
      assert.deepStrictEqual(s02Tasks[0]!.id, 'T01', 'single-ms: S02 T01 correct');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
});

  // ─── Test (b): Multi-milestone — M001 complete, M002 active with deps ─

test('migrate-hier: multi-milestone with deps', () => {
    const base = createFixtureBase();
    try {
      // M001: complete (has SUMMARY)
      const m001Roadmap = `# M001: First Done

**Vision:** Already completed.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', m001Roadmap);
      writeFile(base, 'milestones/M001/M001-SUMMARY.md', '# M001 Summary\n\nComplete.');

      // M002: active with depends_on M001
      const m002Context = `---
depends_on:
  - M001
---

# M002: Second Milestone

Depends on M001 completion.
`;
      const m002Roadmap = `# M002: Second Milestone

**Vision:** Active milestone.

## Slices

- [ ] **S01: Active Slice** \`risk:medium\` \`depends:[]\`
  > After this: In progress.

- [ ] **S02: Blocked Slice** \`risk:low\` \`depends:[S01]\`
  > After this: Second done.
`;
      writeFile(base, 'milestones/M002/M002-CONTEXT.md', m002Context);
      writeFile(base, 'milestones/M002/M002-ROADMAP.md', m002Roadmap);

      openDatabase(':memory:');
      const counts = migrateHierarchyToDb(base);

      assert.deepStrictEqual(counts.milestones, 2, 'multi-ms: 2 milestones inserted');

      const m001 = getMilestone('M001');
      assert.ok(m001 !== null, 'multi-ms: M001 exists');
      assert.deepStrictEqual(m001!.status, 'complete', 'multi-ms: M001 is complete');

      const m002 = getMilestone('M002');
      assert.ok(m002 !== null, 'multi-ms: M002 exists');
      assert.deepStrictEqual(m002!.status, 'active', 'multi-ms: M002 is active');
      assert.deepStrictEqual(m002!.depends_on, ['M001'], 'multi-ms: M002 depends on M001');

      // Active milestone should be M002
      const active = getActiveMilestoneFromDb();
      assert.deepStrictEqual(active?.id, 'M002', 'multi-ms: active milestone is M002');

      // Active slice in M002 should be S01 (S02 depends on S01)
      const activeSlice = getActiveSliceFromDb('M002');
      assert.deepStrictEqual(activeSlice?.id, 'S01', 'multi-ms: active slice is S01');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
});

  // ─── Test (c): Partially-completed slice — some tasks [x], some [ ] ───

test('migrate-hier: partially-completed slice', () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Partial

**Vision:** Testing partial.

## Slices

- [ ] **S01: Mixed Slice** \`risk:low\` \`depends:[]\`
  > After this: Partial.
`;
      const plan = `# S01: Mixed Slice

**Goal:** Test partial.
**Demo:** Partial.

## Tasks

- [x] **T01: Done** \`est:10m\`
  Done task.

- [x] **T02: Also Done** \`est:10m\`
  Also done.

- [ ] **T03: Not Done** \`est:10m\`
  Still pending.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', roadmap);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', plan);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      const tasks = getSliceTasks('M001', 'S01');
      assert.deepStrictEqual(tasks.length, 3, 'partial: 3 tasks');
      assert.deepStrictEqual(tasks[0]!.status, 'complete', 'partial: T01 is complete');
      assert.deepStrictEqual(tasks[1]!.status, 'complete', 'partial: T02 is complete');
      assert.deepStrictEqual(tasks[2]!.status, 'pending', 'partial: T03 is pending');

      // Active task should be T03
      const activeTask = getActiveTaskFromDb('M001', 'S01');
      assert.deepStrictEqual(activeTask?.id, 'T03', 'partial: active task is T03');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
});

  // ─── Test (d): Ghost milestone skipped ────────────────────────────────

test('migrate-hier: ghost milestone skipped', () => {
    const base = createFixtureBase();
    try {
      // M001: real milestone
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_2_SLICES);
      // M002: ghost — just an empty dir (no CONTEXT, ROADMAP, or SUMMARY)
      mkdirSync(join(base, '.gsd', 'milestones', 'M002'), { recursive: true });

      openDatabase(':memory:');
      const counts = migrateHierarchyToDb(base);

      assert.deepStrictEqual(counts.milestones, 1, 'ghost: only 1 milestone inserted');
      const milestones = getAllMilestones();
      assert.deepStrictEqual(milestones.length, 1, 'ghost: 1 milestone in DB');
      assert.deepStrictEqual(milestones[0]!.id, 'M001', 'ghost: only M001 in DB');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
});

  // ─── Test (e): Idempotent re-run — calling twice doesn't duplicate ────

test('migrate-hier: idempotent re-run', () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_2_SLICES);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_S01_3_TASKS);

      openDatabase(':memory:');

      // First run
      const counts1 = migrateHierarchyToDb(base);
      assert.deepStrictEqual(counts1.milestones, 1, 'idempotent-1: 1 milestone first run');
      assert.deepStrictEqual(counts1.slices, 2, 'idempotent-1: 2 slices first run');
      assert.deepStrictEqual(counts1.tasks, 3, 'idempotent-1: 3 tasks first run');

      // Second run — INSERT OR IGNORE means no duplicates
      const counts2 = migrateHierarchyToDb(base);
      // Counts reflect attempts, not actual inserts (INSERT OR IGNORE silently skips)
      // The important thing: DB doesn't have duplicates
      const milestones = getAllMilestones();
      assert.deepStrictEqual(milestones.length, 1, 'idempotent-2: still 1 milestone after second run');
      const slices = getMilestoneSlices('M001');
      assert.deepStrictEqual(slices.length, 2, 'idempotent-2: still 2 slices after second run');
      const tasks = getSliceTasks('M001', 'S01');
      assert.deepStrictEqual(tasks.length, 3, 'idempotent-2: still 3 tasks for S01 after second run');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
});

  // ─── Test (f): Empty roadmap — milestone inserted but no slices ───────

test('migrate-hier: empty roadmap, no slices', () => {
    const base = createFixtureBase();
    try {
      const emptyRoadmap = `# M001: Empty Milestone

**Vision:** No slices here.

## Slices

(No slices defined yet)
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', emptyRoadmap);

      openDatabase(':memory:');
      const counts = migrateHierarchyToDb(base);

      assert.deepStrictEqual(counts.milestones, 1, 'empty-roadmap: 1 milestone inserted');
      assert.deepStrictEqual(counts.slices, 0, 'empty-roadmap: 0 slices inserted');
      assert.deepStrictEqual(counts.tasks, 0, 'empty-roadmap: 0 tasks inserted');

      const milestones = getAllMilestones();
      assert.deepStrictEqual(milestones.length, 1, 'empty-roadmap: 1 milestone in DB');
      assert.deepStrictEqual(milestones[0]!.title, 'M001: Empty Milestone', 'empty-roadmap: title correct');

      const slices = getMilestoneSlices('M001');
      assert.deepStrictEqual(slices.length, 0, 'empty-roadmap: no slices in DB');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
});

  // ─── Test (g): Slice depends parsed correctly ─────────────────────────

test('migrate-hier: slice depends parsed', () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Deps Test

**Vision:** Testing deps.

## Slices

- [ ] **S01: No Deps** \`risk:low\` \`depends:[]\`
  > After this: S01 done.

- [ ] **S02: Depends on S01** \`risk:medium\` \`depends:[S01]\`
  > After this: S02 done.

- [ ] **S03: Multi-Dep** \`risk:high\` \`depends:[S01,S02]\`
  > After this: All done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', roadmap);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      const slices = getMilestoneSlices('M001');
      assert.deepStrictEqual(slices.length, 3, 'depends: 3 slices');
      assert.deepStrictEqual(slices[0]!.depends, [], 'depends: S01 has no deps');
      assert.deepStrictEqual(slices[1]!.depends, ['S01'], 'depends: S02 depends on S01');
      assert.deepStrictEqual(slices[2]!.depends, ['S01', 'S02'], 'depends: S03 depends on S01,S02');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
});

  // ─── Test (h): Demo text extracted from roadmap ───────────────────────

test('migrate-hier: demo text extracted', () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_2_SLICES);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      const slices = getMilestoneSlices('M001');
      assert.deepStrictEqual(slices[0]!.demo, 'First slice done.', 'demo: S01 demo text correct');
      assert.deepStrictEqual(slices[1]!.demo, 'All slices done.', 'demo: S02 demo text correct');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
});

