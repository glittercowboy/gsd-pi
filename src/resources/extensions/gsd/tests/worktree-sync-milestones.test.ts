/**
 * worktree-sync-milestones.test.ts — Regression test for #1311.
 *
 * Verifies that syncProjectRootToWorktree copies milestone artifacts
 * from the main repo's .gsd/ into the worktree's .gsd/ for the
 * specified milestone, and deletes gsd.db so it rebuilds from fresh state.
 *
 * Covers:
 *   - Milestone directory synced from main to worktree
 *   - Missing slices within a milestone are synced
 *   - gsd.db deleted in worktree after sync
 *   - No-op when paths are equal
 *   - No-op when milestoneId is null
 *   - Non-existent directories handled gracefully
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { syncProjectRootToWorktree } from '../auto-worktree-sync.ts';
import { syncGsdStateToWorktree } from '../auto-worktree.ts';
import { createTestContext } from './test-helpers.ts';

const { assertTrue, report } = createTestContext();

function createBase(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-wt-sync-${name}-`));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

async function main(): Promise<void> {

  // ─── 1. Milestone directory synced from main to worktree ──────────────
  console.log('\n=== 1. milestone directory synced from main to worktree ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-CONTEXT.md'), '# M001\nContext.');
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');

      // Worktree has no M001
      assertTrue(!existsSync(join(wtBase, '.gsd', 'milestones', 'M001')), 'M001 missing before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assertTrue(existsSync(join(wtBase, '.gsd', 'milestones', 'M001')), '#1311: M001 synced to worktree');
      assertTrue(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-CONTEXT.md')), 'M001 CONTEXT synced');
      assertTrue(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md')), 'M001 ROADMAP synced');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 2. Missing slices synced ──────────────────────────────────────────
  console.log('\n=== 2. missing slices within milestone are synced ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(join(m001Dir, 'slices', 'S01'), { recursive: true });
      mkdirSync(join(m001Dir, 'slices', 'S02'), { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');
      writeFileSync(join(m001Dir, 'slices', 'S01', 'S01-PLAN.md'), '# S01 Plan');
      writeFileSync(join(m001Dir, 'slices', 'S02', 'S02-PLAN.md'), '# S02 Plan');

      // Worktree only has S01
      const wtM001Dir = join(wtBase, '.gsd', 'milestones', 'M001');
      mkdirSync(join(wtM001Dir, 'slices', 'S01'), { recursive: true });
      writeFileSync(join(wtM001Dir, 'slices', 'S01', 'S01-PLAN.md'), '# S01 Plan');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assertTrue(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'slices', 'S02')), '#1311: S02 synced');
      assertTrue(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'S02-PLAN.md')), 'S02 PLAN synced');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3. gsd.db deleted in worktree after sync ─────────────────────────
  console.log('\n=== 3. gsd.db deleted in worktree after sync ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');

      // Worktree has a stale gsd.db
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), 'stale data');
      assertTrue(existsSync(join(wtBase, '.gsd', 'gsd.db')), 'gsd.db exists before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assertTrue(!existsSync(join(wtBase, '.gsd', 'gsd.db')), '#853: gsd.db deleted after sync');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 4. No-op when paths are equal ────────────────────────────────────
  console.log('\n=== 4. no-op when paths are equal ===');
  {
    const base = createBase('same');
    try {
      // Should not throw
      syncProjectRootToWorktree(base, base, 'M001');
      assertTrue(true, 'no crash when paths are equal');
    } finally {
      cleanup(base);
    }
  }

  // ─── 5. No-op when milestoneId is null ────────────────────────────────
  console.log('\n=== 5. no-op when milestoneId is null ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');
    try {
      syncProjectRootToWorktree(mainBase, wtBase, null);
      assertTrue(true, 'no crash when milestoneId is null');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 6. Non-existent directories handled gracefully ───────────────────
  console.log('\n=== 6. non-existent directories → no-op ===');
  {
    syncProjectRootToWorktree('/tmp/does-not-exist-main', '/tmp/does-not-exist-wt', 'M001');
    assertTrue(true, 'no crash on missing directories');
  }

  // ─── 7. milestones/ directory created in worktree when missing ────────
  console.log('\n=== 7. milestones/ directory created in worktree when missing ===');
  {
    const mainBase = createBase('main');
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-wt-'));

    try {
      // Worktree has .gsd/ but NO milestones/ subdirectory
      mkdirSync(join(wtBase, '.gsd'), { recursive: true });

      // Main repo has M001
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-CONTEXT.md'), '# M001 Context');
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# M001 Roadmap');

      assertTrue(!existsSync(join(wtBase, '.gsd', 'milestones')), 'milestones/ missing before sync');

      const result = syncGsdStateToWorktree(mainBase, wtBase);

      assertTrue(existsSync(join(wtBase, '.gsd', 'milestones')), 'milestones/ created in worktree');
      assertTrue(existsSync(join(wtBase, '.gsd', 'milestones', 'M001')), 'M001 synced to worktree');
      assertTrue(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-CONTEXT.md')), 'M001 CONTEXT synced');
      assertTrue(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md')), 'M001 ROADMAP synced');
      assertTrue(result.synced.length > 0, 'sync reported files');
    } finally {
      cleanup(mainBase);
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
