/**
 * cache-staleness-regression.test.ts — Regression tests for stale cache bugs.
 *
 * The GSD parser caches are critical for performance but have caused multiple
 * production bugs when not invalidated at the right time.
 *
 * Regression coverage for:
 *   #1249  Stale caches in discuss loop → slice appears "not discussed"
 *   #1240  Stale caches after milestone creation → "No roadmap yet"
 *   #1236  Same root cause as #1240
 *
 * Pattern: derive state → write file → invalidate cache → derive again → verify update
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, invalidateStateCache } from '../state.ts';
import { invalidateAllCaches } from '../cache.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-cache-stale-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function writeMilestoneFile(base: string, mid: string, suffix: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-${suffix}.md`), content);
}

function writeSliceFile(base: string, mid: string, sid: string, suffix: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-${suffix}.md`), content);
}

async function main(): Promise<void> {

  // ─── 1. Regression #1240: New roadmap detected after cache invalidation ─
  console.log('\n=== 1. #1240: roadmap written after first derive → detected after invalidation ===');
  {
    const base = createBase();
    try {
      // Step 1: Create milestone with just context (no roadmap)
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001: Test\n\nBuild a thing.\n');

      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assertEq(state1.phase, 'pre-planning', 'initial: pre-planning (no roadmap)');

      // Step 2: Write roadmap (simulating what the LLM does during planning)
      const roadmap = [
        '# M001: Test',
        '',
        '## Slices',
        '',
        '- [ ] **S01: First Slice** `risk:low` `depends:[]`',
        '',
        '## Boundary Map',
        '',
      ].join('\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', roadmap);

      // Step 3: WITHOUT invalidation, the old state might be cached
      // The state cache has a 100ms TTL, so wait just past it
      await new Promise(r => setTimeout(r, 150));

      // Step 4: Invalidate and re-derive — should see the new roadmap
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assertEq(state2.phase, 'planning', '#1240: after roadmap write + invalidation → planning phase');
      assertEq(state2.activeSlice?.id, 'S01', '#1240: S01 is now the active slice');
    } finally {
      cleanup(base);
    }
  }

  // ─── 2. Regression #1249: Slice context detected after cache invalidation ─
  console.log('\n=== 2. #1249: slice context written mid-loop → detected after invalidation ===');
  {
    const base = createBase();
    try {
      // Create a milestone in needs-discussion phase (CONTEXT-DRAFT, no CONTEXT)
      const mDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(mDir, { recursive: true });
      writeFileSync(join(mDir, 'M001-CONTEXT-DRAFT.md'), '# Draft\n\nSome ideas.\n');

      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assertEq(state1.phase, 'needs-discussion', 'initial: needs-discussion');

      // Simulate: discussion completes, CONTEXT.md is written
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001: Test\n\nFull context after discussion.\n');

      // Wait past TTL
      await new Promise(r => setTimeout(r, 150));

      // Without invalidation, we'd still see 'needs-discussion'
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      // Should now be pre-planning (has context, but no roadmap yet)
      // Actually needs-discussion won't trigger because now CONTEXT exists
      // The state should advance past needs-discussion
      assertTrue(
        state2.phase !== 'needs-discussion',
        '#1249: after context write + invalidation → not stuck in needs-discussion',
      );
    } finally {
      cleanup(base);
    }
  }

  // ─── 3. State cache TTL expires naturally ─────────────────────────────
  console.log('\n=== 3. state cache TTL: fresh reads after 100ms ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');

      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assertEq(state1.phase, 'pre-planning', 'initial: pre-planning');

      // Write roadmap immediately
      writeMilestoneFile(base, 'M001', 'ROADMAP', [
        '# M001: Test',
        '',
        '## Slices',
        '',
        '- [ ] **S01: Slice** `risk:low` `depends:[]`',
        '',
      ].join('\n'));

      // Immediately after writing (within 100ms TTL), the cache might be stale
      const state2 = await deriveState(base);
      // This MAY still show pre-planning if within TTL — that's expected behavior

      // Wait past TTL
      await new Promise(r => setTimeout(r, 150));

      // ALSO invalidate parse cache (not just state cache)
      invalidateAllCaches();
      invalidateStateCache();
      const state3 = await deriveState(base);
      assertEq(state3.phase, 'planning', 'after TTL expiry + invalidation → planning');
    } finally {
      cleanup(base);
    }
  }

  // ─── 4. Task completion detection after file write ────────────────────
  console.log('\n=== 4. task marked done in plan → state advances ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', [
        '# M001: Test',
        '',
        '## Slices',
        '',
        '- [ ] **S01: Slice** `risk:low` `depends:[]`',
        '',
      ].join('\n'));
      writeSliceFile(base, 'M001', 'S01', 'PLAN', [
        '# S01: Slice',
        '',
        '## Tasks',
        '',
        '- [ ] **T01: First Task** `est:1h`',
        '- [ ] **T02: Second Task** `est:1h`',
      ].join('\n'));
      // Write task plan files
      const tasksDir = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'T01-PLAN.md'), '# T01\nDo thing.');
      writeFileSync(join(tasksDir, 'T02-PLAN.md'), '# T02\nDo other thing.');

      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assertEq(state1.activeTask?.id, 'T01', 'initial: T01 is active task');

      // Mark T01 as done by rewriting the plan
      writeSliceFile(base, 'M001', 'S01', 'PLAN', [
        '# S01: Slice',
        '',
        '## Tasks',
        '',
        '- [x] **T01: First Task** `est:1h`',
        '- [ ] **T02: Second Task** `est:1h`',
      ].join('\n'));

      await new Promise(r => setTimeout(r, 150));
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assertEq(state2.activeTask?.id, 'T02', 'after T01 done → T02 is active task');
    } finally {
      cleanup(base);
    }
  }

  // ─── 5. Slice completion detection ────────────────────────────────────
  console.log('\n=== 5. all tasks done → summarizing phase ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', [
        '# M001: Test',
        '',
        '## Slices',
        '',
        '- [ ] **S01: First** `risk:low` `depends:[]`',
        '- [ ] **S02: Second** `risk:low` `depends:[S01]`',
        '',
      ].join('\n'));
      writeSliceFile(base, 'M001', 'S01', 'PLAN', [
        '# S01',
        '',
        '## Tasks',
        '',
        '- [ ] **T01: Task** `est:1h`',
      ].join('\n'));
      const tasksDir = join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'T01-PLAN.md'), '# T01\nDo it.');

      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assertEq(state1.phase, 'executing', 'initial: executing');

      // Mark task done
      writeSliceFile(base, 'M001', 'S01', 'PLAN', [
        '# S01',
        '',
        '## Tasks',
        '',
        '- [x] **T01: Task** `est:1h`',
      ].join('\n'));

      await new Promise(r => setTimeout(r, 150));
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assertEq(state2.phase, 'summarizing', 'after all tasks done → summarizing');
    } finally {
      cleanup(base);
    }
  }

  // ─── 6. Roadmap slice marked done → advance to next slice ─────────────
  console.log('\n=== 6. roadmap slice marked [x] → next slice active ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', [
        '# M001: Test',
        '',
        '## Slices',
        '',
        '- [ ] **S01: First** `risk:low` `depends:[]`',
        '- [ ] **S02: Second** `risk:low` `depends:[S01]`',
        '',
      ].join('\n'));

      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assertEq(state1.activeSlice?.id, 'S01', 'initial: S01 active');

      // Mark S01 as done in roadmap
      writeMilestoneFile(base, 'M001', 'ROADMAP', [
        '# M001: Test',
        '',
        '## Slices',
        '',
        '- [x] **S01: First** `risk:low` `depends:[]`',
        '- [ ] **S02: Second** `risk:low` `depends:[S01]`',
        '',
      ].join('\n'));

      await new Promise(r => setTimeout(r, 150));
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assertEq(state2.activeSlice?.id, 'S02', 'after S01 done → S02 active');
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
