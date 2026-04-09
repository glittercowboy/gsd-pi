import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// gsd-recover.test.ts — Tests for the `gsd recover` recovery logic.
// Verifies: populate DB → clear hierarchy → recover from markdown → state matches.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  transaction,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  _getAdapter,
  insertMilestone,
  insertSlice,
  insertTask,
  getMilestone,
  getSlice,
  getTask,
} from '../gsd-db.ts';
import { migrateHierarchyToDb } from '../md-importer.ts';
import { deriveStateFromDb, invalidateStateCache } from '../state.ts';
// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-recover-'));
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

const ROADMAP_M001 = `# M001: Recovery Test

**Vision:** Test recovery round-trip.

## Success Criteria

- All recovery tests pass
- State matches after round-trip


## Slices

- [x] **S01: Setup** \`risk:low\` \`depends:[]\`
  > After this: Setup complete.

- [ ] **S02: Core** \`risk:medium\` \`depends:[S01]\`
  > After this: Core done.

## Boundary Map

| From | To | Produces | Consumes |
|------|-----|----------|----------|
| S01 | S02 | setup artifacts | setup artifacts |
`;

const PLAN_S01_COMPLETE = `---
estimated_steps: 2
estimated_files: 1
skills_used: []
---

# S01: Setup

**Goal:** Setup fixtures.
**Demo:** Tasks done.

## Tasks

- [x] **T01: Init** \`est:15m\`
  Initialize things.
  - Files: \`init.ts\`, \`config.ts\`
  - Verify: \`node test-init.ts\`

- [x] **T02: Config** \`est:10m\`
  Configure things.
  - Files: \`settings.ts\`
  - Verify: \`node test-config.ts\`
`;

const PLAN_S02_PARTIAL = `---
estimated_steps: 1
estimated_files: 1
skills_used: []
---

# S02: Core

**Goal:** Build core.
**Demo:** Core works.

## Tasks

- [x] **T01: Build** \`est:30m\`
  Build it.
  - Files: \`core.ts\`
  - Verify: \`node test-build.ts\`

- [ ] **T02: Test** \`est:20m\`
  Test it.
  - Files: \`test-core.ts\`, \`helpers.ts\`
  - Verify: \`npm test\`

- [ ] **T03: Polish** \`est:15m\`
  Polish it.
  - Files: \`polish.ts\`
  - Verify: \`node test-polish.ts\`
`;

const SUMMARY_S01 = `---
id: S01
parent: M001
milestone: M001
---

# S01: Setup — Summary

Setup is complete.
`;

// ─── Recovery helpers (mirrors gsd recover handler logic) ─────────────────

