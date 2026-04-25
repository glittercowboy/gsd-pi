import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, invalidateStateCache, _deriveStateImpl, deriveStateFromDb, isGhostMilestone } from '../state.ts';
import {
  openDatabase,
  closeDatabase,
  insertArtifact,
  isDbAvailable,
  insertMilestone,
  getAllMilestones,
  insertSlice,
  insertTask,
  updateTaskStatus,
} from '../gsd-db.ts';
// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-derive-db-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, '.gsd', relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function insertArtifactRow(relativePath: string, content: string, opts?: {
  artifact_type?: string;
  milestone_id?: string | null;
  slice_id?: string | null;
  task_id?: string | null;
}): void {
  insertArtifact({
    path: relativePath,
    artifact_type: opts?.artifact_type ?? 'planning',
    milestone_id: opts?.milestone_id ?? null,
    slice_id: opts?.slice_id ?? null,
    task_id: opts?.task_id ?? null,
    full_content: content,
  });
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Groups
// ═══════════════════════════════════════════════════════════════════════════

const ROADMAP_CONTENT = `# M001: Test Milestone

**Vision:** Test DB-backed derive state.

## Slices

- [ ] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice done.

- [ ] **S02: Second Slice** \`risk:low\` \`depends:[S01]\`
  > After this: All done.
`;

const PLAN_CONTENT = `# S01: First Slice

**Goal:** Test executing.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: First Task** \`est:10m\`
  First task description.

- [x] **T02: Done Task** \`est:10m\`
  Already done.
`;

const REQUIREMENTS_CONTENT = `# Requirements

## Active

### R001 — First Requirement
- Status: active
- Description: Something active.

### R002 — Second Requirement
- Status: active
- Description: Another active.

## Validated

### R003 — Validated
- Status: validated
- Description: Already validated.
`;

describe('derive-state-db', async () => {

  // ─── Test 1: DB-backed deriveState produces identical GSDState ─────────
  test('derive-state-db: DB path matches file path', async () => {
    const base = createFixtureBase();
    try {
      // Write files to disk (for file-only path)
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');
      writeFile(base, 'REQUIREMENTS.md', REQUIREMENTS_CONTENT);

      // Derive state from files only (no DB)
      invalidateStateCache();
      const fileState = await deriveState(base);

      // Now open DB, insert matching artifacts + milestone hierarchy
      openDatabase(':memory:');
      assert.ok(isDbAvailable(), 'db-match: DB is available after open');

      // Insert milestone hierarchy so deriveState takes the DB path (#2631 fix)
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
      insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second Slice', status: 'pending', risk: 'low', depends: ['S01'] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'pending' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });

      insertArtifactRow('milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT, {
        artifact_type: 'roadmap',
        milestone_id: 'M001',
      });
      insertArtifactRow('milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT, {
        artifact_type: 'plan',
        milestone_id: 'M001',
        slice_id: 'S01',
      });
      insertArtifactRow('REQUIREMENTS.md', REQUIREMENTS_CONTENT, {
        artifact_type: 'requirements',
      });

      // Derive state from DB
      invalidateStateCache();
      const dbState = await deriveState(base);

      // Field-by-field equality
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'db-match: phase matches');
      assert.deepStrictEqual(dbState.activeMilestone?.id, fileState.activeMilestone?.id, 'db-match: activeMilestone.id matches');
      assert.deepStrictEqual(dbState.activeMilestone?.title, fileState.activeMilestone?.title, 'db-match: activeMilestone.title matches');
      assert.deepStrictEqual(dbState.activeSlice?.id, fileState.activeSlice?.id, 'db-match: activeSlice.id matches');
      assert.deepStrictEqual(dbState.activeSlice?.title, fileState.activeSlice?.title, 'db-match: activeSlice.title matches');
      assert.deepStrictEqual(dbState.activeTask?.id, fileState.activeTask?.id, 'db-match: activeTask.id matches');
      assert.deepStrictEqual(dbState.activeTask?.title, fileState.activeTask?.title, 'db-match: activeTask.title matches');
      assert.deepStrictEqual(dbState.blockers, fileState.blockers, 'db-match: blockers match');
      assert.deepStrictEqual(dbState.registry.length, fileState.registry.length, 'db-match: registry length matches');
      assert.deepStrictEqual(dbState.registry[0]?.status, fileState.registry[0]?.status, 'db-match: registry[0] status matches');
      assert.deepStrictEqual(dbState.requirements?.active, fileState.requirements?.active, 'db-match: requirements.active matches');
      assert.deepStrictEqual(dbState.requirements?.validated, fileState.requirements?.validated, 'db-match: requirements.validated matches');
      assert.deepStrictEqual(dbState.requirements?.total, fileState.requirements?.total, 'db-match: requirements.total matches');
      assert.deepStrictEqual(dbState.progress?.milestones?.done, fileState.progress?.milestones?.done, 'db-match: milestones.done matches');
      assert.deepStrictEqual(dbState.progress?.milestones?.total, fileState.progress?.milestones?.total, 'db-match: milestones.total matches');
      assert.deepStrictEqual(dbState.progress?.slices?.done, fileState.progress?.slices?.done, 'db-match: slices.done matches');
      assert.deepStrictEqual(dbState.progress?.slices?.total, fileState.progress?.slices?.total, 'db-match: slices.total matches');
      assert.deepStrictEqual(dbState.progress?.tasks?.done, fileState.progress?.tasks?.done, 'db-match: tasks.done matches');
      assert.deepStrictEqual(dbState.progress?.tasks?.total, fileState.progress?.tasks?.total, 'db-match: tasks.total matches');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 2: Fallback when DB unavailable ─────────────────────────────
  test('derive-state-db: fallback when DB unavailable', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');

      // No DB open — isDbAvailable() is false
      assert.ok(!isDbAvailable(), 'fallback: DB is not available');
      invalidateStateCache();
      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'executing', 'fallback: phase is executing');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'fallback: activeMilestone is M001');
      assert.deepStrictEqual(state.activeSlice?.id, 'S01', 'fallback: activeSlice is S01');
      assert.deepStrictEqual(state.activeTask?.id, 'T01', 'fallback: activeTask is T01');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 3: Empty DB falls back to file reads ────────────────────────
  test('derive-state-db: empty DB falls back to files', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');

      // Open DB but insert nothing — empty tables.
      // With #2631 fix, deriveState will sync disk milestones into DB
      // and then take the DB path. The result should still reflect the
      // disk milestone correctly.
      openDatabase(':memory:');
      assert.ok(isDbAvailable(), 'empty-db: DB is available');

      invalidateStateCache();
      const state = await deriveState(base);

      // Milestone should be detected (synced from disk)
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'empty-db: activeMilestone is M001');
      // The DB path without explicit slice/task rows may derive a different
      // phase than the filesystem path, but the milestone must be found.
      assert.ok(state.activeMilestone !== null, 'empty-db: activeMilestone is not null');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 4: Partial DB content fills gaps from disk ──────────────────
  test('derive-state-db: partial DB fills gaps from disk', async () => {
    const base = createFixtureBase();
    try {
      // Write all files to disk
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');
      writeFile(base, 'REQUIREMENTS.md', REQUIREMENTS_CONTENT);

      // Open DB — insert milestone hierarchy + partial artifacts (#2631 fix)
      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'pending' });
      // Only insert the roadmap artifact — plan and requirements missing from DB
      insertArtifactRow('milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT, {
        artifact_type: 'roadmap',
        milestone_id: 'M001',
      });

      invalidateStateCache();
      const state = await deriveState(base);

      // Should work: roadmap from DB, plan from disk fallback
      assert.deepStrictEqual(state.phase, 'executing', 'partial-db: phase is executing');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'partial-db: activeMilestone is M001');
      assert.deepStrictEqual(state.activeSlice?.id, 'S01', 'partial-db: activeSlice is S01');
      assert.deepStrictEqual(state.activeTask?.id, 'T01', 'partial-db: activeTask is T01');
      // Requirements loaded from disk fallback
      assert.deepStrictEqual(state.requirements?.active, 2, 'partial-db: requirements.active from disk');
      assert.deepStrictEqual(state.requirements?.validated, 1, 'partial-db: requirements.validated from disk');
      assert.deepStrictEqual(state.requirements?.total, 3, 'partial-db: requirements.total from disk');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 5: Requirements counting from disk (DB no longer used for content) ─
  test('derive-state-db: requirements from disk content', async () => {
    const base = createFixtureBase();
    try {
      // Write minimal milestone dir (needed for milestone discovery)
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
      // Write REQUIREMENTS.md to disk (DB content is no longer used by deriveState)
      writeFile(base, 'REQUIREMENTS.md', REQUIREMENTS_CONTENT);

      invalidateStateCache();
      const state = await deriveState(base);

      // Requirements should come from disk
      assert.deepStrictEqual(state.requirements?.active, 2, 'req-from-disk: requirements.active = 2');
      assert.deepStrictEqual(state.requirements?.validated, 1, 'req-from-disk: requirements.validated = 1');
      assert.deepStrictEqual(state.requirements?.total, 3, 'req-from-disk: requirements.total = 3');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 6: DB content with multi-milestone registry ─────────────────
  test('derive-state-db: multi-milestone from DB', async () => {
    const base = createFixtureBase();

    const completedRoadmap = `# M001: First Milestone

**Vision:** Already done.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
    const summaryContent = `# M001 Summary\n\nFirst milestone complete.`;

    const activeRoadmap = `# M002: Second Milestone

**Vision:** Currently active.

## Slices

- [ ] **S01: In Progress** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;

    try {
      // Create milestone dirs on disk (needed for directory scanning)
      // Also write roadmap files to disk — resolveMilestoneFile checks file existence
      // The DB only provides content, not file discovery
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
      mkdirSync(join(base, '.gsd', 'milestones', 'M002'), { recursive: true });
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', completedRoadmap);
      writeFile(base, 'milestones/M001/M001-VALIDATION.md', `---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.`);
      writeFile(base, 'milestones/M001/M001-SUMMARY.md', summaryContent);
      writeFile(base, 'milestones/M002/M002-ROADMAP.md', activeRoadmap);

      // Put roadmap content in DB only
      openDatabase(':memory:');
      // Insert milestone rows so deriveState takes the DB path (#2631 fix:
      // empty milestones table now triggers disk→DB sync, which would create
      // rows without slices — insert explicitly to get the full DB path).
      insertMilestone({ id: 'M001', title: 'First Milestone', status: 'complete' });
      insertMilestone({ id: 'M002', title: 'Second Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Done', status: 'complete', risk: 'low', depends: [] });
      insertSlice({ id: 'S01', milestoneId: 'M002', title: 'In Progress', status: 'active', risk: 'low', depends: [] });
      insertArtifactRow('milestones/M001/M001-ROADMAP.md', completedRoadmap, {
        artifact_type: 'roadmap',
        milestone_id: 'M001',
      });
      insertArtifactRow('milestones/M001/M001-SUMMARY.md', summaryContent, {
        artifact_type: 'summary',
        milestone_id: 'M001',
      });
      insertArtifactRow('milestones/M002/M002-ROADMAP.md', activeRoadmap, {
        artifact_type: 'roadmap',
        milestone_id: 'M002',
      });

      invalidateStateCache();
      const state = await deriveState(base);

      assert.deepStrictEqual(state.registry.length, 2, 'multi-ms-db: registry has 2 entries');
      assert.deepStrictEqual(state.registry[0]?.id, 'M001', 'multi-ms-db: registry[0] is M001');
      assert.deepStrictEqual(state.registry[0]?.status, 'complete', 'multi-ms-db: M001 is complete');
      assert.deepStrictEqual(state.registry[1]?.id, 'M002', 'multi-ms-db: registry[1] is M002');
      assert.deepStrictEqual(state.registry[1]?.status, 'active', 'multi-ms-db: M002 is active');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002', 'multi-ms-db: activeMilestone is M002');
      assert.deepStrictEqual(state.phase, 'planning', 'multi-ms-db: phase is planning (no plan for S01)');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 7: Cache invalidation works for DB path ─────────────────────
  test('derive-state-db: cache invalidation', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');

      openDatabase(':memory:');
      // Insert milestone/slice/task rows so deriveState takes the DB path (#2631 fix)
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'pending' });
      insertArtifactRow('milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT, {
        artifact_type: 'roadmap',
        milestone_id: 'M001',
      });
      insertArtifactRow('milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT, {
        artifact_type: 'plan',
        milestone_id: 'M001',
        slice_id: 'S01',
      });

      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.deepStrictEqual(state1.activeTask?.id, 'T01', 'cache-inv: first call gets T01');

      // Simulate task completion by updating the plan in DB
      const updatedPlan = PLAN_CONTENT.replace('- [ ] **T01:', '- [x] **T01:');
      insertArtifactRow('milestones/M001/slices/S01/S01-PLAN.md', updatedPlan, {
        artifact_type: 'plan',
        milestone_id: 'M001',
        slice_id: 'S01',
      });
      // Also update file on disk (cachedLoadFile may read from disk for some paths)
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', updatedPlan);
      // Update task status in DB so DB-path also sees completion (#2631 fix)
      updateTaskStatus('M001', 'S01', 'T01', 'complete');

      // Without invalidation, should return cached result (T01 still active)
      const state2 = await deriveState(base);
      assert.deepStrictEqual(state2.activeTask?.id, 'T01', 'cache-inv: cached result still has T01');

      // After invalidation, should pick up updated content
      invalidateStateCache();
      const state3 = await deriveState(base);
      assert.deepStrictEqual(state3.phase, 'summarizing', 'cache-inv: after invalidation, phase is summarizing (all tasks done)');
      assert.deepStrictEqual(state3.activeTask, null, 'cache-inv: activeTask is null after all done');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // New: deriveStateFromDb() cross-validation tests
  // ═════════════════════════════════════════════════════════════════════════

  // ─── Test 8: Pre-planning — milestone exists, no roadmap, no slices ───
  test('derive-state-db: pre-planning via DB', async () => {
    const base = createFixtureBase();
    try {
      // Create milestone dir on disk with a CONTEXT file (not a ghost)
      writeFile(base, 'milestones/M001/M001-CONTEXT.md', '# M001: First\n\nSome context.');

      // Filesystem-only state
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      // Now open DB, populate hierarchy
      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'First', status: 'active' });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, fileState.phase, 'pre-plan-db: phase matches');
      assert.deepStrictEqual(dbState.activeMilestone?.id, fileState.activeMilestone?.id, 'pre-plan-db: activeMilestone.id matches');
      assert.deepStrictEqual(dbState.activeSlice, fileState.activeSlice, 'pre-plan-db: activeSlice matches');
      assert.deepStrictEqual(dbState.activeTask, fileState.activeTask, 'pre-plan-db: activeTask matches');
      assert.deepStrictEqual(dbState.registry.length, fileState.registry.length, 'pre-plan-db: registry length matches');
      assert.deepStrictEqual(dbState.registry[0]?.status, fileState.registry[0]?.status, 'pre-plan-db: registry[0] status matches');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 9: Executing — active task with partial completion ──────────
  test('derive-state-db: executing via DB', async () => {
    const base = createFixtureBase();
    try {
      // Build filesystem fixture
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      // Build matching DB state
      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
      insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second Slice', status: 'pending', risk: 'low', depends: ['S01'] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'pending' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, 'executing', 'exec-db: phase is executing');
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M001', 'exec-db: activeMilestone is M001');
      assert.deepStrictEqual(dbState.activeSlice?.id, 'S01', 'exec-db: activeSlice is S01');
      assert.deepStrictEqual(dbState.activeTask?.id, 'T01', 'exec-db: activeTask is T01');
      assert.deepStrictEqual(dbState.progress?.tasks?.done, 1, 'exec-db: tasks.done = 1');
      assert.deepStrictEqual(dbState.progress?.tasks?.total, 2, 'exec-db: tasks.total = 2');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'exec-db: phase matches filesystem');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 10: Summarizing — all tasks complete, no slice summary ──────
  test('derive-state-db: summarizing via DB', async () => {
    const base = createFixtureBase();
    try {
      const allDonePlan = `# S01: First Slice

**Goal:** Test summarizing.
**Demo:** Tests pass.

## Tasks

- [x] **T01: First Task** \`est:10m\`
  First task description.

- [x] **T02: Done Task** \`est:10m\`
  Already done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', allDonePlan);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
      insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second Slice', status: 'pending', risk: 'low', depends: ['S01'] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'complete' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, 'summarizing', 'summarize-db: phase is summarizing');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'summarize-db: phase matches filesystem');
      assert.deepStrictEqual(dbState.activeSlice?.id, 'S01', 'summarize-db: activeSlice is S01');
      assert.deepStrictEqual(dbState.activeTask, null, 'summarize-db: activeTask is null');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 11: Complete — all milestones complete ──────────────────────
  test('derive-state-db: all complete via DB', async () => {
    const base = createFixtureBase();
    try {
      const completedRoadmap = `# M001: Done Milestone

**Vision:** Already done.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', completedRoadmap);
      writeFile(base, 'milestones/M001/M001-VALIDATION.md', '---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.');
      writeFile(base, 'milestones/M001/M001-SUMMARY.md', '# M001 Summary\n\nDone.');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Done Milestone', status: 'complete' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Done', status: 'complete', risk: 'low', depends: [] });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, 'complete', 'complete-db: phase is complete');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'complete-db: phase matches filesystem');
      assert.deepStrictEqual(dbState.registry.length, 1, 'complete-db: registry has 1 entry');
      assert.deepStrictEqual(dbState.registry[0]?.status, 'complete', 'complete-db: M001 is complete');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 12: Blocked — slice deps unmet ──────────────────────────────
  test('derive-state-db: blocked slice via DB', async () => {
    const base = createFixtureBase();
    try {
      // Roadmap with S02 depending on S01, but S01 not done
      const blockedRoadmap = `# M001: Blocked Test

**Vision:** Test blocked state.

## Slices

- [ ] **S01: First** \`risk:low\` \`depends:[S02]\`
  > After this: First done.

- [ ] **S02: Second** \`risk:low\` \`depends:[S01]\`
  > After this: Second done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', blockedRoadmap);

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Blocked Test', status: 'active' });
      // Circular deps — both depend on each other, neither done
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First', status: 'pending', risk: 'low', depends: ['S02'] });
      insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second', status: 'pending', risk: 'low', depends: ['S01'] });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      // With partial-dep fallback, circular deps no longer block — fallback picks first eligible slice
      assert.deepStrictEqual(dbState.phase, 'planning', 'blocked-db: phase is planning (fallback picks a slice)');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'blocked-db: phase matches filesystem');
      assert.ok(dbState.activeSlice !== null, 'blocked-db: activeSlice is set via fallback');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 13: Parked milestone ────────────────────────────────────────
  test('derive-state-db: parked milestone via DB', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/M001-PARKED.md', 'Parked for now.');
      writeFile(base, 'milestones/M002/M002-CONTEXT.md', '# M002: Active After Park\n\nReady.');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'parked' });
      insertMilestone({ id: 'M002', title: 'Active After Park', status: 'active' });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, fileState.phase, 'parked-db: phase matches filesystem');
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M002', 'parked-db: activeMilestone is M002');
      assert.ok(dbState.registry.some(e => e.id === 'M001' && e.status === 'parked'), 'parked-db: M001 is parked in registry');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 14: Validating-milestone — all slices done, no terminal validation ─
  test('derive-state-db: validating-milestone via DB', async () => {
    const base = createFixtureBase();
    try {
      const doneRoadmap = `# M001: Validate Test

**Vision:** Test validation.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', doneRoadmap);
      // No VALIDATION file → validating-milestone phase

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Validate Test', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Done Slice', status: 'complete', risk: 'low', depends: [] });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, 'validating-milestone', 'validate-db: phase is validating-milestone');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'validate-db: phase matches filesystem');
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M001', 'validate-db: activeMilestone is M001');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 14b: needs-remediation + all slices done → blocked (#4506) ──
  test('derive-state-db: needs-remediation with all slices done returns blocked (#4506)', async () => {
    const base = createFixtureBase();
    try {
      const doneRoadmap = `# M001: Stuck Remediation

**Vision:** Test needs-remediation loop guard.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', doneRoadmap);
      writeFile(base, 'milestones/M001/M001-VALIDATION.md',
        '---\nverdict: needs-remediation\nremediation_round: 1\n---\n\n# Validation\nNeeds fixes.');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Stuck Remediation', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Done Slice', status: 'complete', risk: 'low', depends: [] });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, 'blocked', 'remediation-stuck-db: phase is blocked');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'remediation-stuck-db: phase matches filesystem');
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M001', 'remediation-stuck-db: activeMilestone is M001');
      assert.ok(
        dbState.blockers.some(b => b.includes('needs-remediation') && b.includes('M001')),
        'remediation-stuck-db: blocker message mentions milestone and verdict',
      );

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 15: Completing-milestone — terminal validation, no summary ──
  test('derive-state-db: completing-milestone via DB', async () => {
    const base = createFixtureBase();
    try {
      const doneRoadmap = `# M001: Complete Test

**Vision:** Test completion.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', doneRoadmap);
      writeFile(base, 'milestones/M001/M001-VALIDATION.md', '---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Complete Test', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Done Slice', status: 'complete', risk: 'low', depends: [] });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, 'completing-milestone', 'completing-db: phase is completing-milestone');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'completing-db: phase matches filesystem');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 16: Replanning-slice — REPLAN-TRIGGER file exists ───────────
  test('derive-state-db: replanning-slice via DB', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');
      writeFile(base, 'milestones/M001/slices/S01/S01-REPLAN-TRIGGER.md', 'Replan triggered.');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
      insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second Slice', status: 'pending', risk: 'low', depends: ['S01'] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'pending' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });

      // Seed the replan_triggered_at column — DB path uses column instead of disk file
      const { _getAdapter } = await import('../gsd-db.ts');
      const adapter = _getAdapter();
      adapter!.prepare(
        "UPDATE slices SET replan_triggered_at = :ts WHERE milestone_id = :mid AND id = :sid",
      ).run({ ":ts": new Date().toISOString(), ":mid": "M001", ":sid": "S01" });


      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, 'replanning-slice', 'replan-db: phase is replanning-slice');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'replan-db: phase matches filesystem');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 17: Performance — deriveStateFromDb < 1ms on populated DB ───
  test('derive-state-db: performance assertion', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
      insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second Slice', status: 'pending', risk: 'low', depends: ['S01'] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'pending' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });

      // Warm up (first call may incur filesystem IO for flag file checks)
      invalidateStateCache();
      await deriveStateFromDb(base);

      // Timed run
      const start = performance.now();
      invalidateStateCache();
      await deriveStateFromDb(base);
      const elapsed = performance.now() - start;

      console.log(`  deriveStateFromDb() took ${elapsed.toFixed(3)}ms`);
      // Use 25ms threshold — catches real regressions without flaking on
      // slower CI runners (Windows agents measured at ~12ms under load;
      // the 10ms threshold was too tight for those environments).
      assert.ok(elapsed < 25, `perf-db: deriveStateFromDb() <25ms (got ${elapsed.toFixed(3)}ms)`);

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 18: Multi-milestone with deps — M001 complete, M002 depends on M001, M003 depends on M002 ─
  test('derive-state-db: multi-milestone deps via DB', async () => {
    const base = createFixtureBase();
    try {
      const m1Roadmap = `# M001: First

**Vision:** First.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      const m2Roadmap = `# M002: Second

**Vision:** Second.

## Slices

- [ ] **S01: Active** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', m1Roadmap);
      writeFile(base, 'milestones/M001/M001-VALIDATION.md', '---\nverdict: pass\nremediation_round: 0\n---\n\nPassed.');
      writeFile(base, 'milestones/M001/M001-SUMMARY.md', '# M001 Summary\n\nDone.');
      writeFile(base, 'milestones/M002/M002-ROADMAP.md', m2Roadmap);
      writeFile(base, 'milestones/M002/M002-CONTEXT.md', '---\ndepends_on:\n  - M001\n---\n\n# M002: Second\n\nDepends on M001.');
      writeFile(base, 'milestones/M003/M003-CONTEXT.md', '---\ndepends_on:\n  - M002\n---\n\n# M003: Third\n\nDepends on M002.');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'First', status: 'complete', depends_on: [] });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Done', status: 'complete', risk: 'low', depends: [] });
      insertMilestone({ id: 'M002', title: 'Second', status: 'active', depends_on: ['M001'] });
      insertSlice({ id: 'S01', milestoneId: 'M002', title: 'Active', status: 'pending', risk: 'low', depends: [] });
      insertMilestone({ id: 'M003', title: 'Third', status: 'active', depends_on: ['M002'] });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.registry.length, fileState.registry.length, 'multi-deps-db: registry length matches');
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M002', 'multi-deps-db: activeMilestone is M002 (M001 complete, M003 dep unmet)');
      assert.deepStrictEqual(dbState.activeMilestone?.id, fileState.activeMilestone?.id, 'multi-deps-db: activeMilestone matches filesystem');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'multi-deps-db: phase matches filesystem');

      // Check registry statuses
      const m1reg = dbState.registry.find(e => e.id === 'M001');
      const m2reg = dbState.registry.find(e => e.id === 'M002');
      const m3reg = dbState.registry.find(e => e.id === 'M003');
      assert.deepStrictEqual(m1reg?.status, 'complete', 'multi-deps-db: M001 is complete');
      assert.deepStrictEqual(m2reg?.status, 'active', 'multi-deps-db: M002 is active');
      assert.deepStrictEqual(m3reg?.status, 'pending', 'multi-deps-db: M003 is pending (dep M002 unmet)');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 19: K002 — both 'complete' and 'done' treated as done ───────
  test('derive-state-db: K002 status handling', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
      insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second Slice', status: 'pending', risk: 'low', depends: ['S01'] });
      // Use 'done' status (the alternative from K002)
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'pending' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'done' });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, 'executing', 'k002-db: phase is executing');
      assert.deepStrictEqual(dbState.activeTask?.id, 'T01', 'k002-db: activeTask is T01 (T02 done)');
      assert.deepStrictEqual(dbState.progress?.tasks?.done, 1, 'k002-db: tasks.done counts done status');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 20: Dual-path wiring — deriveState() uses DB when populated ─
  test('derive-state-db: dual-path wiring', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'First Slice', status: 'active', risk: 'low', depends: [] });
      insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second Slice', status: 'pending', risk: 'low', depends: ['S01'] });
      insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First Task', status: 'pending' });
      insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Done Task', status: 'complete' });

      // deriveState() should automatically use DB path since milestones table is populated
      invalidateStateCache();
      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'executing', 'dual-path: phase is executing');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'dual-path: activeMilestone is M001');
      assert.deepStrictEqual(state.activeSlice?.id, 'S01', 'dual-path: activeSlice is S01');
      assert.deepStrictEqual(state.activeTask?.id, 'T01', 'dual-path: activeTask is T01');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 21: Ghost milestone skipped (no DB row, no worktree) ─────────
  test('derive-state-db: ghost milestone skipped when no DB row and no worktree', async () => {
    const base = createFixtureBase();
    try {
      // Ghost: milestone dir exists with only META.json, no context/roadmap/summary
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
      writeFileSync(join(base, '.gsd', 'milestones', 'M001', 'META.json'), '{}');
      // Real milestone
      writeFile(base, 'milestones/M002/M002-CONTEXT.md', '# M002: Real\n\nReal milestone.');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      // Only insert M002 — M001 has no DB row (simulates row loss / never inserted)
      insertMilestone({ id: 'M002', title: 'Real', status: 'active' });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      // Ghost should be skipped — M002 should be active
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M002', 'ghost-db: activeMilestone is M002 (ghost skipped)');
      assert.deepStrictEqual(dbState.activeMilestone?.id, fileState.activeMilestone?.id, 'ghost-db: matches filesystem');
      // Ghost should not appear in registry
      assert.ok(!dbState.registry.some(e => e.id === 'M001'), 'ghost-db: M001 not in registry');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Test 22: Needs-discussion — CONTEXT-DRAFT exists ─────────────────
  test('derive-state-db: needs-discussion via DB', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-CONTEXT-DRAFT.md', '# M001: Draft\n\nDraft content.');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'Draft', status: 'active' });

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assert.deepStrictEqual(dbState.phase, 'needs-discussion', 'discuss-db: phase is needs-discussion');
      assert.deepStrictEqual(dbState.phase, fileState.phase, 'discuss-db: phase matches filesystem');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Regression: disk-only milestones synced into DB (#2416) ─────────
  test('derive-state-db: disk-only milestone auto-synced into DB (#2416)', async () => {
    const base = createFixtureBase();
    try {
      // M001 is complete and exists in DB. M002 was queued on disk only — no DB row.
      writeFile(base, 'milestones/M001/M001-SUMMARY.md', '# M001 Summary\n\nDone.');
      writeFile(base, 'milestones/M002/M002-CONTEXT.md', '# M002: Queued\n\nQueued milestone.');

      openDatabase(':memory:');
      // Only insert M001 — simulates the state after migration guard ran then /gsd queue added M002
      insertMilestone({ id: 'M001', title: 'First', status: 'complete' });

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // Before the fix, M002 was invisible: getAllMilestones() returned only M001
      // (complete) → phase='complete' → auto-mode stopped.
      // After the fix, deriveStateFromDb reconciles disk dirs and inserts M002.
      assert.deepStrictEqual(state.phase, 'pre-planning', 'disk-sync-2416: phase is pre-planning, not complete');
      assert.deepStrictEqual(state.registry.length, 2, 'disk-sync-2416: both milestones visible in registry');
      assert.deepStrictEqual(state.registry[0]?.id, 'M001', 'disk-sync-2416: registry[0] is M001');
      assert.deepStrictEqual(state.registry[0]?.status, 'complete', 'disk-sync-2416: M001 is complete');
      assert.deepStrictEqual(state.registry[1]?.id, 'M002', 'disk-sync-2416: registry[1] is M002');
      assert.deepStrictEqual(state.registry[1]?.status, 'active', 'disk-sync-2416: M002 is active');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002', 'disk-sync-2416: activeMilestone is M002');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Queued milestone row not clobbered by later plan (#2416 root cause) ──
  test('derive-state-db: queued milestone row survives gsd_plan_milestone INSERT OR IGNORE', async () => {
    try {
      openDatabase(':memory:');

      // Simulates gsd_milestone_generate_id inserting a minimal queued row
      insertMilestone({ id: 'M001', status: 'queued' });

      const before = getAllMilestones();
      assert.equal(before.length, 1, 'queued-row: one row after generate_id');
      assert.equal(before[0]!.status, 'queued', 'queued-row: status is queued');

      // Simulates gsd_plan_milestone calling insertMilestone (INSERT OR IGNORE)
      insertMilestone({ id: 'M001', title: 'Planned Title', status: 'active' });

      const after = getAllMilestones();
      assert.equal(after.length, 1, 'queued-row: still one row after plan');
      // INSERT OR IGNORE keeps the original row — status stays 'queued'
      assert.equal(after[0]!.status, 'queued', 'queued-row: INSERT OR IGNORE preserves original status');

      closeDatabase();
    } finally {
      closeDatabase();
    }
  });

  // ─── Queued milestone with worktree not flagged as ghost (#2921) ──────
  test('derive-state-db: queued milestone with worktree not flagged as ghost (#2921)', async () => {
    const base = createFixtureBase();
    try {
      // M001: complete milestone with summary
      writeFile(base, 'milestones/M001/M001-SUMMARY.md', '# M001 Summary\n\nDone.');

      // M002: queued milestone — directory + slices dir exists, but no content files.
      // This is what happens when ensureMilestoneDbRow creates M002 but the DB row
      // is lost during worktree teardown.
      mkdirSync(join(base, '.gsd', 'milestones', 'M002', 'slices'), { recursive: true });

      // A worktree exists for M002, proving it's a legitimate milestone
      mkdirSync(join(base, '.gsd', 'worktrees', 'M002'), { recursive: true });

      // isGhostMilestone should NOT treat M002 as ghost when worktree exists
      assert.ok(!isGhostMilestone(base, 'M002'), 'ghost-wt: M002 with worktree is NOT a ghost');

      // DB has M001 complete but M002 row was lost
      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'First', status: 'complete' });
      // No M002 row — simulates DB row loss during worktree teardown

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      // M002 should be reconciled from disk (not skipped as ghost) and become active
      const m002Entry = dbState.registry.find(e => e.id === 'M002');
      assert.ok(m002Entry !== undefined, 'ghost-wt: M002 should be in registry');
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M002', 'ghost-wt: M002 should be active');
      // Should NOT be phase: complete
      assert.notEqual(dbState.phase, 'complete', 'ghost-wt: phase should not be complete');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Queued milestone with DB row not flagged as ghost (#2921) ────────
  test('derive-state-db: queued milestone with DB row not flagged as ghost (#2921)', async () => {
    const base = createFixtureBase();
    try {
      // M001: complete milestone with summary
      writeFile(base, 'milestones/M001/M001-SUMMARY.md', '# M001 Summary\n\nDone.');

      // M002: queued milestone — directory exists with CONTEXT file and DB row
      mkdirSync(join(base, '.gsd', 'milestones', 'M002', 'slices'), { recursive: true });
      writeFile(base, 'milestones/M002/M002-CONTEXT.md', '# M002 Context\n\nPlanned milestone.');

      // DB has both M001 complete and M002 queued
      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'First', status: 'complete' });
      insertMilestone({ id: 'M002', title: 'Second', status: 'queued' });

      // isGhostMilestone should NOT treat M002 as ghost when DB row + content files exist
      assert.ok(!isGhostMilestone(base, 'M002'), 'ghost-dbrow: M002 with DB row and content is NOT a ghost');

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      // M002 should not be skipped
      const m002Entry = dbState.registry.find(e => e.id === 'M002');
      assert.ok(m002Entry !== undefined, 'ghost-dbrow: M002 should be in registry');
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M002', 'ghost-dbrow: M002 should be active');
      assert.notEqual(dbState.phase, 'complete', 'ghost-dbrow: phase should not be complete');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
