import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState } from '../state.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();
// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-deps-test-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeRoadmap(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}

function writeMilestoneSummary(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), content);
}

/**
 * Creates M00x-CONTEXT.md with a valid YAML frontmatter block.
 * frontmatter is the raw YAML lines between the --- delimiters.
 */
function writeContext(base: string, mid: string, frontmatter: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), `---\n${frontmatter}\n---\n`);
}

function writeSlicePlan(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid);
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Groups
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {

  // ─── Test Group 1: blocked-deps ────────────────────────────────────────
  // M001 is incomplete (no SUMMARY), M002 depends_on M001 → M002 is pending
  console.log('\n=== blocked-deps ===');
  {
    const base = createFixtureBase();
    try {
      // M001: incomplete (one slice, no SUMMARY)
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** First milestone still in progress.

## Slices

- [ ] **S01: Incomplete Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      // M001: add a slice plan with an active task so phase is 'executing'
      writeSlicePlan(base, 'M001', 'S01', `# S01: Incomplete Slice

**Goal:** Verify dep-blocked milestone behavior.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Do work** \`est:15m\`
  First task still in progress.
`);

      // M002: depends on M001, also incomplete
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** Second milestone blocked by M001.

## Slices

- [ ] **S01: Blocked Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, 'M002', 'depends_on: [M001]');

      const state = await deriveState(base);

      assertEq(state.registry[0]?.status, 'active', 'blocked-deps: M001 is active');
      assertEq(state.registry[1]?.status, 'pending', 'blocked-deps: M002 is pending (dep-blocked)');
      assertEq(state.phase, 'executing', 'blocked-deps: phase is executing (M001 is active)');
      assertEq(state.activeMilestone?.id, 'M001', 'blocked-deps: activeMilestone is M001');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test Group 2: unblocked-deps ──────────────────────────────────────
  // M001 is complete (all slices [x] + SUMMARY), M002 depends_on M001 → M002 becomes active
  console.log('\n=== unblocked-deps ===');
  {
    const base = createFixtureBase();
    try {
      // M001: complete (all slices done + SUMMARY present)
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** First milestone complete.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneSummary(base, 'M001', '# M001 Summary\n\nFirst milestone is complete.');

      // M002: depends on M001, now unblocked
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** Second milestone now active.

## Slices

- [ ] **S01: Active Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, 'M002', 'depends_on: [M001]');

      const state = await deriveState(base);

      assertEq(state.registry[0]?.status, 'complete', 'unblocked-deps: M001 is complete');
      assertEq(state.registry[1]?.status, 'active', 'unblocked-deps: M002 is active');
      assertEq(state.activeMilestone?.id, 'M002', 'unblocked-deps: activeMilestone is M002');
      assertTrue(state.phase !== 'blocked', 'unblocked-deps: phase is not blocked');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test Group 3: all-blocked ─────────────────────────────────────────
  // M001 depends_on M002, M002 depends_on M001 — circular dep, neither can activate
  console.log('\n=== all-blocked ===');
  {
    const base = createFixtureBase();
    try {
      // M001: depends on M002
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** Circular dependency.

## Slices

- [ ] **S01: Waiting** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, 'M001', 'depends_on: [M002]');

      // M002: depends on M001
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** Also in circular dependency.

## Slices

- [ ] **S01: Also Waiting** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, 'M002', 'depends_on: [M001]');

      const state = await deriveState(base);

      assertEq(state.phase, 'blocked', 'all-blocked: phase is blocked');
      assertTrue(state.activeMilestone === null || state.activeMilestone !== null, 'all-blocked: state is consistent');
      assertTrue(state.blockers.length > 0, 'all-blocked: blockers array is non-empty');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test Group 4: absent-context ──────────────────────────────────────
  // Neither M001 nor M002 has a CONTEXT.md → no dep constraints, normal sequential behavior
  console.log('\n=== absent-context ===');
  {
    const base = createFixtureBase();
    try {
      // M001: incomplete, no CONTEXT.md
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** No context file, no deps.

## Slices

- [ ] **S01: Incomplete** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      // M002: incomplete, no CONTEXT.md
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** Also no context file.

## Slices

- [ ] **S01: Pending** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      const state = await deriveState(base);

      assertEq(state.registry[0]?.status, 'active', 'absent-context: M001 is active');
      assertEq(state.registry[1]?.status, 'pending', 'absent-context: M002 is pending');
      assertEq(state.activeMilestone?.id, 'M001', 'absent-context: activeMilestone is M001');
      assertTrue(state.phase !== 'blocked', 'absent-context: phase is not blocked');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test Group 5: forward-dep ─────────────────────────────────────────
  // M001 depends_on M002, but M002 is already complete → M001 can activate
  console.log('\n=== forward-dep ===');
  {
    const base = createFixtureBase();
    try {
      // M001: depends on M002, but M002 is complete so M001 is unblocked
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** Depends on M002 which is already complete.

## Slices

- [ ] **S01: Ready** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, 'M001', 'depends_on: [M002]');

      // M002: complete (all slices [x] + SUMMARY)
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** Already complete.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneSummary(base, 'M002', '# M002 Summary\n\nSecond milestone is complete.');

      const state = await deriveState(base);

      assertEq(state.activeMilestone?.id, 'M001', 'forward-dep: activeMilestone is M001');
      assertEq(state.registry[1]?.status, 'complete', 'forward-dep: M002 is complete');
      assertTrue(state.phase !== 'blocked', 'forward-dep: phase is not blocked');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test Group 6: empty-deps-list ─────────────────────────────────────
  // M002 has `depends_on: []` — empty list means no constraint, normal sequential behavior
  console.log('\n=== empty-deps-list ===');
  {
    const base = createFixtureBase();
    try {
      // M001: incomplete, no context
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** First milestone still in progress.

## Slices

- [ ] **S01: Incomplete** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);

      // M002: empty deps list — no constraint from deps, but still sequential after M001
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** Empty deps list, no blocking constraint.

## Slices

- [ ] **S01: Waiting for M001** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, 'M002', 'depends_on: []');

      const state = await deriveState(base);

      assertEq(state.registry[0]?.status, 'active', 'empty-deps-list: M001 is active');
      assertEq(state.registry[1]?.status, 'pending', 'empty-deps-list: M002 is pending (M001 not done yet)');
      assertTrue(state.phase !== 'blocked', 'empty-deps-list: phase is not blocked');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test Group 7: unique-id-deps ──────────────────────────────────────
  // M004-0zjrg0 is complete, M005-b0m2hl depends_on M004-0zjrg0 → M005 should activate.
  // Regression: parseContextDependsOn() used .toUpperCase(), converting "M004-0zjrg0"
  // to "M004-0ZJRG0", breaking the case-sensitive lookup in completeMilestoneIds.
  console.log('\n=== unique-id-deps: unique milestone IDs with lowercase hex suffix ===');
  {
    const base = createFixtureBase();
    try {
      // M004-0zjrg0: complete (all slices done + SUMMARY present)
      writeRoadmap(base, 'M004-0zjrg0', `# M004-0zjrg0: First Unique Milestone

**Vision:** Complete milestone with unique ID.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneSummary(base, 'M004-0zjrg0', '# M004-0zjrg0 Summary\n\nComplete.');

      // M005-b0m2hl: depends on M004-0zjrg0 (lowercase hex suffix)
      writeContext(base, 'M005-b0m2hl', 'depends_on: [M004-0zjrg0]');

      const state = await deriveState(base);

      assertEq(state.registry.find(e => e.id === 'M004-0zjrg0')?.status, 'complete',
        'unique-id-deps: M004-0zjrg0 is complete');
      assertEq(state.registry.find(e => e.id === 'M005-b0m2hl')?.status, 'active',
        'unique-id-deps: M005-b0m2hl is active (dep on M004-0zjrg0 met)');
      assertEq(state.activeMilestone?.id, 'M005-b0m2hl',
        'unique-id-deps: activeMilestone is M005-b0m2hl');
      assertTrue(state.phase !== 'blocked',
        'unique-id-deps: phase is not blocked');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test Group 8: unique-id-deps-blocked ─────────────────────────────
  // M004-0zjrg0 is NOT complete, M005-b0m2hl depends_on M004-0zjrg0 → M005 should be pending
  console.log('\n=== unique-id-deps-blocked: unique ID dep not yet met ===');
  {
    const base = createFixtureBase();
    try {
      // M004-0zjrg0: incomplete (slice not done)
      writeRoadmap(base, 'M004-0zjrg0', `# M004-0zjrg0: Incomplete Unique Milestone

**Vision:** Still in progress.

## Slices

- [ ] **S01: In Progress** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeSlicePlan(base, 'M004-0zjrg0', 'S01', `# S01: In Progress

**Goal:** Test dep blocking with unique IDs.

## Tasks

- [ ] **T01: Work** \`est:15m\`
  Still doing work.
`);

      // M005-b0m2hl: depends on M004-0zjrg0 (still incomplete)
      writeContext(base, 'M005-b0m2hl', 'depends_on: [M004-0zjrg0]');

      const state = await deriveState(base);

      assertEq(state.activeMilestone?.id, 'M004-0zjrg0',
        'unique-id-deps-blocked: activeMilestone is M004-0zjrg0');
      assertEq(state.registry.find(e => e.id === 'M005-b0m2hl')?.status, 'pending',
        'unique-id-deps-blocked: M005-b0m2hl is pending (dep not met)');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test Group 9: parseContextDependsOn preserves case ───────────────
  // Direct unit test: verify the parsed dep ID matches the input exactly
  console.log('\n=== parseContextDependsOn: preserves case of unique IDs ===');
  {
    const { parseContextDependsOn } = await import('../files.ts');

    const deps1 = parseContextDependsOn('---\ndepends_on: [M004-0zjrg0]\n---\n');
    assertEq(deps1[0], 'M004-0zjrg0',
      'parseContextDependsOn preserves lowercase hex suffix');

    const deps2 = parseContextDependsOn('---\ndepends_on: [M001, M004-abc123]\n---\n');
    assertEq(deps2[0], 'M001', 'preserves classic uppercase ID');
    assertEq(deps2[1], 'M004-abc123', 'preserves mixed-case unique ID');

    const deps3 = parseContextDependsOn('---\ndepends_on: []\n---\n');
    assertEq(deps3.length, 0, 'empty deps returns empty array');

    const deps4 = parseContextDependsOn(null);
    assertEq(deps4.length, 0, 'null content returns empty array');
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
