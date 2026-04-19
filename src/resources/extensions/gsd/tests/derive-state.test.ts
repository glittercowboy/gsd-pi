import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, isSliceComplete, isMilestoneComplete, isGhostMilestone } from '../state.ts';
// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-state-test-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeRoadmap(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}

function writePlan(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid);
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
  // Create stub task plan files for any tasks in the plan content (#909)
  // so deriveState doesn't fall back to planning phase.
  const taskMatches = content.matchAll(/\*\*(T\d+):/g);
  for (const m of taskMatches) {
    const tid = m[1];
    const planPath = join(tasksDir, `${tid}-PLAN.md`);
    writeFileSync(planPath, `# ${tid} Plan\n\nTask plan stub for testing.\n`);
  }
}

function writeContinue(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-CONTINUE.md`), content);
}

function writeMilestoneSummary(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), content);
}

function writeMilestoneValidation(base: string, mid: string, verdict: string = 'pass'): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), `---\nverdict: ${verdict}\nremediation_round: 0\n---\n\n# Validation\nValidated.`);
}

function writeRequirements(base: string, content: string): void {
  writeFileSync(join(base, '.gsd', 'REQUIREMENTS.md'), content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Groups
// ═══════════════════════════════════════════════════════════════════════════

describe('derive-state', async () => {

  // ─── Test 1: empty milestones dir → pre-planning ───────────────────────
  test('empty milestones dir → pre-planning', async () => {
    const base = createFixtureBase();
    try {
      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'pre-planning', 'phase is pre-planning');
      assert.deepStrictEqual(state.activeMilestone, null, 'activeMilestone is null');
      assert.deepStrictEqual(state.activeSlice, null, 'activeSlice is null');
      assert.deepStrictEqual(state.activeTask, null, 'activeTask is null');
      assert.deepStrictEqual(state.registry, [], 'registry is empty');
      assert.deepStrictEqual(state.progress?.milestones?.done, 0, 'milestones done = 0');
      assert.deepStrictEqual(state.progress?.milestones?.total, 0, 'milestones total = 0');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 2: milestone dir exists but no roadmap → pre-planning ────────
  test('milestone dir exists but no roadmap → pre-planning', async () => {
    const base = createFixtureBase();
    try {
      // Create M001 directory with CONTEXT but no roadmap file
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
      writeFileSync(join(base, '.gsd', 'milestones', 'M001', 'M001-CONTEXT.md'), '# First Milestone\n\nContext for M001.');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'pre-planning', 'phase is pre-planning');
      assert.ok(state.activeMilestone !== null, 'activeMilestone is not null');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'activeMilestone id is M001');
      assert.deepStrictEqual(state.activeSlice, null, 'activeSlice is null');
      assert.deepStrictEqual(state.activeTask, null, 'activeTask is null');
      assert.deepStrictEqual(state.registry.length, 1, 'registry has 1 entry');
      assert.deepStrictEqual(state.registry[0]?.status, 'active', 'registry entry status is active');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 3: roadmap with incomplete slice, no plan → planning ─────────
  test('roadmap with incomplete slice, no plan → planning', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test planning phase.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'planning', 'phase is planning');
      assert.ok(state.activeSlice !== null, 'activeSlice is not null');
      assert.deepStrictEqual(state.activeSlice?.id, 'S01', 'activeSlice id is S01');
      assert.deepStrictEqual(state.activeTask, null, 'activeTask is null');
      assert.deepStrictEqual(state.progress?.slices?.done, 0, 'slices done = 0');
      assert.deepStrictEqual(state.progress?.slices?.total, 1, 'slices total = 1');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 4: roadmap + plan with incomplete tasks → executing ──────────
  test('roadmap + plan with incomplete tasks → executing', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test executing phase.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);

      writePlan(base, 'M001', 'S01', `# S01: Test Slice

**Goal:** Test executing.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: First** \`est:10m\`
  First task description.

- [ ] **T02: Second** \`est:10m\`
  Second task description.
`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'executing', 'phase is executing');
      assert.ok(state.activeTask !== null, 'activeTask is not null');
      assert.deepStrictEqual(state.activeTask?.id, 'T01', 'activeTask id is T01');
      assert.deepStrictEqual(state.progress?.tasks?.done, 0, 'tasks done = 0');
      assert.deepStrictEqual(state.progress?.tasks?.total, 2, 'tasks total = 2');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 5: executing + continue file → resume message ─────────────
  test('executing + continue file → resume message', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test interrupted resume.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);

      writePlan(base, 'M001', 'S01', `# S01: Test Slice

**Goal:** Test interrupted.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: First Task** \`est:10m\`
  First task description.
`);

      writeContinue(base, 'M001', 'S01', `---
milestone: M001
slice: S01
task: T01
step: 2
totalSteps: 5
status: interrupted
savedAt: 2026-03-10T10:00:00Z
---

# Continue: T01

## Completed Work
Steps 1 done.

## Remaining Work
Steps 2-5.

## Next Action
Continue from step 2.
`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'executing', 'interrupted: phase is executing');
      assert.ok(state.activeTask !== null, 'interrupted: activeTask is not null');
      assert.deepStrictEqual(state.activeTask?.id, 'T01', 'interrupted: activeTask id is T01');
      assert.ok(
        state.nextAction.includes('Resume') || state.nextAction.includes('resume') || state.nextAction.includes('continue.md'),
        'interrupted: nextAction mentions Resume/resume/continue.md'
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 6: all tasks done, slice not [x] → summarizing ──────────────
  test('all tasks done, slice not [x] → summarizing', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test summarizing phase.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);

      writePlan(base, 'M001', 'S01', `# S01: Test Slice

**Goal:** Test summarizing.
**Demo:** Tests pass.

## Tasks

- [x] **T01: First Done** \`est:10m\`
  Already completed.

- [x] **T02: Second Done** \`est:10m\`
  Also completed.
`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'summarizing', 'summarizing: phase is summarizing');
      assert.ok(state.activeSlice !== null, 'summarizing: activeSlice is not null');
      assert.deepStrictEqual(state.activeSlice?.id, 'S01', 'summarizing: activeSlice id is S01');
      assert.deepStrictEqual(state.activeTask, null, 'summarizing: activeTask is null');
      assert.ok(
        state.nextAction.toLowerCase().includes('summary') || state.nextAction.toLowerCase().includes('complete'),
        'summarizing: nextAction mentions summary or complete'
      );
      assert.deepStrictEqual(state.progress?.tasks?.done, 2, 'summarizing: tasks done = 2');
      assert.deepStrictEqual(state.progress?.tasks?.total, 2, 'summarizing: tasks total = 2');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 7: all milestones complete → complete ────────────────────────
  test('all milestones complete → complete', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test complete phase.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      writeMilestoneValidation(base, 'M001');
      writeMilestoneSummary(base, 'M001', `# M001 Summary\n\nMilestone complete.`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'complete', 'complete: phase is complete');
      assert.deepStrictEqual(state.activeSlice, null, 'complete: activeSlice is null');
      assert.deepStrictEqual(state.activeTask, null, 'complete: activeTask is null');
      assert.ok(
        state.nextAction.toLowerCase().includes('complete'),
        'complete: nextAction mentions complete'
      );
      assert.deepStrictEqual(state.registry.length, 1, 'complete: registry has 1 entry');
      assert.deepStrictEqual(state.registry[0]?.status, 'complete', 'complete: registry[0] status is complete');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 7b: complete with active requirements → surfaces unmapped reqs ──
  test('complete with active requirements → surfaces unmapped reqs', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test complete phase with unmapped requirements.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      writeMilestoneValidation(base, 'M001');
      writeMilestoneSummary(base, 'M001', `# M001 Summary\n\nMilestone complete.`);
      writeRequirements(base, `# Requirements

## Active

### REQ01 — First active requirement
- Status: active

### REQ02 — Second active requirement
- Status: active

## Validated

### REQ03 — Validated requirement
- Status: validated
`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'complete', 'complete-with-reqs: phase is complete');
      assert.ok(
        state.nextAction.includes('2 active requirements'),
        'complete-with-reqs: nextAction mentions 2 active requirements'
      );
      assert.ok(
        state.nextAction.includes('REQUIREMENTS.md'),
        'complete-with-reqs: nextAction mentions REQUIREMENTS.md'
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 7c: complete with no active requirements → standard message ──
  test('complete with no active requirements → standard message', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test complete phase with all requirements validated.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      writeMilestoneValidation(base, 'M001');
      writeMilestoneSummary(base, 'M001', `# M001 Summary\n\nMilestone complete.`);
      writeRequirements(base, `# Requirements

## Validated

### REQ01 — Validated requirement
- Status: validated
`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'complete', 'complete-no-active-reqs: phase is complete');
      assert.deepStrictEqual(state.nextAction, 'All milestones complete.', 'complete-no-active-reqs: standard completion message');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 8: blocked dependencies ──────────────────────────────────────
  test('blocked dependencies', async () => {
    // Case A: S01 active (deps satisfied), S02 blocked on S01
    const base1 = createFixtureBase();
    try {
      writeRoadmap(base1, 'M001', `# M001: Test Milestone

**Vision:** Test blocked deps.

## Slices

- [ ] **S01: First** \`risk:low\` \`depends:[]\`
  > After this: S01 done.

- [ ] **S02: Second** \`risk:low\` \`depends:[S01]\`
  > After this: S02 done.
`);

      // S01 has a plan with incomplete task — it's the active slice
      writePlan(base1, 'M001', 'S01', `# S01: First

**Goal:** First slice.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Incomplete** \`est:10m\`
  Still working.
`);

      const state1 = await deriveState(base1);

      assert.deepStrictEqual(state1.phase, 'executing', 'blocked-A: phase is executing (S01 active)');
      assert.deepStrictEqual(state1.activeSlice?.id, 'S01', 'blocked-A: activeSlice is S01');
    } finally {
      cleanup(base1);
    }

    // Case B: S01 depends on nonexistent S99 → truly blocked
    const base2 = createFixtureBase();
    try {
      writeRoadmap(base2, 'M001', `# M001: Test Milestone

**Vision:** Test truly blocked.

## Slices

- [ ] **S01: Blocked** \`risk:low\` \`depends:[S99]\`
  > After this: Done.
`);

      const state2 = await deriveState(base2);

      // With partial-dep fallback, S01 is picked despite unmet dep on S99
      assert.deepStrictEqual(state2.phase, 'planning', 'blocked-B: phase is planning (fallback picks S01)');
      assert.deepStrictEqual(state2.activeSlice?.id, 'S01', 'blocked-B: activeSlice is S01 via fallback');
    } finally {
      cleanup(base2);
    }
  });

  // ─── Test 9: multi-milestone registry ──────────────────────────────────
  test('multi-milestone registry', async () => {
    const base = createFixtureBase();
    try {
      // M001: complete (all slices done)
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** Already done.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      writeMilestoneValidation(base, 'M001');
      writeMilestoneSummary(base, 'M001', `# M001 Summary\n\nFirst milestone complete.`);

      // M002: active (has incomplete slices)
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** Currently active.

## Slices

- [ ] **S01: In Progress** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      // M003: dir with CONTEXT but no roadmap → pending since M002 is already active
      mkdirSync(join(base, '.gsd', 'milestones', 'M003'), { recursive: true });
      writeFileSync(join(base, '.gsd', 'milestones', 'M003', 'M003-CONTEXT.md'), '# Third Milestone\n\nContext for M003.');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.registry.length, 3, 'multi-ms: registry has 3 entries');
      assert.deepStrictEqual(state.registry[0]?.id, 'M001', 'multi-ms: registry[0] is M001');
      assert.deepStrictEqual(state.registry[0]?.status, 'complete', 'multi-ms: M001 is complete');
      assert.deepStrictEqual(state.registry[1]?.id, 'M002', 'multi-ms: registry[1] is M002');
      assert.deepStrictEqual(state.registry[1]?.status, 'active', 'multi-ms: M002 is active');
      assert.deepStrictEqual(state.registry[2]?.id, 'M003', 'multi-ms: registry[2] is M003');
      assert.deepStrictEqual(state.registry[2]?.status, 'pending', 'multi-ms: M003 is pending');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002', 'multi-ms: activeMilestone is M002');
      assert.deepStrictEqual(state.progress?.milestones?.done, 1, 'multi-ms: milestones done = 1');
      assert.deepStrictEqual(state.progress?.milestones?.total, 3, 'multi-ms: milestones total = 3');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 10: requirements integration ─────────────────────────────────
  test('requirements integration', async () => {
    const base = createFixtureBase();
    try {
      writeRequirements(base, `# Requirements

## Active

### R001 — First Active Requirement
- Status: active
- Description: Something active.

### R002 — Second Active Requirement
- Status: active
- Description: Another active one.

## Validated

### R003 — Validated Requirement
- Status: validated
- Description: Already validated.

## Deferred

### R004 — Deferred Requirement
- Status: deferred
- Description: Pushed back.

### R005 — Another Deferred
- Status: deferred
- Description: Also deferred.

## Out of Scope

### R006 — Out of Scope Requirement
- Status: out-of-scope
- Description: Not doing this.
`);

      // Need at least an empty milestones dir for deriveState
      const state = await deriveState(base);

      assert.ok(state.requirements !== undefined, 'requirements: requirements object exists');
      assert.deepStrictEqual(state.requirements?.active, 2, 'requirements: active = 2');
      assert.deepStrictEqual(state.requirements?.validated, 1, 'requirements: validated = 1');
      assert.deepStrictEqual(state.requirements?.deferred, 2, 'requirements: deferred = 2');
      assert.deepStrictEqual(state.requirements?.outOfScope, 1, 'requirements: outOfScope = 1');
      assert.deepStrictEqual(state.requirements?.total, 6, 'requirements: total = 6 (sum of all)');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 11: all slices [x], no summary → completing-milestone ────────
  test('all slices [x], no summary → completing-milestone', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test completing-milestone phase.

## Slices

- [x] **S01: First Done** \`risk:low\` \`depends:[]\`
  > After this: S01 complete.

- [x] **S02: Second Done** \`risk:low\` \`depends:[S01]\`
  > After this: S02 complete.
`);

      writeMilestoneValidation(base, 'M001');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'completing-milestone', 'completing-ms: phase is completing-milestone');
      assert.ok(state.activeMilestone !== null, 'completing-ms: activeMilestone is not null');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'completing-ms: activeMilestone id is M001');
      assert.deepStrictEqual(state.activeSlice, null, 'completing-ms: activeSlice is null');
      assert.deepStrictEqual(state.activeTask, null, 'completing-ms: activeTask is null');
      assert.deepStrictEqual(state.registry.length, 1, 'completing-ms: registry has 1 entry');
      assert.deepStrictEqual(state.registry[0]?.status, 'active', 'completing-ms: registry[0] status is active (not complete)');
      assert.deepStrictEqual(state.progress?.slices?.done, 2, 'completing-ms: slices done = 2');
      assert.deepStrictEqual(state.progress?.slices?.total, 2, 'completing-ms: slices total = 2');
      assert.ok(
        state.nextAction.toLowerCase().includes('summary') || state.nextAction.toLowerCase().includes('complete'),
        'completing-ms: nextAction mentions summary or complete'
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 12: all slices [x], summary exists → complete ───────────────
  test('all slices [x], summary exists → complete', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test that summary presence means complete.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      writeMilestoneValidation(base, 'M001');
      writeMilestoneSummary(base, 'M001', `# M001 Summary\n\nMilestone is complete.`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'complete', 'summary-exists: phase is complete');
      assert.deepStrictEqual(state.registry.length, 1, 'summary-exists: registry has 1 entry');
      assert.deepStrictEqual(state.registry[0]?.status, 'complete', 'summary-exists: registry[0] status is complete');
      assert.deepStrictEqual(state.activeSlice, null, 'summary-exists: activeSlice is null');
      assert.deepStrictEqual(state.activeTask, null, 'summary-exists: activeTask is null');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 13: multi-milestone completing-milestone ─────────────────────
  test('multi-milestone completing-milestone', async () => {
    const base = createFixtureBase();
    try {
      // M001: all slices done + summary exists → complete
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** Already complete with summary.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, 'M001');
      writeMilestoneSummary(base, 'M001', `# M001 Summary\n\nFirst milestone complete.`);

      // M002: all slices done, no summary → completing-milestone
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** All slices done but no summary.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.

- [x] **S02: Also Done** \`risk:low\` \`depends:[S01]\`
  > After this: Done.
`);

      writeMilestoneValidation(base, 'M002');

      // M003: has incomplete slices → pending (M002 is active)
      writeRoadmap(base, 'M003', `# M003: Third Milestone

**Vision:** Not yet started.

## Slices

- [ ] **S01: Not Started** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'completing-milestone', 'multi-completing: phase is completing-milestone');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002', 'multi-completing: activeMilestone is M002');
      assert.deepStrictEqual(state.activeSlice, null, 'multi-completing: activeSlice is null');
      assert.deepStrictEqual(state.activeTask, null, 'multi-completing: activeTask is null');
      assert.deepStrictEqual(state.registry.length, 3, 'multi-completing: registry has 3 entries');
      assert.deepStrictEqual(state.registry[0]?.id, 'M001', 'multi-completing: registry[0] is M001');
      assert.deepStrictEqual(state.registry[0]?.status, 'complete', 'multi-completing: M001 is complete');
      assert.deepStrictEqual(state.registry[1]?.id, 'M002', 'multi-completing: registry[1] is M002');
      assert.deepStrictEqual(state.registry[1]?.status, 'active', 'multi-completing: M002 is active (completing-milestone)');
      assert.deepStrictEqual(state.registry[2]?.id, 'M003', 'multi-completing: registry[2] is M003');
      assert.deepStrictEqual(state.registry[2]?.status, 'pending', 'multi-completing: M003 is pending');
      assert.deepStrictEqual(state.progress?.milestones?.done, 1, 'multi-completing: milestones done = 1');
      assert.deepStrictEqual(state.progress?.milestones?.total, 3, 'multi-completing: milestones total = 3');
      assert.deepStrictEqual(state.progress?.slices?.done, 2, 'multi-completing: slices done = 2');
      assert.deepStrictEqual(state.progress?.slices?.total, 2, 'multi-completing: slices total = 2');
    } finally {
      cleanup(base);
    }
  });

  // ═══ Milestone with summary but no roadmap → complete ═══════════════════
  {
    const base = createFixtureBase();
    try {
      // M001, M002: completed milestones with summaries but no roadmaps
      const m1dir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(m1dir, { recursive: true });
      writeFileSync(join(m1dir, 'M001-SUMMARY.md'), '---\nid: M001\n---\n# Bootstrap\nDone.');

      const m2dir = join(base, '.gsd', 'milestones', 'M002');
      mkdirSync(m2dir, { recursive: true });
      writeFileSync(join(m2dir, 'M002-SUMMARY.md'), '---\nid: M002\n---\n# Core Features\nDone.');

      // M003: active milestone with a roadmap
      writeRoadmap(base, 'M003', '# M003: Polish\n## Slices\n- [ ] **S01: Cleanup**');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'planning', 'summary-no-roadmap: phase is planning (active is M003)');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M003', 'summary-no-roadmap: active milestone is M003');
      assert.deepStrictEqual(state.activeMilestone?.title, 'Polish', 'summary-no-roadmap: active title is Polish');
      assert.deepStrictEqual(state.registry.length, 3, 'summary-no-roadmap: registry has 3 entries');
      assert.deepStrictEqual(state.registry[0]?.status, 'complete', 'summary-no-roadmap: M001 is complete');
      assert.deepStrictEqual(state.registry[0]?.title, 'Bootstrap', 'summary-no-roadmap: M001 title from summary');
      assert.deepStrictEqual(state.registry[1]?.status, 'complete', 'summary-no-roadmap: M002 is complete');
      assert.deepStrictEqual(state.registry[1]?.title, 'Core Features', 'summary-no-roadmap: M002 title from summary');
      assert.deepStrictEqual(state.registry[2]?.status, 'active', 'summary-no-roadmap: M003 is active');
      assert.deepStrictEqual(state.progress?.milestones?.done, 2, 'summary-no-roadmap: milestones done = 2');
      assert.deepStrictEqual(state.progress?.milestones?.total, 3, 'summary-no-roadmap: milestones total = 3');
    } finally {
      cleanup(base);
    }
  }

  // ═══ All milestones have summary but no roadmap → complete ═════════════
  {
    const base = createFixtureBase();
    try {
      const m1dir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(m1dir, { recursive: true });
      writeFileSync(join(m1dir, 'M001-SUMMARY.md'), '---\ntitle: Done\n---\nAll done.');

      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, 'complete', 'all-summary-only: phase is complete');
      assert.deepStrictEqual(state.registry[0]?.status, 'complete', 'all-summary-only: M001 is complete');
    } finally {
      cleanup(base);
    }
  }

  // ─── Empty plan (zero tasks) stays in planning, not summarizing (#454) ──
  test('empty plan → planning (not summarizing)', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `---
id: M001
title: "Test"
---
# M001: Test
## Vision
Test
## Success Criteria
- Done
## Slices
- [ ] **S01: Empty slice** \`risk:low\` \`depends:[]\`
  > Test
## Boundary Map
_None_
`);
      writePlan(base, 'M001', 'S01', `---
slice: S01
---
# S01 Plan
## Tasks
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, 'planning', 'empty plan stays in planning');
      assert.deepStrictEqual(state.activeSlice?.id, 'S01', 'active slice is S01');
      assert.deepStrictEqual(state.activeTask, null, 'no active task');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: completed M001 (summary, no validation) skipped for active M003 (#864) ────
  test('completed milestone with summary but no validation is not active (#864)', async () => {
    const base = createFixtureBase();
    try {
      // M001: all slices done, has summary, no validation
      writeRoadmap(base, 'M001', `# M001: First Milestone\n\n**Vision:** Done.\n\n## Slices\n\n- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`\n  > Completed.\n`);
      writeMilestoneSummary(base, 'M001', '---\nid: M001\n---\n\n# M001: First Milestone\n\n**Completed.**');
      // M003: incomplete, should be active
      writeRoadmap(base, 'M003', `# M003: Active Milestone\n\n**Vision:** Do stuff.\n\n## Slices\n\n- [ ] **S01: Work slice** \`risk:low\` \`depends:[]\`\n  > Needs work.\n`);

      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, 'M003', 'active milestone is M003, not completed M001');
      const m001Entry = state.registry.find(e => e.id === 'M001');
      assert.deepStrictEqual(m001Entry?.status, 'complete', 'M001 is marked complete despite no validation');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: completed M001 with summary AND validation is complete (#864) ────
  test('completed milestone with summary and validation is complete', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: First Milestone\n\n**Vision:** Done.\n\n## Slices\n\n- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`\n  > Completed.\n`);
      writeMilestoneSummary(base, 'M001', '---\nid: M001\n---\n\n# M001: First Milestone\n\n**Completed.**');
      writeMilestoneValidation(base, 'M001', 'pass');
      writeRoadmap(base, 'M003', `# M003: Active Milestone\n\n**Vision:** Do stuff.\n\n## Slices\n\n- [ ] **S01: Work slice** \`risk:low\` \`depends:[]\`\n  > Needs work.\n`);

      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, 'M003', 'active milestone is M003');
      const m001Entry = state.registry.find(e => e.id === 'M001');
      assert.deepStrictEqual(m001Entry?.status, 'complete', 'M001 with both summary and validation is complete');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: all slices done, no summary, no validation → needs validation (#864) ────
  test('all slices done, no summary, no validation → validating-milestone', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: First Milestone\n\n**Vision:** Validate me.\n\n## Slices\n\n- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`\n  > Completed.\n`);
      // No summary, no validation — this should be active for validation

      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'M001 is active for validation');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: all slices done, validation pass, no summary → needs completion (#864) ────
  test('all slices done, validation pass, no summary → completing-milestone', async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: First Milestone\n\n**Vision:** Complete me.\n\n## Slices\n\n- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`\n  > Completed.\n`);
      writeMilestoneValidation(base, 'M001', 'pass');
      // No summary — validated but not yet completed

      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'M001 is active for completion');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: unchecked roadmap slices + summary → complete (summary is terminal) ────
  test('unchecked roadmap slices + summary → complete (summary is terminal)', async () => {
    const base = createFixtureBase();
    try {
      // M001: roadmap has unchecked slices but a summary exists — should be complete
      writeRoadmap(base, 'M001', `# M001: First Milestone\n\n**Vision:** Already done.\n\n## Slices\n\n- [ ] **S01: Unchecked slice** \`risk:low\` \`depends:[]\`\n  > Work was done but checkbox never ticked.\n- [ ] **S02: Another unchecked** \`risk:low\` \`depends:[]\`\n  > Same.\n`);
      writeMilestoneSummary(base, 'M001', '---\nid: M001\n---\n\n# M001: First Milestone\n\n**Completed despite unchecked roadmap.**');
      // M002: genuinely incomplete — should be the active milestone
      writeRoadmap(base, 'M002', `# M002: Active Milestone\n\n**Vision:** Do stuff.\n\n## Slices\n\n- [ ] **S01: Work slice** \`risk:low\` \`depends:[]\`\n  > Needs work.\n`);

      const state = await deriveState(base);
      const m001Entry = state.registry.find(e => e.id === 'M001');
      assert.deepStrictEqual(m001Entry?.status, 'complete', 'M001 with unchecked roadmap + summary is complete');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002', 'active milestone is M002, not M001');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: unchecked roadmap + summary counts toward completeMilestoneIds (deps) ────
  test('unchecked roadmap + summary satisfies dependency', async () => {
    const base = createFixtureBase();
    try {
      // M001: unchecked roadmap + summary → complete
      writeRoadmap(base, 'M001', `# M001: Foundation\n\n**Vision:** Done.\n\n## Slices\n\n- [ ] **S01: Setup** \`risk:low\` \`depends:[]\`\n  > Done.\n`);
      writeMilestoneSummary(base, 'M001', '---\nid: M001\n---\n\n# M001: Foundation\n\n**Done.**');
      // M002: depends on M001 — should be active since M001 is complete
      writeRoadmap(base, 'M002', `# M002: Dependent\n\n**Vision:** Depends on M001.\n\n## Slices\n\n- [ ] **S01: Work** \`risk:low\` \`depends:[]\`\n  > Work.\n`);
      const contextDir = join(base, '.gsd', 'milestones', 'M002');
      mkdirSync(contextDir, { recursive: true });
      writeFileSync(join(contextDir, 'M002-CONTEXT.md'), '---\ndepends_on:\n  - M001\n---\n\n# M002 Context\n\nDepends on M001.');

      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002', 'M002 is active — M001 dependency satisfied via summary');
      const m002Entry = state.registry.find(e => e.id === 'M002');
      assert.deepStrictEqual(m002Entry?.status, 'active', 'M002 status is active, not pending');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: ghost milestone (only META.json) is skipped ───────────────
  test('ghost milestone (only META.json) is skipped', async () => {
    const base = createFixtureBase();
    try {
      // Create a ghost milestone directory with only META.json
      const ghostDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(ghostDir, { recursive: true });
      writeFileSync(join(ghostDir, 'META.json'), JSON.stringify({ id: 'M001' }));

      // isGhostMilestone should detect it
      assert.ok(isGhostMilestone(base, 'M001'), 'M001 is a ghost milestone');

      // deriveState should treat this as pre-planning (no real milestones)
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, 'pre-planning', 'ghost-only: phase is pre-planning');
      assert.deepStrictEqual(state.activeMilestone, null, 'ghost-only: no active milestone');
      assert.deepStrictEqual(state.registry.length, 0, 'ghost-only: registry is empty');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: ghost milestone skipped when real milestones exist ──────────
  test('ghost milestone skipped alongside real milestones', async () => {
    const base = createFixtureBase();
    try {
      // M001: ghost (only META.json)
      const ghostDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(ghostDir, { recursive: true });
      writeFileSync(join(ghostDir, 'META.json'), JSON.stringify({ id: 'M001' }));

      // M002: real milestone with a CONTEXT file
      const realDir = join(base, '.gsd', 'milestones', 'M002');
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, 'M002-CONTEXT.md'), '# Real Milestone\n\nThis has content.');

      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002', 'ghost+real: active milestone is M002');
      // Ghost M001 should not appear in the registry
      const m001Entry = state.registry.find(e => e.id === 'M001');
      assert.deepStrictEqual(m001Entry, undefined, 'ghost+real: M001 not in registry');
      assert.deepStrictEqual(state.registry.length, 1, 'ghost+real: registry has 1 entry');
      assert.deepStrictEqual(state.registry[0]?.status, 'active', 'ghost+real: M002 is active');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: queued milestone with worktree not flagged as ghost (#2921) ──
  test('queued milestone with worktree not flagged as ghost (#2921)', async () => {
    const base = createFixtureBase();
    try {
      // Create a milestone directory with only an empty slices subdir — no content files.
      // This would normally be a ghost, but it has a worktree directory.
      const milestoneDir = join(base, '.gsd', 'milestones', 'M002');
      mkdirSync(join(milestoneDir, 'slices'), { recursive: true });

      // Create a worktree directory for M002, simulating an active worktree
      const worktreeDir = join(base, '.gsd', 'worktrees', 'M002');
      mkdirSync(worktreeDir, { recursive: true });

      // isGhostMilestone should return false because the worktree exists
      assert.ok(!isGhostMilestone(base, 'M002'), 'M002 with worktree should NOT be a ghost');

      // Also create a completed M001 so deriveState has something before M002
      writeMilestoneSummary(base, 'M001', '# M001 Summary\n\nDone.');

      const state = await deriveState(base);
      // M002 should appear in the registry (not filtered as ghost)
      const m002Entry = state.registry.find(e => e.id === 'M002');
      assert.ok(m002Entry !== undefined, 'M002 should be in registry when worktree exists');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002', 'M002 should be active milestone');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test: zero-slice roadmap → pre-planning, not blocked (#1785) ────
  test('zero-slice roadmap → pre-planning, not blocked (#1785)', async () => {
    const base = createFixtureBase();
    try {
      // Write a stub roadmap with zero slices (placeholder text, no slice definitions)
      writeRoadmap(base, 'M001', `# M001: Stub Milestone\n\n**Vision:** Placeholder.\n\n## Slices\n\n_No slices defined yet._\n`);

      const state = await deriveState(base);

      assert.deepStrictEqual(state.phase, 'pre-planning', 'phase is pre-planning when roadmap has zero slices');
      assert.ok(state.activeMilestone !== null, 'activeMilestone is set');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'activeMilestone is M001');
      assert.deepStrictEqual(state.activeSlice, null, 'activeSlice is null');
      assert.deepStrictEqual(state.activeTask, null, 'activeTask is null');
      assert.deepStrictEqual(state.blockers.length, 0, 'no blockers reported');
      assert.ok(state.nextAction.includes('M001'), 'nextAction references M001');
    } finally {
      cleanup(base);
    }
  });
});
