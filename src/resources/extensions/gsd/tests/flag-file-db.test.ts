import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
/**
 * flag-file-db.test.ts — Verify that REPLAN.md and REPLAN-TRIGGER.md
 * flag-file detection in deriveStateFromDb() works from DB-only data
 * (no disk flag files needed when DB is seeded).
 *
 * Semantics:
 *   - blocker_discovered on a completed task → replanning-slice (unless loop-protected)
 *   - replan_triggered_at column on slice → replanning-slice (unless loop-protected)
 *   - Loop protection: replan_history entries for the slice → skip replanning
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveStateFromDb, invalidateStateCache } from '../state.ts';
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertMilestone,
  insertSlice,
  insertTask,
  insertReplanHistory,
  _getAdapter,
} from '../gsd-db.ts';
// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-flag-file-db-'));
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

const ROADMAP_CONTENT = `# M001: Flag-File DB Test

**Vision:** Test flag-file detection via DB.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: done.
`;

const PLAN_CONTENT = `# S01: Test Slice

**Goal:** Test replanning detection.
**Demo:** Tests pass.

## Tasks

- [x] **T01: Done Task** \`est:10m\`
  Already done.

- [ ] **T02: Active Task** \`est:10m\`
  Current task.
`;

// Minimal task plan file content — deriveStateFromDb checks the tasks dir has .md files
const TASK_PLAN_STUB = `# T02: Active Task\n\nDo stuff.\n`;
const TASK_SUMMARY_STUB = `---\nblocker_discovered: false\n---\n# T01 Summary\nDone.\n`;

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('flag-file-db', async () => {

  // ─── Test 1: blocker_discovered + no replan_history → replanning-slice ──
  test('flag-file-db: blocker + no history → replanning', async () => {
    const base = createFixtureBase();
    try {
      // Write disk files needed by deriveStateFromDb (roadmap check, task dir check)
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/T02-PLAN.md', TASK_PLAN_STUB);

      openDatabase(':memory:');
      assert.ok(isDbAvailable(), 'test1: DB is available');

      insertMilestone({ id: 'M001', title: 'Flag-File DB Test', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'active', risk: 'low', depends: [] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete', blockerDiscovered: true });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Active Task', status: 'pending' });

      // No replan_history entries, no disk REPLAN.md — should trigger replanning
      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.deepStrictEqual(state.phase, 'replanning-slice', 'test1: phase is replanning-slice');
      assert.ok(state.blockers.length > 0, 'test1: has blockers');
      assert.ok(state.blockers[0]?.includes('blocker'), 'test1: blocker message mentions blocker');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 2: blocker_discovered + replan_history exists → loop protection → executing ──
  test('flag-file-db: blocker + history → loop protection', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/T02-PLAN.md', TASK_PLAN_STUB);

      openDatabase(':memory:');

      insertMilestone({ id: 'M001', title: 'Flag-File DB Test', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'active', risk: 'low', depends: [] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete', blockerDiscovered: true });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Active Task', status: 'pending' });

      // Insert replan_history entry — loop protection should kick in
      insertReplanHistory({
        milestoneId: 'M001',
        sliceId: 'S01',
        summary: 'Replan already completed for this slice',
      });

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.deepStrictEqual(state.phase, 'executing', 'test2: phase is executing (loop protection)');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 3: replan_triggered_at set + no replan_history → replanning-slice ──
  test('flag-file-db: trigger column + no history → replanning', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/T02-PLAN.md', TASK_PLAN_STUB);

      openDatabase(':memory:');

      insertMilestone({ id: 'M001', title: 'Flag-File DB Test', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'active', risk: 'low', depends: [] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Active Task', status: 'pending' });

      // Set replan_triggered_at directly via SQL (simulating triage-resolution.ts writing it)
      const adapter = _getAdapter();
      adapter!.prepare(
        "UPDATE slices SET replan_triggered_at = :ts WHERE milestone_id = :mid AND id = :sid",
      ).run({ ":ts": new Date().toISOString(), ":mid": "M001", ":sid": "S01" });

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.deepStrictEqual(state.phase, 'replanning-slice', 'test3: phase is replanning-slice');
      assert.ok(state.blockers.length > 0, 'test3: has blockers');
      assert.ok(state.blockers[0]?.includes('Triage replan trigger'), 'test3: blocker message mentions triage trigger');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 4: replan_triggered_at set + replan_history exists → loop protection ──
  test('flag-file-db: trigger column + history → loop protection', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/T02-PLAN.md', TASK_PLAN_STUB);

      openDatabase(':memory:');

      insertMilestone({ id: 'M001', title: 'Flag-File DB Test', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'active', risk: 'low', depends: [] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Active Task', status: 'pending' });

      // Set trigger column
      const adapter = _getAdapter();
      adapter!.prepare(
        "UPDATE slices SET replan_triggered_at = :ts WHERE milestone_id = :mid AND id = :sid",
      ).run({ ":ts": new Date().toISOString(), ":mid": "M001", ":sid": "S01" });

      // Also add replan_history — loop protection should prevent replanning
      insertReplanHistory({
        milestoneId: 'M001',
        sliceId: 'S01',
        summary: 'Replan already done',
      });

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.deepStrictEqual(state.phase, 'executing', 'test4: phase is executing (loop protection)');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 5: no blocker, no trigger → phase is executing ──────────────
  test('flag-file-db: no blocker, no trigger → executing', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/T02-PLAN.md', TASK_PLAN_STUB);

      openDatabase(':memory:');

      insertMilestone({ id: 'M001', title: 'Flag-File DB Test', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', status: 'active', risk: 'low', depends: [] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Active Task', status: 'pending' });

      // No blocker, no trigger, no replan_history — normal executing
      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      assert.deepStrictEqual(state.phase, 'executing', 'test5: phase is executing');
      assert.deepStrictEqual(state.activeTask?.id, 'T02', 'test5: activeTask is T02');
      assert.deepStrictEqual(state.blockers.length, 0, 'test5: no blockers');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Diagnostic test: DB column inspection ──────────────────────────
  test('flag-file-db: replan_triggered_at column is queryable', () => {
    openDatabase(':memory:');

    insertMilestone({ id: 'M001', title: 'Diagnostic', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test', status: 'active', risk: 'low', depends: [] });

    // Initially null
    const adapter = _getAdapter();
    const before = adapter!.prepare(
      "SELECT id, replan_triggered_at FROM slices WHERE milestone_id = :mid",
    ).get({ ":mid": "M001" }) as Record<string, unknown>;
    assert.deepStrictEqual(before["replan_triggered_at"], null, 'diagnostic: replan_triggered_at initially null');

    // After setting
    adapter!.prepare(
      "UPDATE slices SET replan_triggered_at = :ts WHERE milestone_id = :mid AND id = :sid",
    ).run({ ":ts": "2025-01-01T00:00:00Z", ":mid": "M001", ":sid": "S01" });

    const after = adapter!.prepare(
      "SELECT id, replan_triggered_at FROM slices WHERE milestone_id = :mid",
    ).get({ ":mid": "M001" }) as Record<string, unknown>;
    assert.deepStrictEqual(after["replan_triggered_at"], "2025-01-01T00:00:00Z", 'diagnostic: replan_triggered_at is set');

    closeDatabase();
  });
});
