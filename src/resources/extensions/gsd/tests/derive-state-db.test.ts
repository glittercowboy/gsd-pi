import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, invalidateStateCache } from '../state.ts';
import { openDatabase, closeDatabase, insertArtifact, isDbAvailable } from '../gsd-db.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();

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

async function main(): Promise<void> {

  // ─── Test 1: DB-backed deriveState produces identical GSDState ─────────
  console.log('\n=== derive-state-db: DB path matches file path ===');
  {
    const base = createFixtureBase();
    try {
      // Write files to disk (for file-only path)
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'REQUIREMENTS.md', REQUIREMENTS_CONTENT);

      // Derive state from files only (no DB)
      invalidateStateCache();
      const fileState = await deriveState(base);

      // Now open DB, insert matching artifacts
      openDatabase(':memory:');
      assertTrue(isDbAvailable(), 'db-match: DB is available after open');

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
      assertEq(dbState.phase, fileState.phase, 'db-match: phase matches');
      assertEq(dbState.activeMilestone?.id, fileState.activeMilestone?.id, 'db-match: activeMilestone.id matches');
      assertEq(dbState.activeMilestone?.title, fileState.activeMilestone?.title, 'db-match: activeMilestone.title matches');
      assertEq(dbState.activeSlice?.id, fileState.activeSlice?.id, 'db-match: activeSlice.id matches');
      assertEq(dbState.activeSlice?.title, fileState.activeSlice?.title, 'db-match: activeSlice.title matches');
      assertEq(dbState.activeTask?.id, fileState.activeTask?.id, 'db-match: activeTask.id matches');
      assertEq(dbState.activeTask?.title, fileState.activeTask?.title, 'db-match: activeTask.title matches');
      assertEq(dbState.blockers, fileState.blockers, 'db-match: blockers match');
      assertEq(dbState.registry.length, fileState.registry.length, 'db-match: registry length matches');
      assertEq(dbState.registry[0]?.status, fileState.registry[0]?.status, 'db-match: registry[0] status matches');
      assertEq(dbState.requirements?.active, fileState.requirements?.active, 'db-match: requirements.active matches');
      assertEq(dbState.requirements?.validated, fileState.requirements?.validated, 'db-match: requirements.validated matches');
      assertEq(dbState.requirements?.total, fileState.requirements?.total, 'db-match: requirements.total matches');
      assertEq(dbState.progress?.milestones?.done, fileState.progress?.milestones?.done, 'db-match: milestones.done matches');
      assertEq(dbState.progress?.milestones?.total, fileState.progress?.milestones?.total, 'db-match: milestones.total matches');
      assertEq(dbState.progress?.slices?.done, fileState.progress?.slices?.done, 'db-match: slices.done matches');
      assertEq(dbState.progress?.slices?.total, fileState.progress?.slices?.total, 'db-match: slices.total matches');
      assertEq(dbState.progress?.tasks?.done, fileState.progress?.tasks?.done, 'db-match: tasks.done matches');
      assertEq(dbState.progress?.tasks?.total, fileState.progress?.tasks?.total, 'db-match: tasks.total matches');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  }

  // ─── Test 2: Fallback when DB unavailable ─────────────────────────────
  console.log('\n=== derive-state-db: fallback when DB unavailable ===');
  {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');

      // No DB open — isDbAvailable() is false
      assertTrue(!isDbAvailable(), 'fallback: DB is not available');
      invalidateStateCache();
      const state = await deriveState(base);

      assertEq(state.phase, 'executing', 'fallback: phase is executing');
      assertEq(state.activeMilestone?.id, 'M001', 'fallback: activeMilestone is M001');
      assertEq(state.activeSlice?.id, 'S01', 'fallback: activeSlice is S01');
      assertEq(state.activeTask?.id, 'T01', 'fallback: activeTask is T01');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 3: Empty DB falls back to file reads ────────────────────────
  console.log('\n=== derive-state-db: empty DB falls back to files ===');
  {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');

      // Open DB but insert nothing — empty artifacts table
      openDatabase(':memory:');
      assertTrue(isDbAvailable(), 'empty-db: DB is available');

      invalidateStateCache();
      const state = await deriveState(base);

      // Should still work via cachedLoadFile → loadFile disk fallback
      assertEq(state.phase, 'executing', 'empty-db: phase is executing');
      assertEq(state.activeMilestone?.id, 'M001', 'empty-db: activeMilestone is M001');
      assertEq(state.activeSlice?.id, 'S01', 'empty-db: activeSlice is S01');
      assertEq(state.activeTask?.id, 'T01', 'empty-db: activeTask is T01');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  }

  // ─── Test 4: Partial DB content fills gaps from disk ──────────────────
  console.log('\n=== derive-state-db: partial DB fills gaps from disk ===');
  {
    const base = createFixtureBase();
    try {
      // Write all files to disk
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'REQUIREMENTS.md', REQUIREMENTS_CONTENT);

      // Open DB but only insert the roadmap — plan and requirements missing from DB
      openDatabase(':memory:');
      insertArtifactRow('milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT, {
        artifact_type: 'roadmap',
        milestone_id: 'M001',
      });

      invalidateStateCache();
      const state = await deriveState(base);

      // Should work: roadmap from DB, plan from disk fallback
      assertEq(state.phase, 'executing', 'partial-db: phase is executing');
      assertEq(state.activeMilestone?.id, 'M001', 'partial-db: activeMilestone is M001');
      assertEq(state.activeSlice?.id, 'S01', 'partial-db: activeSlice is S01');
      assertEq(state.activeTask?.id, 'T01', 'partial-db: activeTask is T01');
      // Requirements loaded from disk fallback
      assertEq(state.requirements?.active, 2, 'partial-db: requirements.active from disk');
      assertEq(state.requirements?.validated, 1, 'partial-db: requirements.validated from disk');
      assertEq(state.requirements?.total, 3, 'partial-db: requirements.total from disk');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  }

  // ─── Test 5: Requirements counting from DB content ────────────────────
  console.log('\n=== derive-state-db: requirements from DB content ===');
  {
    const base = createFixtureBase();
    try {
      // Write minimal milestone dir (needed for milestone discovery)
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
      // Do NOT write REQUIREMENTS.md to disk — only in DB

      openDatabase(':memory:');
      insertArtifactRow('REQUIREMENTS.md', REQUIREMENTS_CONTENT, {
        artifact_type: 'requirements',
      });

      invalidateStateCache();
      const state = await deriveState(base);

      // Requirements should come from DB
      assertEq(state.requirements?.active, 2, 'req-from-db: requirements.active = 2');
      assertEq(state.requirements?.validated, 1, 'req-from-db: requirements.validated = 1');
      assertEq(state.requirements?.total, 3, 'req-from-db: requirements.total = 3');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  }

  // ─── Test 6: DB content with multi-milestone registry ─────────────────
  console.log('\n=== derive-state-db: multi-milestone from DB ===');
  {
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
      writeFile(base, 'milestones/M001/M001-SUMMARY.md', summaryContent);
      writeFile(base, 'milestones/M002/M002-ROADMAP.md', activeRoadmap);

      // Put roadmap content in DB only
      openDatabase(':memory:');
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

      assertEq(state.registry.length, 2, 'multi-ms-db: registry has 2 entries');
      assertEq(state.registry[0]?.id, 'M001', 'multi-ms-db: registry[0] is M001');
      assertEq(state.registry[0]?.status, 'complete', 'multi-ms-db: M001 is complete');
      assertEq(state.registry[1]?.id, 'M002', 'multi-ms-db: registry[1] is M002');
      assertEq(state.registry[1]?.status, 'active', 'multi-ms-db: M002 is active');
      assertEq(state.activeMilestone?.id, 'M002', 'multi-ms-db: activeMilestone is M002');
      assertEq(state.phase, 'planning', 'multi-ms-db: phase is planning (no plan for S01)');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  }

  // ─── Test 7: Cache invalidation works for DB path ─────────────────────
  console.log('\n=== derive-state-db: cache invalidation ===');
  {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', PLAN_CONTENT);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');

      openDatabase(':memory:');
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
      assertEq(state1.activeTask?.id, 'T01', 'cache-inv: first call gets T01');

      // Simulate task completion by updating the plan in DB
      const updatedPlan = PLAN_CONTENT.replace('- [ ] **T01:', '- [x] **T01:');
      insertArtifactRow('milestones/M001/slices/S01/S01-PLAN.md', updatedPlan, {
        artifact_type: 'plan',
        milestone_id: 'M001',
        slice_id: 'S01',
      });
      // Also update file on disk (cachedLoadFile may read from disk for some paths)
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', updatedPlan);

      // Without invalidation, should return cached result (T01 still active)
      const state2 = await deriveState(base);
      assertEq(state2.activeTask?.id, 'T01', 'cache-inv: cached result still has T01');

      // After invalidation, should pick up updated content
      invalidateStateCache();
      const state3 = await deriveState(base);
      assertEq(state3.phase, 'summarizing', 'cache-inv: after invalidation, phase is summarizing (all tasks done)');
      assertEq(state3.activeTask, null, 'cache-inv: activeTask is null after all done');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
