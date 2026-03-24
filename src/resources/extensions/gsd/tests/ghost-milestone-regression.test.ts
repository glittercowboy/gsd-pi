// Regression test: ghost milestone directories must never become active.
//
// Ghost milestones are empty directories (or directories with only non-milestone
// files) under .gsd/milestones/. The isSubstantiveMilestone() filter and
// findMilestoneIds() ensure these are excluded from state derivation, so
// deriveState() always selects the real in-flight milestone.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState } from '../state.ts';
import { createTestContext } from './test-helpers.ts';
import { findMilestoneIds } from '../guided-flow.ts';
import { isSubstantiveMilestone } from '../milestone-ids.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-ghost-test-'));
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

function createGhostMilestone(base: string, mid: string): void {
  // Create an empty milestone directory — a "ghost" with no content
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Regression Test: Ghost Milestone Takeover
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ─── Test: Ghost directories should not steal active milestone status ─────
  console.log('\n=== ghost milestone directories should not become active ===');
  {
    const base = createFixtureBase();
    try {
      // Create ghost directories M001 and M002 (empty, no content)
      createGhostMilestone(base, 'M001');
      createGhostMilestone(base, 'M002');

      // Create a real M005 with a roadmap containing an incomplete slice
      writeRoadmap(base, 'M005', `# M005: Real Active Milestone

**Vision:** This is the milestone that should be active.

## Slices

- [ ] **S01: Work in Progress** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);

      // Add a plan with incomplete tasks so it's in executing phase
      writePlan(base, 'M005', 'S01', `# S01: Work in Progress

**Goal:** Execute real work.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: First Task** \`est:10m\`
  First task description.
`);

      // Verify the directories exist
      assertTrue(
        existsSync(join(base, '.gsd', 'milestones', 'M001')),
        'M001 ghost directory exists'
      );
      assertTrue(
        existsSync(join(base, '.gsd', 'milestones', 'M002')),
        'M002 ghost directory exists'
      );
      assertTrue(
        existsSync(join(base, '.gsd', 'milestones', 'M005', 'M005-ROADMAP.md')),
        'M005 has a real roadmap'
      );

      const state = await deriveState(base);

      // The core assertion: M005 should be active, NOT M001
      assertEq(
        state.activeMilestone?.id,
        'M005',
        'activeMilestone is M005 (real), not M001 (ghost)'
      );

      // The phase should be executing (M005 has a plan with incomplete tasks)
      assertEq(
        state.phase,
        'planning',
        'phase is planning (roadmap exists but no slice task plan file has been created yet)'
      );

      // M001 and M002 should NOT be in the registry with status 'active'
      const m001Entry = state.registry.find(e => e.id === 'M001');
      const m002Entry = state.registry.find(e => e.id === 'M002');
      const m005Entry = state.registry.find(e => e.id === 'M005');

      // Ghost milestones should not be marked as active
      assertTrue(
        m001Entry?.status !== 'active',
        'M001 (ghost) is not marked as active in registry'
      );
      assertTrue(
        m002Entry?.status !== 'active',
        'M002 (ghost) is not marked as active in registry'
      );

      // M005 should be the active one
      assertEq(
        m005Entry?.status,
        'active',
        'M005 is marked as active in registry'
      );

      // Registry should have only substantive milestones (ghosts excluded)
      assertEq(
        state.registry.length,
        1,
        'registry has 1 entry (M005 only - ghosts excluded)'
      );

      console.log('\n  Ghost milestone rejection test PASSED.');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test: Ghost-only project should not activate any milestone ──────────
  console.log('\n=== ghost-only project should not activate any milestone ===');
  {
    const base = createFixtureBase();
    try {
      // Create only ghost directories (no real content)
      createGhostMilestone(base, 'M001');
      createGhostMilestone(base, 'M002');
      createGhostMilestone(base, 'M003');

      const state = await deriveState(base);

      // With only ghost milestones, there should be no active milestone
      // Ghost milestones have no roadmap and no summary, so they shouldn't
      // become active
      assertEq(
        state.activeMilestone,
        null,
        'no active milestone when all are ghosts'
      );

      // Registry should either be empty or have all entries as non-active
      const activeEntries = state.registry.filter(e => e.status === 'active');
      assertEq(
        activeEntries.length,
        0,
        'no registry entries with status active'
      );

      console.log('\n  Ghost-only project test PASSED.');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test: Mixed complete and ghost milestones ─────────────────────────────
  console.log('\n=== mixed complete and ghost milestones ===');
  {
    const base = createFixtureBase();
    try {
      // M001: completed milestone (has summary)
      const m1dir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(m1dir, { recursive: true });
      writeFileSync(join(m1dir, 'M001-SUMMARY.md'), '---\nid: M001\n---\n# Bootstrap\nDone.');

      // M002: ghost (empty directory)
      createGhostMilestone(base, 'M002');

      // M003: active milestone with real content
      writeRoadmap(base, 'M003', `# M003: Active Milestone

**Vision:** Should be active despite ghost M002.

## Slices

- [ ] **S01: Work** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      const state = await deriveState(base);

      // M003 should be active, not M002 (ghost)
      assertEq(
        state.activeMilestone?.id,
        'M003',
        'activeMilestone is M003, not ghost M002'
      );

      const m002Entry = state.registry.find(e => e.id === 'M002');
      assertTrue(
        m002Entry?.status !== 'active',
        'M002 (ghost) is not active'
      );

      console.log('\n  Mixed complete and ghost test PASSED.');
    } finally {
      cleanup(base);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge Case Tests: isSubstantiveMilestone
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Edge Case: Milestone with only CONTEXT file ───────────────────────────
  console.log('\n=== milestone with only CONTEXT file is substantive ===');
  {
    const base = createFixtureBase();
    try {
      const m1dir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(m1dir, { recursive: true });
      writeFileSync(join(m1dir, 'M001-CONTEXT.md'), '---\nid: M001\n---\n# Context\nHas context only.');

      assertTrue(
        isSubstantiveMilestone(base, 'M001'),
        'M001 with only CONTEXT is substantive'
      );

      const ids = findMilestoneIds(base);
      assertEq(
        ids.includes('M001'),
        true,
        'M001 appears in findMilestoneIds result'
      );

      console.log('\n  CONTEXT-only milestone test PASSED.');
    } finally {
      cleanup(base);
    }
  }

  // ─── Edge Case: Milestone with only SUMMARY file ───────────────────────────
  console.log('\n=== milestone with only SUMMARY file is substantive ===');
  {
    const base = createFixtureBase();
    try {
      const m2dir = join(base, '.gsd', 'milestones', 'M002');
      mkdirSync(m2dir, { recursive: true });
      writeFileSync(join(m2dir, 'M002-SUMMARY.md'), '---\nid: M002\n---\n# Summary\nCompleted.');

      assertTrue(
        isSubstantiveMilestone(base, 'M002'),
        'M002 with only SUMMARY is substantive'
      );

      const ids = findMilestoneIds(base);
      assertEq(
        ids.includes('M002'),
        true,
        'M002 appears in findMilestoneIds result'
      );

      console.log('\n  SUMMARY-only milestone test PASSED.');
    } finally {
      cleanup(base);
    }
  }

  // ─── Edge Case: Milestone with only CONTEXT-DRAFT file ─────────────────────
  console.log('\n=== milestone with only CONTEXT-DRAFT file is substantive ===');
  {
    const base = createFixtureBase();
    try {
      const m3dir = join(base, '.gsd', 'milestones', 'M003');
      mkdirSync(m3dir, { recursive: true });
      writeFileSync(join(m3dir, 'M003-CONTEXT-DRAFT.md'), '---\nid: M003\n---\n# Draft\nWork in progress.');

      assertTrue(
        isSubstantiveMilestone(base, 'M003'),
        'M003 with only CONTEXT-DRAFT is substantive'
      );

      const ids = findMilestoneIds(base);
      assertEq(
        ids.includes('M003'),
        true,
        'M003 appears in findMilestoneIds result'
      );

      console.log('\n  CONTEXT-DRAFT-only milestone test PASSED.');
    } finally {
      cleanup(base);
    }
  }

  // ─── Edge Case: Completely empty directory ─────────────────────────────────
  console.log('\n=== completely empty directory is not substantive ===');
  {
    const base = createFixtureBase();
    try {
      createGhostMilestone(base, 'M004');

      assertTrue(
        !isSubstantiveMilestone(base, 'M004'),
        'M004 empty directory is not substantive'
      );

      const ids = findMilestoneIds(base);
      assertEq(
        ids.includes('M004'),
        false,
        'M004 does NOT appear in findMilestoneIds result'
      );

      console.log('\n  Empty directory test PASSED.');
    } finally {
      cleanup(base);
    }
  }

  // ─── Edge Case: Directory with only non-milestone file ─────────────────────
  console.log('\n=== directory with only non-milestone file is not substantive ===');
  {
    const base = createFixtureBase();
    try {
      const m5dir = join(base, '.gsd', 'milestones', 'M005');
      mkdirSync(m5dir, { recursive: true });
      writeFileSync(join(m5dir, 'notes.txt'), 'This is just some notes, not a milestone artifact.');

      assertTrue(
        !isSubstantiveMilestone(base, 'M005'),
        'M005 with only notes.txt is not substantive'
      );

      const ids = findMilestoneIds(base);
      assertEq(
        ids.includes('M005'),
        false,
        'M005 does NOT appear in findMilestoneIds result'
      );

      console.log('\n  Non-milestone file test PASSED.');
    } finally {
      cleanup(base);
    }
  }

  // ─── Edge Case: Milestone with populated slices/ directory ─────────────────
  console.log('\n=== milestone with populated slices directory is substantive ===');
  {
    const base = createFixtureBase();
    try {
      const m6dir = join(base, '.gsd', 'milestones', 'M006');
      mkdirSync(m6dir, { recursive: true });
      // Create slices/S01/ subdirectory (no artifact files)
      mkdirSync(join(m6dir, 'slices', 'S01'), { recursive: true });

      assertTrue(
        isSubstantiveMilestone(base, 'M006'),
        'M006 with only slices/ directory is substantive'
      );

      const ids = findMilestoneIds(base);
      assertEq(
        ids.includes('M006'),
        true,
        'M006 appears in findMilestoneIds result'
      );

      console.log('\n  Populated slices directory test PASSED.');
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
