import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, isSliceComplete, isMilestoneComplete } from '../state.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();
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
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
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

async function main(): Promise<void> {

  // ─── Test 1: empty milestones dir → pre-planning ───────────────────────
  console.log('\n=== empty milestones dir → pre-planning ===');
  {
    const base = createFixtureBase();
    try {
      const state = await deriveState(base);

      assertEq(state.phase, 'pre-planning', 'phase is pre-planning');
      assertEq(state.activeMilestone, null, 'activeMilestone is null');
      assertEq(state.activeSlice, null, 'activeSlice is null');
      assertEq(state.activeTask, null, 'activeTask is null');
      assertEq(state.registry, [], 'registry is empty');
      assertEq(state.progress?.milestones?.done, 0, 'milestones done = 0');
      assertEq(state.progress?.milestones?.total, 0, 'milestones total = 0');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 2: milestone dir exists but no roadmap → pre-planning ────────
  console.log('\n=== milestone dir exists but no roadmap → pre-planning ===');
  {
    const base = createFixtureBase();
    try {
      // Create M001 directory but no roadmap file
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });

      const state = await deriveState(base);

      assertEq(state.phase, 'pre-planning', 'phase is pre-planning');
      assertTrue(state.activeMilestone !== null, 'activeMilestone is not null');
      assertEq(state.activeMilestone?.id, 'M001', 'activeMilestone id is M001');
      assertEq(state.activeSlice, null, 'activeSlice is null');
      assertEq(state.activeTask, null, 'activeTask is null');
      assertEq(state.registry.length, 1, 'registry has 1 entry');
      assertEq(state.registry[0]?.status, 'active', 'registry entry status is active');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 3: roadmap with incomplete slice, no plan → planning ─────────
  console.log('\n=== roadmap with incomplete slice, no plan → planning ===');
  {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: Test Milestone

**Vision:** Test planning phase.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);

      const state = await deriveState(base);

      assertEq(state.phase, 'planning', 'phase is planning');
      assertTrue(state.activeSlice !== null, 'activeSlice is not null');
      assertEq(state.activeSlice?.id, 'S01', 'activeSlice id is S01');
      assertEq(state.activeTask, null, 'activeTask is null');
      assertEq(state.progress?.slices?.done, 0, 'slices done = 0');
      assertEq(state.progress?.slices?.total, 1, 'slices total = 1');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 4: roadmap + plan with incomplete tasks → executing ──────────
  console.log('\n=== roadmap + plan with incomplete tasks → executing ===');
  {
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

      assertEq(state.phase, 'executing', 'phase is executing');
      assertTrue(state.activeTask !== null, 'activeTask is not null');
      assertEq(state.activeTask?.id, 'T01', 'activeTask id is T01');
      assertEq(state.progress?.tasks?.done, 0, 'tasks done = 0');
      assertEq(state.progress?.tasks?.total, 2, 'tasks total = 2');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 5: executing + continue file → resume message ─────────────
  console.log('\n=== executing + continue file → resume message ===');
  {
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

      assertEq(state.phase, 'executing', 'interrupted: phase is executing');
      assertTrue(state.activeTask !== null, 'interrupted: activeTask is not null');
      assertEq(state.activeTask?.id, 'T01', 'interrupted: activeTask id is T01');
      assertTrue(
        state.nextAction.includes('Resume') || state.nextAction.includes('resume') || state.nextAction.includes('continue.md'),
        'interrupted: nextAction mentions Resume/resume/continue.md'
      );
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 6: all tasks done, slice not [x] → summarizing ──────────────
  console.log('\n=== all tasks done, slice not [x] → summarizing ===');
  {
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

      assertEq(state.phase, 'summarizing', 'summarizing: phase is summarizing');
      assertTrue(state.activeSlice !== null, 'summarizing: activeSlice is not null');
      assertEq(state.activeSlice?.id, 'S01', 'summarizing: activeSlice id is S01');
      assertEq(state.activeTask, null, 'summarizing: activeTask is null');
      assertTrue(
        state.nextAction.toLowerCase().includes('summary') || state.nextAction.toLowerCase().includes('complete'),
        'summarizing: nextAction mentions summary or complete'
      );
      assertEq(state.progress?.tasks?.done, 2, 'summarizing: tasks done = 2');
      assertEq(state.progress?.tasks?.total, 2, 'summarizing: tasks total = 2');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 7: all milestones complete → complete ────────────────────────
  console.log('\n=== all milestones complete → complete ===');
  {
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

      assertEq(state.phase, 'complete', 'complete: phase is complete');
      assertEq(state.activeSlice, null, 'complete: activeSlice is null');
      assertEq(state.activeTask, null, 'complete: activeTask is null');
      assertTrue(
        state.nextAction.toLowerCase().includes('complete'),
        'complete: nextAction mentions complete'
      );
      assertEq(state.registry.length, 1, 'complete: registry has 1 entry');
      assertEq(state.registry[0]?.status, 'complete', 'complete: registry[0] status is complete');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 8: blocked dependencies ──────────────────────────────────────
  console.log('\n=== blocked dependencies ===');
  {
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

      assertEq(state1.phase, 'executing', 'blocked-A: phase is executing (S01 active)');
      assertEq(state1.activeSlice?.id, 'S01', 'blocked-A: activeSlice is S01');
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

      assertEq(state2.phase, 'blocked', 'blocked-B: phase is blocked');
      assertEq(state2.activeSlice, null, 'blocked-B: activeSlice is null');
      assertTrue(state2.blockers.length > 0, 'blocked-B: blockers array is non-empty');
    } finally {
      cleanup(base2);
    }
  }

  // ─── Test 9: multi-milestone registry ──────────────────────────────────
  console.log('\n=== multi-milestone registry ===');
  {
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

      // M003: just a dir (no roadmap → pending since M002 is already active)
      mkdirSync(join(base, '.gsd', 'milestones', 'M003'), { recursive: true });

      const state = await deriveState(base);

      assertEq(state.registry.length, 3, 'multi-ms: registry has 3 entries');
      assertEq(state.registry[0]?.id, 'M001', 'multi-ms: registry[0] is M001');
      assertEq(state.registry[0]?.status, 'complete', 'multi-ms: M001 is complete');
      assertEq(state.registry[1]?.id, 'M002', 'multi-ms: registry[1] is M002');
      assertEq(state.registry[1]?.status, 'active', 'multi-ms: M002 is active');
      assertEq(state.registry[2]?.id, 'M003', 'multi-ms: registry[2] is M003');
      assertEq(state.registry[2]?.status, 'pending', 'multi-ms: M003 is pending');
      assertEq(state.activeMilestone?.id, 'M002', 'multi-ms: activeMilestone is M002');
      assertEq(state.progress?.milestones?.done, 1, 'multi-ms: milestones done = 1');
      assertEq(state.progress?.milestones?.total, 3, 'multi-ms: milestones total = 3');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 10: requirements integration ─────────────────────────────────
  console.log('\n=== requirements integration ===');
  {
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

      assertTrue(state.requirements !== undefined, 'requirements: requirements object exists');
      assertEq(state.requirements?.active, 2, 'requirements: active = 2');
      assertEq(state.requirements?.validated, 1, 'requirements: validated = 1');
      assertEq(state.requirements?.deferred, 2, 'requirements: deferred = 2');
      assertEq(state.requirements?.outOfScope, 1, 'requirements: outOfScope = 1');
      assertEq(state.requirements?.total, 6, 'requirements: total = 6 (sum of all)');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 11: all slices [x], no summary → completing-milestone ────────
  console.log('\n=== all slices [x], no summary → completing-milestone ===');
  {
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

      assertEq(state.phase, 'completing-milestone', 'completing-ms: phase is completing-milestone');
      assertTrue(state.activeMilestone !== null, 'completing-ms: activeMilestone is not null');
      assertEq(state.activeMilestone?.id, 'M001', 'completing-ms: activeMilestone id is M001');
      assertEq(state.activeSlice, null, 'completing-ms: activeSlice is null');
      assertEq(state.activeTask, null, 'completing-ms: activeTask is null');
      assertEq(state.registry.length, 1, 'completing-ms: registry has 1 entry');
      assertEq(state.registry[0]?.status, 'active', 'completing-ms: registry[0] status is active (not complete)');
      assertEq(state.progress?.slices?.done, 2, 'completing-ms: slices done = 2');
      assertEq(state.progress?.slices?.total, 2, 'completing-ms: slices total = 2');
      assertTrue(
        state.nextAction.toLowerCase().includes('summary') || state.nextAction.toLowerCase().includes('complete'),
        'completing-ms: nextAction mentions summary or complete'
      );
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 12: all slices [x], summary exists → complete ───────────────
  console.log('\n=== all slices [x], summary exists → complete ===');
  {
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

      assertEq(state.phase, 'complete', 'summary-exists: phase is complete');
      assertEq(state.registry.length, 1, 'summary-exists: registry has 1 entry');
      assertEq(state.registry[0]?.status, 'complete', 'summary-exists: registry[0] status is complete');
      assertEq(state.activeSlice, null, 'summary-exists: activeSlice is null');
      assertEq(state.activeTask, null, 'summary-exists: activeTask is null');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test 13: multi-milestone completing-milestone ─────────────────────
  console.log('\n=== multi-milestone completing-milestone ===');
  {
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

      assertEq(state.phase, 'completing-milestone', 'multi-completing: phase is completing-milestone');
      assertEq(state.activeMilestone?.id, 'M002', 'multi-completing: activeMilestone is M002');
      assertEq(state.activeSlice, null, 'multi-completing: activeSlice is null');
      assertEq(state.activeTask, null, 'multi-completing: activeTask is null');
      assertEq(state.registry.length, 3, 'multi-completing: registry has 3 entries');
      assertEq(state.registry[0]?.id, 'M001', 'multi-completing: registry[0] is M001');
      assertEq(state.registry[0]?.status, 'complete', 'multi-completing: M001 is complete');
      assertEq(state.registry[1]?.id, 'M002', 'multi-completing: registry[1] is M002');
      assertEq(state.registry[1]?.status, 'active', 'multi-completing: M002 is active (completing-milestone)');
      assertEq(state.registry[2]?.id, 'M003', 'multi-completing: registry[2] is M003');
      assertEq(state.registry[2]?.status, 'pending', 'multi-completing: M003 is pending');
      assertEq(state.progress?.milestones?.done, 1, 'multi-completing: milestones done = 1');
      assertEq(state.progress?.milestones?.total, 3, 'multi-completing: milestones total = 3');
      assertEq(state.progress?.slices?.done, 2, 'multi-completing: slices done = 2');
      assertEq(state.progress?.slices?.total, 2, 'multi-completing: slices total = 2');
    } finally {
      cleanup(base);
    }
  }

  // ═══ Milestone with summary but no roadmap → complete ═══════════════════
  {
    console.log('\n=== milestone with summary and no roadmap → complete ===');
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

      assertEq(state.phase, 'planning', 'summary-no-roadmap: phase is planning (active is M003)');
      assertEq(state.activeMilestone?.id, 'M003', 'summary-no-roadmap: active milestone is M003');
      assertEq(state.activeMilestone?.title, 'Polish', 'summary-no-roadmap: active title is Polish');
      assertEq(state.registry.length, 3, 'summary-no-roadmap: registry has 3 entries');
      assertEq(state.registry[0]?.status, 'complete', 'summary-no-roadmap: M001 is complete');
      assertEq(state.registry[0]?.title, 'Bootstrap', 'summary-no-roadmap: M001 title from summary');
      assertEq(state.registry[1]?.status, 'complete', 'summary-no-roadmap: M002 is complete');
      assertEq(state.registry[1]?.title, 'Core Features', 'summary-no-roadmap: M002 title from summary');
      assertEq(state.registry[2]?.status, 'active', 'summary-no-roadmap: M003 is active');
      assertEq(state.progress?.milestones?.done, 2, 'summary-no-roadmap: milestones done = 2');
      assertEq(state.progress?.milestones?.total, 3, 'summary-no-roadmap: milestones total = 3');
    } finally {
      cleanup(base);
    }
  }

  // ═══ All milestones have summary but no roadmap → complete ═════════════
  {
    console.log('\n=== all milestones summary-only → complete ===');
    const base = createFixtureBase();
    try {
      const m1dir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(m1dir, { recursive: true });
      writeFileSync(join(m1dir, 'M001-SUMMARY.md'), '---\ntitle: Done\n---\nAll done.');

      const state = await deriveState(base);
      assertEq(state.phase, 'complete', 'all-summary-only: phase is complete');
      assertEq(state.registry[0]?.status, 'complete', 'all-summary-only: M001 is complete');
    } finally {
      cleanup(base);
    }
  }

  // ─── Empty plan (zero tasks) stays in planning, not summarizing (#454) ──
  console.log('\n=== empty plan → planning (not summarizing) ===');
  {
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
      assertEq(state.phase, 'planning', 'empty plan stays in planning');
      assertEq(state.activeSlice?.id, 'S01', 'active slice is S01');
      assertEq(state.activeTask, null, 'no active task');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test: completed M001 (summary, no validation) skipped for active M003 (#864) ────
  console.log('\n=== completed milestone with summary but no validation is not active (#864) ===');
  {
    const base = createFixtureBase();
    try {
      // M001: all slices done, has summary, no validation
      writeRoadmap(base, 'M001', `# M001: First Milestone\n\n**Vision:** Done.\n\n## Slices\n\n- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`\n  > Completed.\n`);
      writeMilestoneSummary(base, 'M001', '---\nid: M001\n---\n\n# M001: First Milestone\n\n**Completed.**');
      // M003: incomplete, should be active
      writeRoadmap(base, 'M003', `# M003: Active Milestone\n\n**Vision:** Do stuff.\n\n## Slices\n\n- [ ] **S01: Work slice** \`risk:low\` \`depends:[]\`\n  > Needs work.\n`);

      const state = await deriveState(base);
      assertEq(state.activeMilestone?.id, 'M003', 'active milestone is M003, not completed M001');
      const m001Entry = state.registry.find(e => e.id === 'M001');
      assertEq(m001Entry?.status, 'complete', 'M001 is marked complete despite no validation');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test: completed M001 with summary AND validation is complete (#864) ────
  console.log('\n=== completed milestone with summary and validation is complete ===');
  {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: First Milestone\n\n**Vision:** Done.\n\n## Slices\n\n- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`\n  > Completed.\n`);
      writeMilestoneSummary(base, 'M001', '---\nid: M001\n---\n\n# M001: First Milestone\n\n**Completed.**');
      writeMilestoneValidation(base, 'M001', 'pass');
      writeRoadmap(base, 'M003', `# M003: Active Milestone\n\n**Vision:** Do stuff.\n\n## Slices\n\n- [ ] **S01: Work slice** \`risk:low\` \`depends:[]\`\n  > Needs work.\n`);

      const state = await deriveState(base);
      assertEq(state.activeMilestone?.id, 'M003', 'active milestone is M003');
      const m001Entry = state.registry.find(e => e.id === 'M001');
      assertEq(m001Entry?.status, 'complete', 'M001 with both summary and validation is complete');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test: all slices done, no summary, no validation → needs validation (#864) ────
  console.log('\n=== all slices done, no summary, no validation → validating-milestone ===');
  {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: First Milestone\n\n**Vision:** Validate me.\n\n## Slices\n\n- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`\n  > Completed.\n`);
      // No summary, no validation — this should be active for validation

      const state = await deriveState(base);
      assertEq(state.activeMilestone?.id, 'M001', 'M001 is active for validation');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test: all slices done, validation pass, no summary → needs completion (#864) ────
  console.log('\n=== all slices done, validation pass, no summary → completing-milestone ===');
  {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', `# M001: First Milestone\n\n**Vision:** Complete me.\n\n## Slices\n\n- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`\n  > Completed.\n`);
      writeMilestoneValidation(base, 'M001', 'pass');
      // No summary — validated but not yet completed

      const state = await deriveState(base);
      assertEq(state.activeMilestone?.id, 'M001', 'M001 is active for completion');
    } finally {
      cleanup(base);
    }
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
