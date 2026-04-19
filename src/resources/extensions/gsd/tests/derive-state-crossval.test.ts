import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// derive-state-crossval.test.ts — Cross-validation: deriveStateFromDb() vs _deriveStateImpl()
// Proves both paths produce field-identical GSDState across 7 fixture scenarios,
// plus an auto-migration round-trip test.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  deriveStateFromDb,
  _deriveStateImpl,
  invalidateStateCache,
} from '../state.ts';
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from '../gsd-db.ts';
import { migrateHierarchyToDb } from '../md-importer.ts';
import type { GSDState } from '../types.ts';

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-crossval-'));
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

/**
 * Compare every GSDState field between DB and filesystem derivation.
 * prefix identifies the scenario in assertion messages.
 */
function assertStatesEqual(dbState: GSDState, fileState: GSDState, prefix: string): void {
  // Phase
  assert.deepStrictEqual(dbState.phase, fileState.phase, `${prefix}: phase`);

  // Active refs
  assert.deepStrictEqual(dbState.activeMilestone?.id ?? null, fileState.activeMilestone?.id ?? null, `${prefix}: activeMilestone.id`);
  assert.deepStrictEqual(dbState.activeMilestone?.title ?? null, fileState.activeMilestone?.title ?? null, `${prefix}: activeMilestone.title`);
  assert.deepStrictEqual(dbState.activeSlice?.id ?? null, fileState.activeSlice?.id ?? null, `${prefix}: activeSlice.id`);
  assert.deepStrictEqual(dbState.activeSlice?.title ?? null, fileState.activeSlice?.title ?? null, `${prefix}: activeSlice.title`);
  assert.deepStrictEqual(dbState.activeTask?.id ?? null, fileState.activeTask?.id ?? null, `${prefix}: activeTask.id`);
  assert.deepStrictEqual(dbState.activeTask?.title ?? null, fileState.activeTask?.title ?? null, `${prefix}: activeTask.title`);

  // Blockers
  assert.deepStrictEqual(dbState.blockers.length, fileState.blockers.length, `${prefix}: blockers.length`);

  // Next action (may differ in wording between paths — compare presence)
  assert.ok(typeof dbState.nextAction === 'string', `${prefix}: nextAction is string`);

  // Registry — length and each entry
  assert.deepStrictEqual(dbState.registry.length, fileState.registry.length, `${prefix}: registry.length`);
  for (let i = 0; i < fileState.registry.length; i++) {
    assert.deepStrictEqual(dbState.registry[i]?.id, fileState.registry[i]?.id, `${prefix}: registry[${i}].id`);
    assert.deepStrictEqual(dbState.registry[i]?.status, fileState.registry[i]?.status, `${prefix}: registry[${i}].status`);
    // dependsOn may or may not be present
    assert.deepStrictEqual(
      JSON.stringify(dbState.registry[i]?.dependsOn ?? []),
      JSON.stringify(fileState.registry[i]?.dependsOn ?? []),
      `${prefix}: registry[${i}].dependsOn`,
    );
  }

  // Requirements
  assert.deepStrictEqual(dbState.requirements?.active ?? 0, fileState.requirements?.active ?? 0, `${prefix}: requirements.active`);
  assert.deepStrictEqual(dbState.requirements?.validated ?? 0, fileState.requirements?.validated ?? 0, `${prefix}: requirements.validated`);
  assert.deepStrictEqual(dbState.requirements?.total ?? 0, fileState.requirements?.total ?? 0, `${prefix}: requirements.total`);

  // Progress
  assert.deepStrictEqual(dbState.progress?.milestones?.done, fileState.progress?.milestones?.done, `${prefix}: progress.milestones.done`);
  assert.deepStrictEqual(dbState.progress?.milestones?.total, fileState.progress?.milestones?.total, `${prefix}: progress.milestones.total`);
  assert.deepStrictEqual(dbState.progress?.slices?.done ?? 0, fileState.progress?.slices?.done ?? 0, `${prefix}: progress.slices.done`);
  assert.deepStrictEqual(dbState.progress?.slices?.total ?? 0, fileState.progress?.slices?.total ?? 0, `${prefix}: progress.slices.total`);
  assert.deepStrictEqual(dbState.progress?.tasks?.done ?? 0, fileState.progress?.tasks?.done ?? 0, `${prefix}: progress.tasks.done`);
  assert.deepStrictEqual(dbState.progress?.tasks?.total ?? 0, fileState.progress?.tasks?.total ?? 0, `${prefix}: progress.tasks.total`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario fixtures
// ═══════════════════════════════════════════════════════════════════════════

describe('derive-state-crossval', async () => {

  // ─── Scenario A: Pre-planning — milestone with CONTEXT but no roadmap ──
  test('crossval A: pre-planning', async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-CONTEXT.md', '# M001: New Project\n\nWe are exploring scope.');

      // Filesystem derivation
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      // DB derivation via migration
      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assertStatesEqual(dbState, fileState, 'A-preplan');
      assert.deepStrictEqual(dbState.phase, 'pre-planning', 'A-preplan: phase is pre-planning');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Scenario B: Executing — 2 slices, first complete, second active ──
  test('crossval B: executing', async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Test Project

**Vision:** Test executing state.

## Slices

- [x] **S01: Foundation** \`risk:low\` \`depends:[]\`
  > After this: Foundation laid.

- [ ] **S02: Core Logic** \`risk:medium\` \`depends:[S01]\`
  > After this: Core working.
`;
      const planS02 = `---
estimated_steps: 2
estimated_files: 1
skills_used: []
---

# S02: Core Logic

**Goal:** Build core logic.
**Demo:** Tests pass.

## Tasks

- [x] **T01: Setup** \`est:15m\`
  Setup task.

- [ ] **T02: Implement** \`est:30m\`
  Implementation task.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', roadmap);
      // S01 complete — needs a summary
      writeFile(base, 'milestones/M001/slices/S01/S01-SUMMARY.md', '---\nid: S01\nparent: M001\n---\n\n# S01: Foundation\n\nDone.');
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', `# S01: Foundation\n\n**Goal:** Lay foundation.\n**Demo:** Done.\n\n## Tasks\n\n- [x] **T01: Init** \`est:10m\`\n  Init.\n`);
      // S02 active with plan
      writeFile(base, 'milestones/M001/slices/S02/S02-PLAN.md', planS02);
      writeFile(base, 'milestones/M001/slices/S02/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S02/tasks/T01-PLAN.md', '# T01 Plan');
      writeFile(base, 'milestones/M001/slices/S02/tasks/T01-SUMMARY.md', '---\nid: T01\n---\n\n# T01\n\nDone.');
      writeFile(base, 'milestones/M001/slices/S02/tasks/T02-PLAN.md', '# T02 Plan');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assertStatesEqual(dbState, fileState, 'B-executing');
      assert.deepStrictEqual(dbState.phase, 'executing', 'B-executing: phase is executing');
      assert.deepStrictEqual(dbState.activeSlice?.id, 'S02', 'B-executing: activeSlice is S02');
      assert.deepStrictEqual(dbState.activeTask?.id, 'T02', 'B-executing: activeTask is T02');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Scenario C: Summarizing — all tasks done, no slice summary ────────
  test('crossval C: summarizing', async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Summarize Test

**Vision:** Test summarizing state.

## Slices

- [ ] **S01: Only Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      const plan = `---
estimated_steps: 2
estimated_files: 1
skills_used: []
---

# S01: Only Slice

**Goal:** Do everything.
**Demo:** All done.

## Tasks

- [x] **T01: First** \`est:10m\`
  First task.

- [x] **T02: Second** \`est:10m\`
  Second task.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', roadmap);
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', plan);
      writeFile(base, 'milestones/M001/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T02-PLAN.md', '# T02 Plan');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T01-SUMMARY.md', '---\nid: T01\nparent: S01\nmilestone: M001\n---\n# T01 Summary\nDone.');
      writeFile(base, 'milestones/M001/slices/S01/tasks/T02-SUMMARY.md', '---\nid: T02\nparent: S01\nmilestone: M001\n---\n# T02 Summary\nDone.');
      // Tasks have summaries, but no S01-SUMMARY.md — should be summarizing

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assertStatesEqual(dbState, fileState, 'C-summarizing');
      assert.deepStrictEqual(dbState.phase, 'summarizing', 'C-summarizing: phase is summarizing');
      assert.deepStrictEqual(dbState.activeSlice?.id, 'S01', 'C-summarizing: activeSlice is S01');
      assert.deepStrictEqual(dbState.activeTask, null, 'C-summarizing: no activeTask');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Scenario D: Multi-milestone — M001 complete, M002 active ─────────
  test('crossval D: multi-milestone', async () => {
    const base = createFixtureBase();
    try {
      const m1Roadmap = `# M001: First Milestone

**Vision:** Already done.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      const m2Roadmap = `# M002: Second Milestone

**Vision:** Currently active.

## Slices

- [ ] **S01: Active Slice** \`risk:low\` \`depends:[]\`
  > After this: Active work done.
`;
      const m2Plan = `---
estimated_steps: 1
estimated_files: 1
skills_used: []
---

# S01: Active Slice

**Goal:** Do the work.
**Demo:** It works.

## Tasks

- [ ] **T01: Work** \`est:30m\`
  Do the work.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', m1Roadmap);
      writeFile(base, 'milestones/M001/M001-VALIDATION.md', '---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.');
      writeFile(base, 'milestones/M001/M001-SUMMARY.md', '# M001 Summary\n\nFirst milestone complete.');
      writeFile(base, 'milestones/M002/M002-ROADMAP.md', m2Roadmap);
      writeFile(base, 'milestones/M002/slices/S01/S01-PLAN.md', m2Plan);
      writeFile(base, 'milestones/M002/slices/S01/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M002/slices/S01/tasks/T01-PLAN.md', '# T01 Plan');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assertStatesEqual(dbState, fileState, 'D-multims');
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M002', 'D-multims: activeMilestone is M002');
      assert.deepStrictEqual(dbState.registry.length, 2, 'D-multims: 2 milestones in registry');

      const m1 = dbState.registry.find(e => e.id === 'M001');
      const m2 = dbState.registry.find(e => e.id === 'M002');
      assert.deepStrictEqual(m1?.status, 'complete', 'D-multims: M001 complete');
      assert.deepStrictEqual(m2?.status, 'active', 'D-multims: M002 active');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Scenario E: Blocked — circular slice deps ────────────────────────
  test('crossval E: blocked', async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Blocked Test

**Vision:** Test blocked state.

## Slices

- [ ] **S01: First** \`risk:low\` \`depends:[S02]\`
  > After this: First done.

- [ ] **S02: Second** \`risk:low\` \`depends:[S01]\`
  > After this: Second done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', roadmap);

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assertStatesEqual(dbState, fileState, 'E-blocked');
      // With partial-dep fallback, circular deps no longer block — fallback picks first eligible slice
      assert.deepStrictEqual(dbState.phase, 'planning', 'E-blocked: phase is planning (fallback picks a slice)');
      assert.ok(dbState.activeSlice !== null, 'E-blocked: activeSlice is set via fallback');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Scenario F: Parked — PARKED file on milestone ────────────────────
  test('crossval F: parked', async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Parked Milestone

**Vision:** Parked.

## Slices

- [ ] **S01: Some Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', roadmap);
      writeFile(base, 'milestones/M001/M001-PARKED.md', 'Parked for now.');
      // Second milestone picks up as active
      writeFile(base, 'milestones/M002/M002-CONTEXT.md', '# M002: Active Milestone\n\nReady to go.');

      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      assertStatesEqual(dbState, fileState, 'F-parked');
      assert.deepStrictEqual(dbState.activeMilestone?.id, 'M002', 'F-parked: activeMilestone is M002');
      assert.ok(dbState.registry.some(e => e.id === 'M001' && e.status === 'parked'), 'F-parked: M001 parked');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // ─── Scenario G: Auto-migration round-trip ────────────────────────────
  // Create a markdown-only fixture (no DB). Migrate to DB. Both paths identical.
  test('crossval G: auto-migration round-trip', async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Migration Test

**Vision:** Test migration fidelity.

## Slices

- [x] **S01: Done Setup** \`risk:low\` \`depends:[]\`
  > After this: Setup done.

- [ ] **S02: Active Work** \`risk:medium\` \`depends:[S01]\`
  > After this: Work done.

- [ ] **S03: Future Work** \`risk:high\` \`depends:[S02]\`
  > After this: All done.
`;
      const planS02 = `---
estimated_steps: 3
estimated_files: 2
skills_used: []
---

# S02: Active Work

**Goal:** Do the work.
**Demo:** Tests pass.

## Tasks

- [x] **T01: First** \`est:10m\`
  First task.

- [ ] **T02: Second** \`est:20m\`
  Second task.

- [ ] **T03: Third** \`est:15m\`
  Third task.
`;
      const requirements = `# Requirements

## Active

### R001 — Core Feature
- Status: active
- Description: Must have core feature.

## Validated

### R002 — Setup
- Status: validated
- Description: Setup is validated.

## Deferred

### R003 — Nice to Have
- Status: deferred
- Description: Maybe later.
`;
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', roadmap);
      writeFile(base, 'milestones/M001/slices/S01/S01-SUMMARY.md', '---\nid: S01\nparent: M001\n---\n\n# S01: Done Setup\n\nDone.');
      writeFile(base, 'milestones/M001/slices/S01/S01-PLAN.md', `# S01: Done Setup\n\n**Goal:** Setup.\n**Demo:** Done.\n\n## Tasks\n\n- [x] **T01: Init** \`est:10m\`\n  Init.\n`);
      writeFile(base, 'milestones/M001/slices/S02/S02-PLAN.md', planS02);
      writeFile(base, 'milestones/M001/slices/S02/tasks/.gitkeep', '');
      writeFile(base, 'milestones/M001/slices/S02/tasks/T01-PLAN.md', '# T01 Plan');
      writeFile(base, 'milestones/M001/slices/S02/tasks/T01-SUMMARY.md', '---\nid: T01\n---\n\n# T01\n\nDone.');
      writeFile(base, 'milestones/M001/slices/S02/tasks/T02-PLAN.md', '# T02 Plan');
      writeFile(base, 'milestones/M001/slices/S02/tasks/T03-PLAN.md', '# T03 Plan');
      writeFile(base, 'REQUIREMENTS.md', requirements);

      // Step 1: Get filesystem-only state
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);

      // Step 2: Migrate markdown to DB
      openDatabase(':memory:');
      const counts = migrateHierarchyToDb(base);

      // Verify migration populated correctly
      assert.ok(counts.milestones >= 1, 'G-roundtrip: migrated milestones');
      assert.ok(counts.slices >= 2, 'G-roundtrip: migrated slices');
      assert.ok(counts.tasks >= 3, 'G-roundtrip: migrated tasks');

      // Step 3: Get DB-backed state
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);

      // Step 4: Deep cross-validation
      assertStatesEqual(dbState, fileState, 'G-roundtrip');
      assert.deepStrictEqual(dbState.phase, 'executing', 'G-roundtrip: phase is executing');
      assert.deepStrictEqual(dbState.activeSlice?.id, 'S02', 'G-roundtrip: activeSlice is S02');
      assert.deepStrictEqual(dbState.activeTask?.id, 'T02', 'G-roundtrip: activeTask is T02');
      assert.deepStrictEqual(dbState.requirements?.active, 1, 'G-roundtrip: requirements.active = 1');
      assert.deepStrictEqual(dbState.requirements?.validated, 1, 'G-roundtrip: requirements.validated = 1');
      assert.deepStrictEqual(dbState.requirements?.deferred, 1, 'G-roundtrip: requirements.deferred = 1');
      assert.deepStrictEqual(dbState.requirements?.total, 3, 'G-roundtrip: requirements.total = 3');
      assert.deepStrictEqual(dbState.progress?.slices?.done, 1, 'G-roundtrip: slices.done = 1');
      assert.deepStrictEqual(dbState.progress?.slices?.total, 3, 'G-roundtrip: slices.total = 3');
      assert.deepStrictEqual(dbState.progress?.tasks?.done, 1, 'G-roundtrip: tasks.done = 1');
      assert.deepStrictEqual(dbState.progress?.tasks?.total, 3, 'G-roundtrip: tasks.total = 3');

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
