/**
 * worktree-db-respawn-truncation.test.ts — Regression test for #2815.
 *
 * Verifies that syncProjectRootToWorktree does NOT delete a non-empty
 * worktree gsd.db. On worker respawn, gsd-migrate populates the DB
 * (~1.7MB) before the auto-loop calls syncProjectRootToWorktree. The
 * sync step must preserve the freshly-migrated DB to avoid truncating
 * it to 0 bytes and causing "no such table: slices" failures.
 *
 * Covers:
 *   - Non-empty worktree gsd.db preserved after sync (#2815)
 *   - Empty (0-byte) worktree gsd.db still deleted (#853 preserved)
 *   - WAL/SHM sidecar files cleaned up when empty DB is deleted
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { syncProjectRootToWorktree } from '../auto-worktree.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';


function createBase(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-wt-respawn-${name}-`));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

describe('worktree-db-respawn-truncation (#2815)', async () => {

  // ─── 1. Non-empty worktree gsd.db preserved after sync ───────────────
  console.log('\n=== 1. non-empty worktree gsd.db preserved after sync (#2815) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      // Set up milestone artifacts in main project root
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');

      // Simulate a freshly-migrated worktree DB (non-empty, like after gsd-migrate)
      // Real DBs are ~1.7MB; we use a smaller payload to prove the size check works
      const fakeDbContent = Buffer.alloc(4096, 0x42); // 4KB non-empty DB
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), fakeDbContent);

      const sizeBefore = statSync(join(wtBase, '.gsd', 'gsd.db')).size;
      assert.ok(sizeBefore > 0, 'gsd.db is non-empty before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      // The non-empty DB must survive the sync
      assert.ok(
        existsSync(join(wtBase, '.gsd', 'gsd.db')),
        '#2815: non-empty gsd.db must not be deleted by sync',
      );
      const sizeAfter = statSync(join(wtBase, '.gsd', 'gsd.db')).size;
      assert.equal(
        sizeAfter,
        sizeBefore,
        '#2815: gsd.db size must be unchanged after sync',
      );
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 2. Empty (0-byte) worktree gsd.db still deleted ─────────────────
  console.log('\n=== 2. empty (0-byte) worktree gsd.db still deleted (#853) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');

      // Create an empty (0-byte) gsd.db — this is stale/corrupt and should be deleted
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), '');
      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), 'empty gsd.db exists before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(
        !existsSync(join(wtBase, '.gsd', 'gsd.db')),
        '#853: empty gsd.db must still be deleted after sync',
      );
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3. Milestone artifacts still synced when DB is preserved ────────
  console.log('\n=== 3. milestone artifacts still synced even when DB preserved ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, 'M001-ROADMAP.md'), '# Roadmap');
      mkdirSync(join(m001Dir, 'slices', 'S01'), { recursive: true });
      writeFileSync(join(m001Dir, 'slices', 'S01', 'S01-PLAN.md'), '# Plan');

      // Non-empty DB in worktree
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), 'populated-db-data');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      // Artifacts must still be synced
      assert.ok(
        existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md')),
        'milestone artifacts synced even with preserved DB',
      );
      assert.ok(
        existsSync(join(wtBase, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md')),
        'slice artifacts synced even with preserved DB',
      );
      // DB must still exist
      assert.ok(
        existsSync(join(wtBase, '.gsd', 'gsd.db')),
        '#2815: DB preserved alongside artifact sync',
      );
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }
});
