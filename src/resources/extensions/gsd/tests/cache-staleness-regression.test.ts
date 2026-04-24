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

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, invalidateStateCache } from '../state.ts';
import { invalidateAllCaches } from '../cache.ts';

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

describe("cache-staleness-regression", () => {

  test("#1240: roadmap written after first derive → detected after invalidation", async () => {
    const base = createBase();
    try {
      // Step 1: Create milestone with just context (no roadmap)
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001: Test\n\nBuild a thing.\n');

      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.strictEqual(state1.phase, 'pre-planning', 'initial: pre-planning (no roadmap)');

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

      // Step 3: Explicit invalidation — this is the #1240 fix path. We
      // do NOT rely on the 100ms TTL here; the production code calls
      // invalidateAllCaches() / invalidateStateCache() immediately after
      // writing planning files, so the next deriveState() must see the
      // new roadmap without any wall-clock wait.
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.strictEqual(state2.phase, 'planning', '#1240: after roadmap write + invalidation → planning phase');
      assert.strictEqual(state2.activeSlice?.id, 'S01', '#1240: S01 is now the active slice');
    } finally {
      cleanup(base);
    }
  });

  test("#1249: slice context written mid-loop → detected after invalidation", async () => {
    const base = createBase();
    try {
      // Create a milestone in needs-discussion phase (CONTEXT-DRAFT, no CONTEXT)
      const mDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(mDir, { recursive: true });
      writeFileSync(join(mDir, 'M001-CONTEXT-DRAFT.md'), '# Draft\n\nSome ideas.\n');

      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.strictEqual(state1.phase, 'needs-discussion', 'initial: needs-discussion');

      // Simulate: discussion completes, CONTEXT.md is written
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001: Test\n\nFull context after discussion.\n');

      // Explicit invalidation is the production fix path for #1249 —
      // no wall-clock wait needed.
      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.ok(
        state2.phase !== 'needs-discussion',
        '#1249: after context write + invalidation → not stuck in needs-discussion',
      );
    } finally {
      cleanup(base);
    }
  });

  test("state cache TTL: within window returns cached; past window re-derives", async () => {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');

      invalidateAllCaches();
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.strictEqual(state1.phase, 'pre-planning', 'initial: pre-planning');

      // Write roadmap immediately — no invalidation
      writeMilestoneFile(base, 'M001', 'ROADMAP', [
        '# M001: Test',
        '',
        '## Slices',
        '',
        '- [ ] **S01: Slice** `risk:low` `depends:[]`',
        '',
      ].join('\n'));

      // Within the TTL window, deriveState() must return the cached
      // pre-planning state — this is the "cached" half of the TTL
      // contract and the reason invalidateStateCache() exists.
      const state2 = await deriveState(base);
      assert.strictEqual(state2.phase, 'pre-planning', 'within TTL: cached pre-planning is returned');

      // Past the TTL + explicit parse-cache flush, the fresh derive must
      // see the new roadmap. invalidateAllCaches() is required because
      // the file-parse cache is independent of the state TTL.
      await new Promise(r => setTimeout(r, 150));
      invalidateAllCaches();
      const state3 = await deriveState(base);
      assert.strictEqual(state3.phase, 'planning', 'past TTL: re-derive sees new roadmap');
    } finally {
      cleanup(base);
    }
  });

  test("task marked done in plan → state advances", async () => {
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
      assert.strictEqual(state1.activeTask?.id, 'T01', 'initial: T01 is active task');

      // Mark T01 as done by rewriting the plan
      writeSliceFile(base, 'M001', 'S01', 'PLAN', [
        '# S01: Slice',
        '',
        '## Tasks',
        '',
        '- [x] **T01: First Task** `est:1h`',
        '- [ ] **T02: Second Task** `est:1h`',
      ].join('\n'));

      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.strictEqual(state2.activeTask?.id, 'T02', 'after T01 done → T02 is active task');
    } finally {
      cleanup(base);
    }
  });

  test("all tasks done → summarizing phase", async () => {
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
      assert.strictEqual(state1.phase, 'executing', 'initial: executing');

      // Mark task done
      writeSliceFile(base, 'M001', 'S01', 'PLAN', [
        '# S01',
        '',
        '## Tasks',
        '',
        '- [x] **T01: Task** `est:1h`',
      ].join('\n'));

      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.strictEqual(state2.phase, 'summarizing', 'after all tasks done → summarizing');
    } finally {
      cleanup(base);
    }
  });

  test("roadmap slice marked [x] → next slice active", async () => {
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
      assert.strictEqual(state1.activeSlice?.id, 'S01', 'initial: S01 active');

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

      invalidateAllCaches();
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.strictEqual(state2.activeSlice?.id, 'S02', 'after S01 done → S02 active');
    } finally {
      cleanup(base);
    }
  });
});