function clearHierarchyTables(): void {
  const db = _getAdapter()!;
  transaction(() => {
    db.exec("DELETE FROM tasks");
    db.exec("DELETE FROM slices");
    db.exec("DELETE FROM milestones");
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('gsd-recover', async () => {
  test('full round-trip (populate, clear, recover, verify)', async () => {
    const base = createFixtureBase();
    try {
      // Set up markdown fixtures
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_M001);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_S01_COMPLETE);
      writeFile(base, 'milestones/M001/slices/S01/S01-SUMMARY.md', SUMMARY_S01);
      writeFile(base, 'milestones/M001/slices/S02/S02-PLAN.md', PLAN_S02_PARTIAL);

      // Step 1: Open DB and populate from markdown
      openDatabase(':memory:');
      const counts1 = migrateHierarchyToDb(base);
      assert.deepStrictEqual(counts1.milestones, 1, 'round-trip: initial migration - 1 milestone');
      assert.deepStrictEqual(counts1.slices, 2, 'round-trip: initial migration - 2 slices');
      assert.ok(counts1.tasks >= 5, 'round-trip: initial migration - at least 5 tasks');

      // Step 2: Capture state from DB before clearing
      invalidateStateCache();
      const stateBefore = await deriveStateFromDb(base);
      assert.ok(stateBefore.activeMilestone !== null, 'round-trip: state before has active milestone');
      const milestonesBefore = getAllMilestones();
      const slicesBefore = getMilestoneSlices('M001');
      const s01TasksBefore = getSliceTasks('M001', 'S01');
      const s02TasksBefore = getSliceTasks('M001', 'S02');

      // Step 3: Clear hierarchy tables
      clearHierarchyTables();
      const milestonesAfterClear = getAllMilestones();
      assert.deepStrictEqual(milestonesAfterClear.length, 0, 'round-trip: milestones cleared');

      // Step 4: Recover from markdown
      const counts2 = migrateHierarchyToDb(base);
      assert.deepStrictEqual(counts2.milestones, counts1.milestones, 'round-trip: recovery milestone count matches');
      assert.deepStrictEqual(counts2.slices, counts1.slices, 'round-trip: recovery slice count matches');
      assert.deepStrictEqual(counts2.tasks, counts1.tasks, 'round-trip: recovery task count matches');

      // Step 5: Verify state matches
      invalidateStateCache();
      const stateAfter = await deriveStateFromDb(base);

      assert.deepStrictEqual(stateAfter.phase, stateBefore.phase, 'round-trip: phase matches');
      assert.deepStrictEqual(
        stateAfter.activeMilestone?.id,
        stateBefore.activeMilestone?.id,
        'round-trip: active milestone ID matches',
      );
      assert.deepStrictEqual(
        stateAfter.activeSlice?.id,
        stateBefore.activeSlice?.id,
        'round-trip: active slice ID matches',
      );
      assert.deepStrictEqual(
        stateAfter.activeTask?.id,
        stateBefore.activeTask?.id,
        'round-trip: active task ID matches',
      );

      // Verify row-level data matches
      const milestonesAfter = getAllMilestones();
      assert.deepStrictEqual(milestonesAfter.length, milestonesBefore.length, 'round-trip: milestone row count');
      assert.deepStrictEqual(milestonesAfter[0]?.id, milestonesBefore[0]?.id, 'round-trip: milestone ID');
      assert.deepStrictEqual(milestonesAfter[0]?.title, milestonesBefore[0]?.title, 'round-trip: milestone title');

      const slicesAfter = getMilestoneSlices('M001');
      assert.deepStrictEqual(slicesAfter.length, slicesBefore.length, 'round-trip: slice row count');
      assert.deepStrictEqual(slicesAfter[0]?.id, slicesBefore[0]?.id, 'round-trip: S01 ID');
      assert.deepStrictEqual(slicesAfter[0]?.status, slicesBefore[0]?.status, 'round-trip: S01 status');
      assert.deepStrictEqual(slicesAfter[1]?.id, slicesBefore[1]?.id, 'round-trip: S02 ID');

      const s01TasksAfter = getSliceTasks('M001', 'S01');
      assert.deepStrictEqual(s01TasksAfter.length, s01TasksBefore.length, 'round-trip: S01 task count');

      const s02TasksAfter = getSliceTasks('M001', 'S02');
      assert.deepStrictEqual(s02TasksAfter.length, s02TasksBefore.length, 'round-trip: S02 task count');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test('v8 planning columns populated', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_M001);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_S01_COMPLETE);
      writeFile(base, 'milestones/M001/slices/S01/S01-SUMMARY.md', SUMMARY_S01);
      writeFile(base, 'milestones/M001/slices/S02/S02-PLAN.md', PLAN_S02_PARTIAL);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      // Milestone planning columns
      const milestone = getMilestone('M001');
      assert.ok(milestone !== null, 'v8: milestone exists');
      assert.deepStrictEqual(milestone!.vision, 'Test recovery round-trip.', 'v8: milestone vision populated');
      assert.ok(milestone!.success_criteria.length >= 2, 'v8: milestone success_criteria has entries');
      assert.deepStrictEqual(milestone!.success_criteria[0], 'All recovery tests pass', 'v8: first success criterion');
      assert.ok(milestone!.boundary_map_markdown.includes('Boundary Map'), 'v8: boundary_map_markdown populated');
      assert.ok(milestone!.boundary_map_markdown.includes('S01'), 'v8: boundary_map_markdown has S01');

      // Tool-only fields left empty per D004
      assert.deepStrictEqual(milestone!.key_risks.length, 0, 'v8: key_risks left empty (tool-only per D004)');
      assert.deepStrictEqual(milestone!.requirement_coverage, '', 'v8: requirement_coverage left empty (tool-only per D004)');

      // Slice planning columns
      const sliceS01 = getSlice('M001', 'S01');
      assert.ok(sliceS01 !== null, 'v8: slice S01 exists');
      assert.deepStrictEqual(sliceS01!.goal, 'Setup fixtures.', 'v8: S01 goal populated');

      const sliceS02 = getSlice('M001', 'S02');
      assert.ok(sliceS02 !== null, 'v8: slice S02 exists');
      assert.deepStrictEqual(sliceS02!.goal, 'Build core.', 'v8: S02 goal populated');

      // Slice tool-only fields left empty per D004
      assert.deepStrictEqual(sliceS01!.proof_level, '', 'v8: S01 proof_level left empty (tool-only per D004)');

      // Task planning columns - S01/T01
      const taskS01T01 = getTask('M001', 'S01', 'T01');
      assert.ok(taskS01T01 !== null, 'v8: task S01/T01 exists');
      assert.ok(taskS01T01!.files.length >= 2, 'v8: S01/T01 files populated');
      assert.ok(taskS01T01!.files.includes('init.ts'), 'v8: S01/T01 files includes init.ts');
      assert.ok(taskS01T01!.files.includes('config.ts'), 'v8: S01/T01 files includes config.ts');
      assert.deepStrictEqual(taskS01T01!.verify, '`node test-init.ts`', 'v8: S01/T01 verify populated');

      // Task planning columns - S02/T02
      const taskS02T02 = getTask('M001', 'S02', 'T02');
      assert.ok(taskS02T02 !== null, 'v8: task S02/T02 exists');
      assert.ok(taskS02T02!.files.length >= 2, 'v8: S02/T02 files populated');
      assert.ok(taskS02T02!.files.includes('test-core.ts'), 'v8: S02/T02 files includes test-core.ts');
      assert.deepStrictEqual(taskS02T02!.verify, '`npm test`', 'v8: S02/T02 verify populated');

      const taskS02T03 = getTask('M001', 'S02', 'T03');
      assert.ok(taskS02T03 !== null, 'v8: task S02/T03 exists');
      assert.ok(taskS02T03!.files.includes('polish.ts'), 'v8: S02/T03 files includes polish.ts');
      assert.deepStrictEqual(taskS02T03!.verify, '`node test-polish.ts`', 'v8: S02/T03 verify populated');

      // Diagnostic: v8 planning columns queryable via SQL
      const db = _getAdapter()!;
      const milestoneRow = db.prepare("SELECT vision, success_criteria, boundary_map_markdown FROM milestones WHERE id = 'M001'").get() as any;
      assert.ok(milestoneRow.vision.length > 0, 'v8-diag: vision column queryable');
      assert.ok(milestoneRow.boundary_map_markdown.length > 0, 'v8-diag: boundary_map_markdown column queryable');

      const sliceRow = db.prepare("SELECT goal FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").get() as any;
      assert.ok(sliceRow.goal.length > 0, 'v8-diag: goal column queryable');

      const taskRow = db.prepare("SELECT files, verify FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").get() as any;
      assert.ok(taskRow.files.length > 2, 'v8-diag: files column queryable (JSON array)');
      assert.ok(taskRow.verify.length > 0, 'v8-diag: verify column queryable');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test('idempotent - double recovery produces same state', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_M001);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_S01_COMPLETE);
      writeFile(base, 'milestones/M001/slices/S01/S01-SUMMARY.md', SUMMARY_S01);
      writeFile(base, 'milestones/M001/slices/S02/S02-PLAN.md', PLAN_S02_PARTIAL);

      openDatabase(':memory:');

      // First recovery
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const state1 = await deriveStateFromDb(base);

      // Clear and recover again
      clearHierarchyTables();
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const state2 = await deriveStateFromDb(base);

      assert.deepStrictEqual(state2.phase, state1.phase, 'idempotent: phase matches');
      assert.deepStrictEqual(
        state2.activeMilestone?.id,
        state1.activeMilestone?.id,
        'idempotent: active milestone matches',
      );
      assert.deepStrictEqual(
        state2.activeSlice?.id,
        state1.activeSlice?.id,
        'idempotent: active slice matches',
      );
      assert.deepStrictEqual(
        state2.activeTask?.id,
        state1.activeTask?.id,
        'idempotent: active task matches',
      );

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test('preserves decisions/requirements', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_M001);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_S01_COMPLETE);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      // Insert a decision and requirement manually
      const db = _getAdapter()!;
      db.prepare(
        `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable)
         VALUES (:id, :when, :scope, :decision, :choice, :rationale, :revisable)`,
      ).run({
        ':id': 'D001',
        ':when': 'T03',
        ':scope': 'architecture',
        ':decision': 'Use shared WAL',
        ':choice': 'Single DB',
        ':rationale': 'Simpler',
        ':revisable': 'Yes',
      });

      db.prepare(
        `INSERT INTO requirements (id, class, status, description)
         VALUES (:id, :class, :status, :desc)`,
      ).run({
        ':id': 'R001',
        ':class': 'functional',
        ':status': 'active',
        ':desc': 'Recovery works',
      });

      // Clear hierarchy only
      clearHierarchyTables();

      // Verify decisions and requirements survived
      const decisions = db.prepare('SELECT * FROM decisions').all();
      assert.deepStrictEqual(decisions.length, 1, 'preserve: decision survives clear');
      assert.deepStrictEqual((decisions[0] as any).id, 'D001', 'preserve: decision ID intact');

      const requirements = db.prepare('SELECT * FROM requirements').all();
      assert.deepStrictEqual(requirements.length, 1, 'preserve: requirement survives clear');
      assert.deepStrictEqual((requirements[0] as any).id, 'R001', 'preserve: requirement ID intact');

      // Recover hierarchy
      migrateHierarchyToDb(base);
      const milestones = getAllMilestones();
      assert.ok(milestones.length > 0, 'preserve: milestones recovered after clear');

      // Verify non-hierarchy data still intact after recovery
      const decisionsAfter = db.prepare('SELECT * FROM decisions').all();
      assert.deepStrictEqual(decisionsAfter.length, 1, 'preserve: decision still present after recovery');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test('empty milestones dir', async () => {
    const base = createFixtureBase();
    try {
      // No milestones written - just the empty dir
      openDatabase(':memory:');

      // Pre-populate to simulate existing state
      insertMilestone({ id: 'M001', title: 'Ghost', status: 'active' });

      // Clear and recover from empty
      clearHierarchyTables();
      const counts = migrateHierarchyToDb(base);
      assert.deepStrictEqual(counts.milestones, 0, 'empty: zero milestones recovered');
      assert.deepStrictEqual(counts.slices, 0, 'empty: zero slices recovered');
      assert.deepStrictEqual(counts.tasks, 0, 'empty: zero tasks recovered');

      const all = getAllMilestones();
      assert.deepStrictEqual(all.length, 0, 'empty: no milestones in DB after recovery');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
