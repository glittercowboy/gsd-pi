/**
 * worktree-sync-milestones.test.ts — Regression tests for #1311 and #1678.
 *
 * Verifies that syncProjectRootToWorktree copies milestone artifacts
 * from the main repo's .gsd/ into the worktree's .gsd/ for the
 * specified milestone, and deletes gsd.db so it rebuilds from fresh state.
 *
 * Also verifies that syncWorktreeStateBack recurses into tasks/ subdirectories
 * so task-level summaries are not dropped on milestone teardown (#1678).
 *
 * Covers:
 *   - Milestone directory synced from main to worktree
 *   - Missing slices within a milestone are synced
 *   - gsd.db deleted in worktree after sync
 *   - No-op when paths are equal
 *   - No-op when milestoneId is null
 *   - Non-existent directories handled gracefully
 *   - syncWorktreeStateBack recurses into tasks/ subdirectory (#1678)
 *   - syncWorktreeStateBack syncs root-level .gsd/ files (REQUIREMENTS, PROJECT, etc.)
 *   - syncWorktreeStateBack syncs ALL milestone directories, not just the current one
 *   - syncWorktreeStateBack handles next-milestone artifacts created during completion
 *   - syncGsdStateToWorktree syncs non-standard milestone dir names (#1547)
 *   - syncWorktreeStateBack syncs non-standard milestone dir names (#1547)
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { syncProjectRootToWorktree } from '../auto-worktree.ts';
import { syncGsdStateToWorktree, syncWorktreeStateBack } from '../auto-worktree.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';


function createBase(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-wt-sync-${name}-`));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

describe('worktree-sync-milestones', async () => {

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
      assert.ok(!existsSync(join(wtBase, '.gsd', 'milestones', 'M001')), 'M001 missing before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001')), '#1311: M001 synced to worktree');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-CONTEXT.md')), 'M001 CONTEXT synced');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md')), 'M001 ROADMAP synced');
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

      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'slices', 'S02')), '#1311: S02 synced');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'S02-PLAN.md')), 'S02 PLAN synced');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3. empty gsd.db deleted in worktree after sync ────────────────────
  console.log('\n=== 3. empty gsd.db deleted in worktree after sync ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');

      // Worktree has an empty (0-byte) gsd.db — stale/corrupt
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), '');
      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), 'gsd.db exists before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(!existsSync(join(wtBase, '.gsd', 'gsd.db')), '#853: empty gsd.db deleted after sync');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3b. non-empty gsd.db preserved in worktree after sync (#2815) ───
  console.log('\n=== 3b. non-empty gsd.db preserved in worktree after sync (#2815) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');

      // Worktree has a populated gsd.db (e.g. from gsd-migrate on respawn)
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), 'migrated-db-content');
      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), 'gsd.db exists before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), '#2815: non-empty gsd.db preserved after sync');
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
      assert.ok(true, 'no crash when paths are equal');
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
      assert.ok(true, 'no crash when milestoneId is null');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 6. Non-existent directories handled gracefully ───────────────────
  console.log('\n=== 6. non-existent directories → no-op ===');
  {
    syncProjectRootToWorktree('/tmp/does-not-exist-main', '/tmp/does-not-exist-wt', 'M001');
    assert.ok(true, 'no crash on missing directories');
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

      assert.ok(!existsSync(join(wtBase, '.gsd', 'milestones')), 'milestones/ missing before sync');

      const result = syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones')), 'milestones/ created in worktree');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001')), 'M001 synced to worktree');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-CONTEXT.md')), 'M001 CONTEXT synced');
      assert.ok(existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md')), 'M001 ROADMAP synced');
      assert.ok(result.synced.length > 0, 'sync reported files');
    } finally {
      cleanup(mainBase);
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 8. syncWorktreeStateBack recurses into tasks/ (#1678) ───────────
  console.log('\n=== 8. syncWorktreeStateBack copies tasks/ subdirectory (#1678) ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-wt-'));

    try {
      // Build worktree milestone structure with slice-level and task-level files
      // Use M002 as the milestone to sync, M001 as the "current" being merged (skipped)
      const wtSliceDir = join(wtBase, '.gsd', 'milestones', 'M002', 'slices', 'S01');
      const wtTasksDir = join(wtSliceDir, 'tasks');
      mkdirSync(wtTasksDir, { recursive: true });
      writeFileSync(join(wtSliceDir, 'S01-SUMMARY.md'), '# S01 Summary');
      writeFileSync(join(wtTasksDir, 'T01-SUMMARY.md'), '# T01 Summary');
      writeFileSync(join(wtTasksDir, 'T02-SUMMARY.md'), '# T02 Summary');

      // Main project root starts with only the milestone directory (no slices yet)
      mkdirSync(join(mainBase, '.gsd', 'milestones', 'M002'), { recursive: true });

      // Pass M001 as milestoneId (the one being merged/skipped), M002 should still sync
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      const mainSliceDir = join(mainBase, '.gsd', 'milestones', 'M002', 'slices', 'S01');
      const mainTasksDir = join(mainSliceDir, 'tasks');

      assert.ok(
        existsSync(join(mainSliceDir, 'S01-SUMMARY.md')),
        '#1678: slice SUMMARY synced to project root',
      );
      assert.ok(
        existsSync(join(mainTasksDir, 'T01-SUMMARY.md')),
        '#1678: task T01-SUMMARY synced to project root',
      );
      assert.ok(
        existsSync(join(mainTasksDir, 'T02-SUMMARY.md')),
        '#1678: task T02-SUMMARY synced to project root',
      );
      assert.ok(
        synced.some((p) => p.includes('tasks/T01-SUMMARY.md')),
        '#1678: task summary appears in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 9. syncWorktreeStateBack syncs root-level .gsd/ files ──────────
  console.log('\n=== 9. syncWorktreeStateBack syncs root-level files (REQUIREMENTS, PROJECT) ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-root-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-root-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'milestones', 'M001'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'milestones', 'M001'), { recursive: true });

      // Main has original REQUIREMENTS and PROJECT
      writeFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), '# Requirements\n## R001');
      writeFileSync(join(mainBase, '.gsd', 'PROJECT.md'), '# Project\n## Milestone: M001');

      // Worktree has updated versions (complete-milestone added M002 refs)
      writeFileSync(join(wtBase, '.gsd', 'REQUIREMENTS.md'), '# Requirements\n## R001\n## R002 — New req');
      writeFileSync(join(wtBase, '.gsd', 'PROJECT.md'), '# Project\n## Milestone: M001\n## Milestone: M002');
      writeFileSync(join(wtBase, '.gsd', 'KNOWLEDGE.md'), '# Knowledge\nLearned something.');

      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      // Root-level files should be overwritten with worktree versions
      const reqContent = readFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), 'utf-8');
      assert.ok(
        reqContent.includes('R002'),
        'REQUIREMENTS.md updated with worktree content',
      );

      const projContent = readFileSync(join(mainBase, '.gsd', 'PROJECT.md'), 'utf-8');
      assert.ok(
        projContent.includes('M002'),
        'PROJECT.md updated with worktree content',
      );

      assert.ok(
        existsSync(join(mainBase, '.gsd', 'KNOWLEDGE.md')),
        'KNOWLEDGE.md synced from worktree',
      );

      assert.ok(
        synced.includes('REQUIREMENTS.md'),
        'REQUIREMENTS.md appears in synced list',
      );
      assert.ok(
        synced.includes('PROJECT.md'),
        'PROJECT.md appears in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 10. syncWorktreeStateBack syncs ALL milestone directories ─────
  console.log('\n=== 10. syncWorktreeStateBack syncs all milestone dirs, not just current ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-all-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-all-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'milestones'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'milestones'), { recursive: true });

      // Worktree has M001 (current) AND M002 (next, created by complete-milestone)
      const wtM001Dir = join(wtBase, '.gsd', 'milestones', 'M001');
      mkdirSync(wtM001Dir, { recursive: true });
      writeFileSync(join(wtM001Dir, 'M001-SUMMARY.md'), '# M001 Summary');

      const wtM002Dir = join(wtBase, '.gsd', 'milestones', 'M002-abc123');
      mkdirSync(wtM002Dir, { recursive: true });
      writeFileSync(join(wtM002Dir, 'M002-abc123-CONTEXT.md'), '# M002 Context');
      writeFileSync(join(wtM002Dir, 'M002-abc123-ROADMAP.md'), '# M002 Roadmap');

      // Main has neither
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'milestones', 'M001')),
        'M001 missing in main before sync',
      );
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'milestones', 'M002-abc123')),
        'M002 missing in main before sync',
      );

      // Sync with milestoneId = M001 (the current milestone being merged — skipped)
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      // M001 should be SKIPPED (current milestone being merged — #3641)
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'milestones', 'M001', 'M001-SUMMARY.md')),
        'M001 SUMMARY NOT synced (current milestone skipped to prevent merge conflicts)',
      );

      // M002 should be synced (other milestone — not skipped)
      assert.ok(
        existsSync(join(mainBase, '.gsd', 'milestones', 'M002-abc123', 'M002-abc123-CONTEXT.md')),
        'M002 CONTEXT synced to main (next-milestone fix)',
      );
      assert.ok(
        existsSync(join(mainBase, '.gsd', 'milestones', 'M002-abc123', 'M002-abc123-ROADMAP.md')),
        'M002 ROADMAP synced to main (next-milestone fix)',
      );

      assert.ok(
        synced.some((p) => p.includes('M002-abc123')),
        'M002 appears in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 11. Full M006→M007 transition scenario ───────────────────────────
  console.log('\n=== 11. complete-milestone creates next-milestone artifacts that survive sync ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-transition-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-transition-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'milestones'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'milestones'), { recursive: true });

      // Main starts with M006 context + existing REQUIREMENTS
      const mainM006 = join(mainBase, '.gsd', 'milestones', 'M006-589wvh');
      mkdirSync(mainM006, { recursive: true });
      writeFileSync(join(mainM006, 'M006-589wvh-CONTEXT.md'), '# M006 Context');
      writeFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), '# Requirements\n## R001 through R089');
      writeFileSync(join(mainBase, '.gsd', 'PROJECT.md'), '# Project\nMilestones: M001-M006');

      // Worktree (M006 execution context) has:
      // - M006 SUMMARY + VALIDATION (created by complete-milestone)
      // - M007 setup (created by complete-milestone for next milestone)
      // - Updated REQUIREMENTS with R090-R094
      // - Updated PROJECT with M007
      const wtM006 = join(wtBase, '.gsd', 'milestones', 'M006-589wvh');
      mkdirSync(join(wtM006, 'slices', 'S01'), { recursive: true });
      writeFileSync(join(wtM006, 'M006-589wvh-CONTEXT.md'), '# M006 Context');
      writeFileSync(join(wtM006, 'M006-589wvh-SUMMARY.md'), '# M006 Complete');
      writeFileSync(join(wtM006, 'M006-589wvh-VALIDATION.md'), '# Validated');
      writeFileSync(join(wtM006, 'slices', 'S01', 'S01-SUMMARY.md'), '# S01 done');

      const wtM007 = join(wtBase, '.gsd', 'milestones', 'M007-wortc8');
      mkdirSync(wtM007, { recursive: true });
      writeFileSync(join(wtM007, 'M007-wortc8-CONTEXT.md'), '# M007 Enterprise Security');
      writeFileSync(join(wtM007, 'M007-wortc8-ROADMAP.md'), '# M007 Roadmap\n10 phases');

      writeFileSync(join(wtBase, '.gsd', 'REQUIREMENTS.md'), '# Requirements\n## R001-R089\n## R090 — SCIM\n## R091 — WebAuthn');
      writeFileSync(join(wtBase, '.gsd', 'PROJECT.md'), '# Project\nMilestones: M001-M007');

      // Sync with milestoneId = M006 (the completing milestone — skipped by sync)
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M006-589wvh');

      // M006 is the current milestone being merged — it should be SKIPPED (#3641)
      // Its files are already in the milestone branch and would conflict with squash merge.
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'milestones', 'M006-589wvh', 'M006-589wvh-SUMMARY.md')),
        'M006 SUMMARY NOT synced (current milestone skipped)',
      );

      // Verify M007 artifacts synced (the critical fix — other milestones still sync)
      assert.ok(
        existsSync(join(mainBase, '.gsd', 'milestones', 'M007-wortc8', 'M007-wortc8-CONTEXT.md')),
        'M007 CONTEXT synced to main (next-milestone)',
      );
      assert.ok(
        existsSync(join(mainBase, '.gsd', 'milestones', 'M007-wortc8', 'M007-wortc8-ROADMAP.md')),
        'M007 ROADMAP synced to main (next-milestone)',
      );

      // Verify root-level files updated
      const reqContent = readFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), 'utf-8');
      assert.ok(
        reqContent.includes('R090'),
        'REQUIREMENTS.md has R090 from worktree',
      );

      const projContent = readFileSync(join(mainBase, '.gsd', 'PROJECT.md'), 'utf-8');
      assert.ok(
        projContent.includes('M007'),
        'PROJECT.md has M007 from worktree',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 12. syncWorktreeStateBack no-op for root files that don't exist ──
  console.log('\n=== 12. root files not in worktree are not created in main ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-noroot-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-noroot-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'milestones', 'M001'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'milestones', 'M001'), { recursive: true });

      // Main has REQUIREMENTS, worktree does not
      writeFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), '# Original');

      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      // Main's REQUIREMENTS should be untouched (worktree had nothing to sync)
      const content = readFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), 'utf-8');
      assert.ok(
        content === '# Original',
        'REQUIREMENTS.md unchanged when worktree has no copy',
      );
      assert.ok(
        !synced.includes('REQUIREMENTS.md'),
        'REQUIREMENTS.md not in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 13. syncWorktreeStateBack syncs QUEUE.md and completed-units.json (#1787) ──
  console.log('\n=== 13. QUEUE.md and completed-units.json synced from worktree (#1787) ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-queue-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-queue-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'milestones', 'M001'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'milestones', 'M001'), { recursive: true });

      // Worktree has QUEUE.md and completed-units.json written during milestone closeout
      writeFileSync(join(wtBase, '.gsd', 'QUEUE.md'), '# Queue\n- M002 next');
      writeFileSync(
        join(wtBase, '.gsd', 'completed-units.json'),
        JSON.stringify({ units: [{ id: 'M001-S01-T01', completed: true }] }),
      );

      // Main has neither
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'QUEUE.md')),
        'QUEUE.md missing in main before sync',
      );
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'completed-units.json')),
        'completed-units.json missing in main before sync',
      );

      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      // QUEUE.md should be synced
      assert.ok(
        existsSync(join(mainBase, '.gsd', 'QUEUE.md')),
        '#1787: QUEUE.md synced from worktree to main',
      );
      const queueContent = readFileSync(join(mainBase, '.gsd', 'QUEUE.md'), 'utf-8');
      assert.ok(
        queueContent.includes('M002 next'),
        '#1787: QUEUE.md has correct content',
      );
      assert.ok(
        synced.includes('QUEUE.md'),
        '#1787: QUEUE.md appears in synced list',
      );

      // completed-units.json should be synced
      assert.ok(
        existsSync(join(mainBase, '.gsd', 'completed-units.json')),
        '#1787: completed-units.json synced from worktree to main',
      );
      const cuContent = readFileSync(join(mainBase, '.gsd', 'completed-units.json'), 'utf-8');
      assert.ok(
        cuContent.includes('M001-S01-T01'),
        '#1787: completed-units.json has correct content',
      );
      assert.ok(
        synced.includes('completed-units.json'),
        '#1787: completed-units.json appears in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 14. syncGsdStateToWorktree syncs non-standard milestone dir names (#1547) ──
  console.log('\n=== 14. syncGsdStateToWorktree syncs non-standard milestone dir names (#1547) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      // Main has milestone dirs with non-standard names
      const customDir = join(mainBase, '.gsd', 'milestones', 'sprint-alpha');
      mkdirSync(customDir, { recursive: true });
      writeFileSync(join(customDir, 'CONTEXT.md'), '# Sprint Alpha Context');

      const suffixDir = join(mainBase, '.gsd', 'milestones', 'M001-abc123');
      mkdirSync(suffixDir, { recursive: true });
      writeFileSync(join(suffixDir, 'M001-abc123-CONTEXT.md'), '# M001 Context');

      assert.ok(!existsSync(join(wtBase, '.gsd', 'milestones', 'sprint-alpha')), 'sprint-alpha missing before sync');
      assert.ok(!existsSync(join(wtBase, '.gsd', 'milestones', 'M001-abc123')), 'M001-abc123 missing before sync');

      const result = syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'milestones', 'sprint-alpha', 'CONTEXT.md')),
        '#1547: non-standard milestone dir "sprint-alpha" synced to worktree',
      );
      assert.ok(
        existsSync(join(wtBase, '.gsd', 'milestones', 'M001-abc123', 'M001-abc123-CONTEXT.md')),
        '#1547: suffixed milestone dir "M001-abc123" synced to worktree',
      );
      assert.ok(result.synced.length > 0, 'sync reported files');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 15. syncWorktreeStateBack syncs non-standard milestone dir names (#1547) ──
  console.log('\n=== 15. syncWorktreeStateBack syncs non-standard milestone dir names (#1547) ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-custom-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-custom-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'milestones'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'milestones'), { recursive: true });

      // Worktree has a non-standard milestone dir
      const wtCustomDir = join(wtBase, '.gsd', 'milestones', 'sprint-beta');
      mkdirSync(wtCustomDir, { recursive: true });
      writeFileSync(join(wtCustomDir, 'SUMMARY.md'), '# Sprint Beta Summary');

      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'milestones', 'sprint-beta')),
        'sprint-beta missing in main before sync',
      );

      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      assert.ok(
        existsSync(join(mainBase, '.gsd', 'milestones', 'sprint-beta', 'SUMMARY.md')),
        '#1547: non-standard milestone dir "sprint-beta" synced back to main',
      );
      assert.ok(
        synced.some((p) => p.includes('sprint-beta')),
        '#1547: sprint-beta appears in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }
});
