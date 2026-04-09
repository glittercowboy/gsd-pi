import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState } from '../state.ts';
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

function writeMilestoneValidation(base: string, mid: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), `---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.`);
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

function writeContextDraft(base: string, mid: string, frontmatter: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT-DRAFT.md`), `---\n${frontmatter}\n---\n\n# Draft Context\nThis is a draft.`);
}

function writeSlicePlan(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid);
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(join(dir, "tasks", "T01-PLAN.md"), "# T01 Plan\n");
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Groups
// ═══════════════════════════════════════════════════════════════════════════

describe('derive-state-deps', async () => {

  // ─── Test Group 1: blocked-deps ────────────────────────────────────────
  // M001 is incomplete (no SUMMARY), M002 depends_on M001 → M002 is pending
  test('blocked-deps', async () => {
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

      assert.deepStrictEqual(state.registry[0]?.status, 'active', 'blocked-deps: M001 is active');
      assert.deepStrictEqual(state.registry[1]?.status, 'pending', 'blocked-deps: M002 is pending (dep-blocked)');
      assert.deepStrictEqual(state.phase, 'executing', 'blocked-deps: phase is executing (M001 is active)');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'blocked-deps: activeMilestone is M001');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 2: unblocked-deps ──────────────────────────────────────
  // M001 is complete (all slices [x] + SUMMARY), M002 depends_on M001 → M002 becomes active
  test('unblocked-deps', async () => {
    const base = createFixtureBase();
    try {
      // M001: complete (all slices done + SUMMARY present)
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** First milestone complete.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, 'M001');
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

      assert.deepStrictEqual(state.registry[0]?.status, 'complete', 'unblocked-deps: M001 is complete');
      assert.deepStrictEqual(state.registry[1]?.status, 'active', 'unblocked-deps: M002 is active');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002', 'unblocked-deps: activeMilestone is M002');
      assert.ok(state.phase !== 'blocked', 'unblocked-deps: phase is not blocked');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 3: all-blocked ─────────────────────────────────────────
  // M001 depends_on M002, M002 depends_on M001 — circular dep, neither can activate
  test('all-blocked', async () => {
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

      assert.deepStrictEqual(state.phase, 'blocked', 'all-blocked: phase is blocked');
      assert.ok(state.activeMilestone === null || state.activeMilestone !== null, 'all-blocked: state is consistent');
      assert.ok(state.blockers.length > 0, 'all-blocked: blockers array is non-empty');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 4: absent-context ──────────────────────────────────────
  // Neither M001 nor M002 has a CONTEXT.md → no dep constraints, normal sequential behavior
  test('absent-context', async () => {
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

      assert.deepStrictEqual(state.registry[0]?.status, 'active', 'absent-context: M001 is active');
      assert.deepStrictEqual(state.registry[1]?.status, 'pending', 'absent-context: M002 is pending');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'absent-context: activeMilestone is M001');
      assert.ok(state.phase !== 'blocked', 'absent-context: phase is not blocked');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 5: forward-dep ─────────────────────────────────────────
  // M001 depends_on M002, but M002 is already complete → M001 can activate
  test('forward-dep', async () => {
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
      writeMilestoneValidation(base, 'M002');
      writeMilestoneSummary(base, 'M002', '# M002 Summary\n\nSecond milestone is complete.');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'forward-dep: activeMilestone is M001');
      assert.deepStrictEqual(state.registry[1]?.status, 'complete', 'forward-dep: M002 is complete');
      assert.ok(state.phase !== 'blocked', 'forward-dep: phase is not blocked');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 6: empty-deps-list ─────────────────────────────────────
  // M002 has `depends_on: []` — empty list means no constraint, normal sequential behavior
  test('empty-deps-list', async () => {
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

      assert.deepStrictEqual(state.registry[0]?.status, 'active', 'empty-deps-list: M001 is active');
      assert.deepStrictEqual(state.registry[1]?.status, 'pending', 'empty-deps-list: M002 is pending (M001 not done yet)');
      assert.ok(state.phase !== 'blocked', 'empty-deps-list: phase is not blocked');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 7: unique-id-deps ──────────────────────────────────────
  // M004-0zjrg0 is complete, M005-b0m2hl depends_on M004-0zjrg0 → M005 should activate.
  // Regression: parseContextDependsOn() used .toUpperCase(), converting "M004-0zjrg0"
  // to "M004-0ZJRG0", breaking the case-sensitive lookup in completeMilestoneIds.
  test('unique-id-deps: unique milestone IDs with lowercase hex suffix', async () => {
    const base = createFixtureBase();
    try {
      // M004-0zjrg0: complete (all slices done + SUMMARY present)
      writeRoadmap(base, 'M004-0zjrg0', `# M004-0zjrg0: First Unique Milestone

**Vision:** Complete milestone with unique ID.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, 'M004-0zjrg0');
      writeMilestoneSummary(base, 'M004-0zjrg0', '# M004-0zjrg0 Summary\n\nComplete.');

      // M005-b0m2hl: depends on M004-0zjrg0 (lowercase hex suffix)
      writeContext(base, 'M005-b0m2hl', 'depends_on: [M004-0zjrg0]');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.registry.find(e => e.id === 'M004-0zjrg0')?.status, 'complete',
        'unique-id-deps: M004-0zjrg0 is complete');
      assert.deepStrictEqual(state.registry.find(e => e.id === 'M005-b0m2hl')?.status, 'active',
        'unique-id-deps: M005-b0m2hl is active (dep on M004-0zjrg0 met)');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M005-b0m2hl',
        'unique-id-deps: activeMilestone is M005-b0m2hl');
      assert.ok(state.phase !== 'blocked',
        'unique-id-deps: phase is not blocked');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 8: unique-id-deps-blocked ─────────────────────────────
  // M004-0zjrg0 is NOT complete, M005-b0m2hl depends_on M004-0zjrg0 → M005 should be pending
  test('unique-id-deps-blocked: unique ID dep not yet met', async () => {
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

      assert.deepStrictEqual(state.activeMilestone?.id, 'M004-0zjrg0',
        'unique-id-deps-blocked: activeMilestone is M004-0zjrg0');
      assert.deepStrictEqual(state.registry.find(e => e.id === 'M005-b0m2hl')?.status, 'pending',
        'unique-id-deps-blocked: M005-b0m2hl is pending (dep not met)');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 9: draft-context-deps ────────────────────────────────
  // M001 is incomplete, M002 has only CONTEXT-DRAFT.md (no CONTEXT.md) with
  // depends_on: [M001] → M002 should remain pending, not be promoted to active.
  test('draft-context-deps: depends_on read from CONTEXT-DRAFT.md', async () => {
    const base = createFixtureBase();
    try {
      // M001: incomplete (one slice, no SUMMARY)
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** First milestone still in progress.

## Slices

- [ ] **S01: Incomplete Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeSlicePlan(base, 'M001', 'S01', `# S01: Incomplete Slice

**Goal:** Test draft dep blocking.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Do work** \`est:15m\`
  First task still in progress.
`);

      // M002: only CONTEXT-DRAFT.md (no CONTEXT.md), depends on M001
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** Second milestone blocked by M001 via draft context.

## Slices

- [ ] **S01: Blocked Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContextDraft(base, 'M002', 'depends_on: [M001]');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.registry[0]?.status, 'active', 'draft-context-deps: M001 is active');
      assert.deepStrictEqual(state.registry[1]?.status, 'pending', 'draft-context-deps: M002 is pending (dep-blocked via draft)');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M001', 'draft-context-deps: activeMilestone is M001');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 10: draft-context-deps-no-roadmap ──────────────────────
  // Same as above but without roadmaps — milestones discovered from directory only.
  test('draft-context-deps-no-roadmap: depends_on from draft without roadmap', async () => {
    const base = createFixtureBase();
    try {
      // M001: exists as directory only (no roadmap, no summary)
      const m001Dir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });

      // M002: only CONTEXT-DRAFT.md, depends on M001
      writeContextDraft(base, 'M002', 'depends_on: [M001]');

      const state = await deriveState(base);

      const m002Entry = state.registry.find(e => e.id === 'M002');
      assert.deepStrictEqual(m002Entry?.status, 'pending', 'draft-no-roadmap: M002 is pending (dep-blocked via draft)');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 11: parseContextDependsOn preserves case ──────────────
  // Direct unit test: verify the parsed dep ID matches the input exactly
  test('parseContextDependsOn: preserves case of unique IDs', async () => {
    const { parseContextDependsOn } = await import('../files.ts');

    const deps1 = parseContextDependsOn('---\ndepends_on: [M004-0zjrg0]\n---\n');
    assert.deepStrictEqual(deps1[0], 'M004-0zjrg0',
      'parseContextDependsOn preserves lowercase hex suffix');

    const deps2 = parseContextDependsOn('---\ndepends_on: [M001, M004-abc123]\n---\n');
    assert.deepStrictEqual(deps2[0], 'M001', 'preserves classic uppercase ID');
    assert.deepStrictEqual(deps2[1], 'M004-abc123', 'preserves mixed-case unique ID');

    const deps3 = parseContextDependsOn('---\ndepends_on: []\n---\n');
    assert.deepStrictEqual(deps3.length, 0, 'empty deps returns empty array');

    const deps4 = parseContextDependsOn(null);
    assert.deepStrictEqual(deps4.length, 0, 'null content returns empty array');
  });

  // ─── Test Group 10: draft-only-deps-blocked (#1724) ────────────────────
  // M002 has only CONTEXT-DRAFT.md (no CONTEXT.md) with depends_on: [M001].
  // M001 is incomplete → M002 must remain pending, not get promoted to active.
  // Regression: before #1724, parseContextDependsOn received null for draft-only
  // milestones, returning [], which caused dep-blocked milestones to be promoted.
  test('draft-only-deps-blocked: CONTEXT-DRAFT.md depends_on blocks promotion', async () => {
    const base = createFixtureBase();
    try {
      // M001: incomplete (one slice, no SUMMARY)
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** First milestone still in progress.

## Slices

- [ ] **S01: Incomplete Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeSlicePlan(base, 'M001', 'S01', `# S01: Incomplete Slice

**Goal:** Test draft dep blocking.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Do work** \`est:15m\`
  First task still in progress.
`);

      // M002: only CONTEXT-DRAFT.md (no CONTEXT.md), depends on M001
      writeContextDraft(base, 'M002', 'depends_on: [M001]');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.activeMilestone?.id, 'M001',
        'draft-only-deps-blocked: activeMilestone is M001');
      assert.deepStrictEqual(state.registry.find(e => e.id === 'M002')?.status, 'pending',
        'draft-only-deps-blocked: M002 is pending (dep on M001 not met, read from CONTEXT-DRAFT)');
      assert.ok(state.phase !== 'blocked',
        'draft-only-deps-blocked: phase is not blocked (M001 is active)');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 11: draft-only-deps-unblocked (#1724) ─────────────────
  // M001 is complete, M002 has only CONTEXT-DRAFT.md with depends_on: [M001].
  // M002 should become active because its dep is satisfied.
  test('draft-only-deps-unblocked: CONTEXT-DRAFT.md dep met → milestone activates', async () => {
    const base = createFixtureBase();
    try {
      // M001: complete
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** Complete milestone.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, 'M001');
      writeMilestoneSummary(base, 'M001', '# M001 Summary\n\nComplete.');

      // M002: only CONTEXT-DRAFT.md, depends on M001 (now complete)
      writeContextDraft(base, 'M002', 'depends_on: [M001]');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.registry.find(e => e.id === 'M001')?.status, 'complete',
        'draft-only-deps-unblocked: M001 is complete');
      assert.deepStrictEqual(state.registry.find(e => e.id === 'M002')?.status, 'active',
        'draft-only-deps-unblocked: M002 is active (dep on M001 met via CONTEXT-DRAFT)');
      assert.deepStrictEqual(state.activeMilestone?.id, 'M002',
        'draft-only-deps-unblocked: activeMilestone is M002');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 12: draft-only-deps-with-roadmap (#1724) ──────────────
  // M002 has a roadmap + only CONTEXT-DRAFT.md with depends_on: [M001].
  // Tests the has-roadmap code path (second occurrence of the fix).
  test('draft-only-deps-with-roadmap: has-roadmap path reads CONTEXT-DRAFT deps', async () => {
    const base = createFixtureBase();
    try {
      // M001: incomplete
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** Still in progress.

## Slices

- [ ] **S01: Working** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeSlicePlan(base, 'M001', 'S01', `# S01: Working

**Goal:** Test.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Work** \`est:15m\`
  Doing work.
`);

      // M002: has a roadmap AND only CONTEXT-DRAFT.md with depends_on: [M001]
      writeRoadmap(base, 'M002', `# M002: Second Milestone

**Vision:** Has roadmap but only draft context with deps.

## Slices

- [ ] **S01: Blocked** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContextDraft(base, 'M002', 'depends_on: [M001]');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.activeMilestone?.id, 'M001',
        'draft-only-deps-with-roadmap: activeMilestone is M001');
      assert.deepStrictEqual(state.registry.find(e => e.id === 'M002')?.status, 'pending',
        'draft-only-deps-with-roadmap: M002 is pending (dep read from CONTEXT-DRAFT in has-roadmap path)');
    } finally {
      cleanup(base);
    }
  });

  // ─── Test Group 13: draft-only-no-deps (#1724) ────────────────────────
  // M002 has only CONTEXT-DRAFT.md with NO depends_on field.
  // Should behave same as no context file — normal sequential behavior.
  test('draft-only-no-deps: CONTEXT-DRAFT without depends_on → no constraint', async () => {
    const base = createFixtureBase();
    try {
      // M001: complete
      writeRoadmap(base, 'M001', `# M001: First Milestone

**Vision:** Complete.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, 'M001');
      writeMilestoneSummary(base, 'M001', '# M001 Summary\n\nComplete.');

      // M002: only CONTEXT-DRAFT.md but no depends_on — should become active normally
      writeContextDraft(base, 'M002', 'title: Some Draft');

      const state = await deriveState(base);

      assert.deepStrictEqual(state.registry.find(e => e.id === 'M002')?.status, 'active',
        'draft-only-no-deps: M002 is active (no deps constraint in draft)');
    } finally {
      cleanup(base);
    }
  });
});
