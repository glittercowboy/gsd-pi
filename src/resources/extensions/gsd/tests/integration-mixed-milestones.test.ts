/**
 * Integration tests: deriveState, indexWorkspace, inlinePriorMilestoneSummary,
 * dispatch-guard, and branch operations with unique-format (M001-abc123) and
 * mixed classic+unique milestone directories.
 *
 * Uses real filesystem and git fixtures — no mocking.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState } from '../state.ts';
import { indexWorkspace } from '../workspace-index.ts';
import { inlinePriorMilestoneSummary } from '../files.ts';
import { getPriorSliceCompletionBlocker } from '../dispatch-guard.ts';
import {
  getSliceBranchName,
  parseSliceBranch,
} from '../worktree.ts';
import { clearPathCache } from '../paths.ts';
import { createTestContext } from './test-helpers.ts';

// ─── Assertion Helpers ────────────────────────────────────────────────────

const { assertEq, assertTrue, assertMatch, report } = createTestContext();
// ─── Fixture Helpers ──────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-integration-mixed-'));
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

function writeMilestoneSummary(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }).trim();
}

function createGitRepo(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-integration-git-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  run('git init -b main', base);
  run("git config user.name 'Integration Test'", base);
  run("git config user.email 'test@example.com'", base);
  return base;
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Groups
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {

  // ─── Group 1: deriveState with new-format-only milestones ─────────────
  console.log('\n=== Group 1: deriveState with new-format-only milestones ===');
  {
    const base = createFixtureBase();
    try {
      // Create M001-abc123 with roadmap + 2 slices (S01 complete, S02 in-progress)
      writeRoadmap(base, 'M001-abc123', `# M001-abc123: Test Feature

**Vision:** Test vision

## Slices
- [x] **S01: Setup** \`risk:low\` \`depends:[]\`
  > Foundation work
- [ ] **S02: Core Logic** \`risk:medium\` \`depends:[]\`
  > Main implementation
`);

      // S01 is complete — write a plan with all tasks done
      writePlan(base, 'M001-abc123', 'S01', `# S01: Setup

**Goal:** Setup
**Demo:** Setup works

## Tasks
- [x] **T01: Init** \`est:10m\`
  Initialize project.
`);

      // S02 is in-progress — write a plan with first task not done
      writePlan(base, 'M001-abc123', 'S02', `# S02: Core Logic

**Goal:** Implement core
**Demo:** Core works

## Tasks
- [ ] **T01: Build core** \`est:20m\`
  Build the core logic.
- [ ] **T02: Test core** \`est:15m\`
  Test the core logic.
`);

      const state = await deriveState(base);

      // Phase should be executing (active milestone with incomplete slice + plan + tasks)
      assertEq(state.phase, 'executing', 'G1: phase is executing');
      assertTrue(state.activeMilestone !== null, 'G1: activeMilestone is not null');
      assertEq(state.activeMilestone?.id, 'M001-abc123', 'G1: activeMilestone id is M001-abc123');
      assertEq(state.activeMilestone?.title, 'Test Feature', 'G1: title stripped to Test Feature');

      // Registry
      assertEq(state.registry.length, 1, 'G1: registry has 1 entry');
      assertEq(state.registry[0]?.id, 'M001-abc123', 'G1: registry entry id');
      assertEq(state.registry[0]?.status, 'active', 'G1: registry entry status is active');
      assertEq(state.registry[0]?.title, 'Test Feature', 'G1: registry title stripped');

      // Active slice
      assertTrue(state.activeSlice !== null, 'G1: activeSlice is not null');
      assertEq(state.activeSlice?.id, 'S02', 'G1: activeSlice is S02');

      // Progress
      assertEq(state.progress?.milestones?.done, 0, 'G1: milestones done = 0');
      assertEq(state.progress?.milestones?.total, 1, 'G1: milestones total = 1');
    } finally {
      cleanup(base);
    }
  }

  // ─── Group 2: deriveState with mixed-format milestones ────────────────
  console.log('\n=== Group 2: deriveState with mixed old+new format milestones ===');
  {
    const base = createFixtureBase();
    try {
      // M001 — complete milestone (all slices done + summary)
      writeRoadmap(base, 'M001', `# M001: Legacy Feature

**Vision:** Legacy vision

## Slices
- [x] **S01: Only Slice** \`risk:low\` \`depends:[]\`
  > Done
`);

      writePlan(base, 'M001', 'S01', `# S01: Only Slice

**Goal:** Done
**Demo:** Works

## Tasks
- [x] **T01: Do it** \`est:10m\`
  Did it.
`);

      writeMilestoneSummary(base, 'M001', `# M001: Legacy Feature Summary

**One-liner summary**

## What Happened
Everything worked.
`);

      // M002-abc123 — active milestone (incomplete slice)
      writeRoadmap(base, 'M002-abc123', `# M002-abc123: New Feature

**Vision:** New vision

## Slices
- [x] **S01: Setup** \`risk:low\` \`depends:[]\`
  > Setup done
- [ ] **S02: Implementation** \`risk:medium\` \`depends:[]\`
  > Main work
`);

      writePlan(base, 'M002-abc123', 'S01', `# S01: Setup

**Goal:** Setup
**Demo:** Setup done

## Tasks
- [x] **T01: Init** \`est:10m\`
  Init done.
`);

      writePlan(base, 'M002-abc123', 'S02', `# S02: Implementation

**Goal:** Implement
**Demo:** Works

## Tasks
- [ ] **T01: Build** \`est:20m\`
  Build it.
`);

      const state = await deriveState(base);

      // Registry — should have 2 entries sorted by seq number
      assertEq(state.registry.length, 2, 'G2: registry has 2 entries');
      assertEq(state.registry[0]?.id, 'M001', 'G2: registry[0] is M001 (sorted first)');
      assertEq(state.registry[1]?.id, 'M002-abc123', 'G2: registry[1] is M002-abc123 (sorted second)');

      // M001 is complete
      assertEq(state.registry[0]?.status, 'complete', 'G2: M001 status is complete');
      assertEq(state.registry[0]?.title, 'Legacy Feature', 'G2: M001 title stripped');

      // M002-abc123 is active
      assertEq(state.registry[1]?.status, 'active', 'G2: M002-abc123 status is active');
      assertEq(state.registry[1]?.title, 'New Feature', 'G2: M002-abc123 title stripped');

      // Active milestone
      assertTrue(state.activeMilestone !== null, 'G2: activeMilestone is not null');
      assertEq(state.activeMilestone?.id, 'M002-abc123', 'G2: activeMilestone is M002-abc123');
      assertEq(state.activeMilestone?.title, 'New Feature', 'G2: activeMilestone title stripped');

      // Phase
      assertEq(state.phase, 'executing', 'G2: phase is executing');

      // Active slice
      assertEq(state.activeSlice?.id, 'S02', 'G2: activeSlice is S02');

      // Progress
      assertEq(state.progress?.milestones?.done, 1, 'G2: milestones done = 1');
      assertEq(state.progress?.milestones?.total, 2, 'G2: milestones total = 2');
    } finally {
      cleanup(base);
    }
  }

  // ─── Group 3: indexWorkspace with mixed-format milestones ─────────────
  console.log('\n=== Group 3: indexWorkspace with mixed-format milestones ===');
  {
    const base = createFixtureBase();
    try {
      // Same fixture as Group 2: M001 (complete) + M002-abc123 (active)
      writeRoadmap(base, 'M001', `# M001: Legacy Feature

**Vision:** Legacy vision

## Slices
- [x] **S01: Only Slice** \`risk:low\` \`depends:[]\`
  > Done
`);

      writePlan(base, 'M001', 'S01', `# S01: Only Slice

**Goal:** Done
**Demo:** Works

## Tasks
- [x] **T01: Do it** \`est:10m\`
  Did it.
`);

      writeMilestoneSummary(base, 'M001', `# M001: Legacy Feature Summary

**One-liner summary**

## What Happened
Everything worked.
`);

      writeRoadmap(base, 'M002-abc123', `# M002-abc123: New Feature

**Vision:** New vision

## Slices
- [ ] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > First work
`);

      writePlan(base, 'M002-abc123', 'S01', `# S01: First Slice

**Goal:** First
**Demo:** First works

## Tasks
- [ ] **T01: Build** \`est:20m\`
  Build it.
`);

      const index = await indexWorkspace(base);

      // Both milestones indexed
      assertEq(index.milestones.length, 2, 'G3: 2 milestones in index');
      assertEq(index.milestones[0]?.id, 'M001', 'G3: index[0] is M001');
      assertEq(index.milestones[1]?.id, 'M002-abc123', 'G3: index[1] is M002-abc123');

      // Titles stripped from both formats
      assertEq(index.milestones[0]?.title, 'Legacy Feature', 'G3: M001 title stripped');
      assertEq(index.milestones[1]?.title, 'New Feature', 'G3: M002-abc123 title stripped');

      // Active state
      assertEq(index.active.milestoneId, 'M002-abc123', 'G3: active milestone is M002-abc123');
      assertEq(index.active.sliceId, 'S01', 'G3: active slice is S01');

      // Scopes include new-format paths
      assertTrue(
        index.scopes.some(s => s.scope === 'M002-abc123'),
        'G3: scope includes M002-abc123 milestone',
      );
      assertTrue(
        index.scopes.some(s => s.scope === 'M002-abc123/S01'),
        'G3: scope includes M002-abc123/S01 slice',
      );
      assertTrue(
        index.scopes.some(s => s.scope === 'M002-abc123/S01/T01'),
        'G3: scope includes M002-abc123/S01/T01 task',
      );
    } finally {
      cleanup(base);
    }
  }

  // ─── Group 4: inlinePriorMilestoneSummary with mixed formats ──────────
  console.log('\n=== Group 4: inlinePriorMilestoneSummary with mixed formats ===');
  {
    const base = createFixtureBase();
    try {
      // M001 — completed with summary
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
      writeMilestoneSummary(base, 'M001', `# M001: Legacy Feature Summary

**Completed legacy feature**

## What Happened
Built the legacy feature successfully.

## Key Decisions
- Used old format for milestone IDs.
`);

      // M002-abc123 — active milestone (just needs directory to exist)
      mkdirSync(join(base, '.gsd', 'milestones', 'M002-abc123'), { recursive: true });

      const result = await inlinePriorMilestoneSummary('M002-abc123', base);

      // Result should be non-null (M001 is before M002-abc123)
      assertTrue(result !== null, 'G4: result is non-null');
      assertTrue(typeof result === 'string', 'G4: result is a string');

      // Should contain the M001 summary content
      assertTrue(result!.includes('Prior Milestone Summary'), 'G4: contains Prior Milestone Summary header');
      assertTrue(result!.includes('Built the legacy feature successfully'), 'G4: contains M001 summary content');
      assertTrue(result!.includes('Used old format for milestone IDs'), 'G4: contains M001 key decisions');
    } finally {
      cleanup(base);
    }
  }

  // ─── Group 5: dispatch-guard with new-format milestones ──────────────
  console.log('\n=== Group 5: dispatch-guard with new-format milestones ===');
  {
    const base = createGitRepo();
    try {
      // M001-abc123: all slices complete
      writeRoadmap(base, 'M001-abc123', `# M001-abc123: First Feature

**Vision:** First

## Slices
- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > Completed
`);

      // M002-abc123: S01 incomplete
      writeRoadmap(base, 'M002-abc123', `# M002-abc123: Second Feature

**Vision:** Second

## Slices
- [ ] **S01: Pending** \`risk:low\` \`depends:[]\`
  > Not started
- [ ] **S02: Also Pending** \`risk:low\` \`depends:[S01]\`
  > Not started
`);

      // Initial commit so dispatch-guard can read from git branch
      writeFileSync(join(base, 'README.md'), 'init\n');
      run('git add .', base);
      run('git commit -m init', base);

      // No blocker: M001-abc123 is complete, dispatching M002-abc123/S01
      assertEq(
        getPriorSliceCompletionBlocker(base, 'main', 'plan-slice', 'M002-abc123/S01'),
        null,
        'G5: no blocker for M002-abc123/S01 when M001-abc123 all complete',
      );

      // No blocker for first slice of first milestone
      assertEq(
        getPriorSliceCompletionBlocker(base, 'main', 'execute-task', 'M001-abc123/S01/T01'),
        null,
        'G5: no blocker for M001-abc123/S01/T01 (first milestone first slice)',
      );

      // Blocker: trying to dispatch M002-abc123/S02 when S01 is incomplete
      assertMatch(
        getPriorSliceCompletionBlocker(base, 'main', 'execute-task', 'M002-abc123/S02/T01') ?? '',
        /earlier slice M002-abc123\/S01 is not complete/,
        'G5: blocks M002-abc123/S02 when S01 incomplete',
      );

      // Non-slice dispatch type should not be blocked
      assertEq(
        getPriorSliceCompletionBlocker(base, 'main', 'plan-milestone', 'M002-abc123'),
        null,
        'G5: non-slice dispatch type not blocked',
      );

      // Mixed format: M001 (incomplete) + M002-abc123
      writeRoadmap(base, 'M001', `# M001: Legacy Feature

**Vision:** Legacy

## Slices
- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > Done
- [ ] **S02: Pending** \`risk:low\` \`depends:[S01]\`
  > Pending
`);
      run('git add .', base);
      run('git commit -m add-m001', base);
      clearPathCache();

      // M001 (seq=1) < M001-abc123 (seq=1) — but M001 has incomplete S02
      // Since M001 seq=1 and M002-abc123 seq=2, blocker should reference M001/S02
      assertMatch(
        getPriorSliceCompletionBlocker(base, 'main', 'plan-slice', 'M002-abc123/S01') ?? '',
        /earlier slice M001\/S02 is not complete/,
        'G5: mixed-format blocker references M001/S02',
      );

      // Complete M001 and verify no blocker
      writeRoadmap(base, 'M001', `# M001: Legacy Feature

**Vision:** Legacy

## Slices
- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > Done
- [x] **S02: Done** \`risk:low\` \`depends:[S01]\`
  > Done
`);
      run('git add .', base);
      run('git commit -m complete-m001', base);
      clearPathCache();

      assertEq(
        getPriorSliceCompletionBlocker(base, 'main', 'plan-slice', 'M002-abc123/S01'),
        null,
        'G5: no blocker after M001 completed (mixed format)',
      );

      // M001-abc123 still has all complete, M002-abc123/S01 still incomplete
      // Check that S02 of M002-abc123 is still blocked by its own S01
      assertMatch(
        getPriorSliceCompletionBlocker(base, 'main', 'execute-task', 'M002-abc123/S02/T01') ?? '',
        /earlier slice M002-abc123\/S01 is not complete/,
        'G5: intra-milestone blocker still works in mixed-format context',
      );
    } finally {
      cleanup(base);
    }
  }

  // ─── Group 6: Branch name helpers with new-format IDs ───────────────
  console.log('\n=== Group 6: Branch name helpers with new-format IDs ===');
  {
    // Test getSliceBranchName with new-format ID
    assertEq(
      getSliceBranchName('M001-abc123', 'S01'),
      'gsd/M001-abc123/S01',
      'G6: getSliceBranchName returns gsd/M001-abc123/S01',
    );

    // Test parseSliceBranch with new-format branch name
    const parsed = parseSliceBranch('gsd/M001-abc123/S01');
    assertTrue(parsed !== null, 'G6: parseSliceBranch returns non-null for new-format');
    assertEq(parsed?.milestoneId, 'M001-abc123', 'G6: parsed milestoneId is M001-abc123');
    assertEq(parsed?.sliceId, 'S01', 'G6: parsed sliceId is S01');
    assertEq(parsed?.worktreeName, null, 'G6: parsed worktreeName is null (no worktree)');
  }

  // ─── Summary ──────────────────────────────────────────────────────────
  report();
}

// When run via vitest, wrap in test(); when run via tsx, call directly.
const isVitest = typeof globalThis !== 'undefined' && (globalThis as any).__vitest_worker__?.config?.defines != null && 'vitest' in (globalThis as any).__vitest_worker__.config.defines || process.env.VITEST;
if (isVitest) {
  const { test } = await import('vitest');
  test('integration-mixed-milestones: all groups pass', async () => {
    await main();
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
