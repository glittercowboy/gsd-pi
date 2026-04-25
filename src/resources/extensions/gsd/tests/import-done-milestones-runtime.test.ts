/**
 * Runtime regression — milestones with all-done roadmap slices import as
 * `complete` (#3699 / #3390 / #3379), follow-up #4902.
 *
 * The deleted `import-done-milestones.test.ts` was a source-grep check
 * for the literal `roadmap.slices.every(s => s.done)`. This rewrite
 * exercises `migrateHierarchyToDb()` against a fixture roadmap whose
 * slices are all `[x]` and asserts the milestone row's `status` is
 * `complete` — the actual behaviour the every() check exists to
 * produce.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  getAllMilestones,
} from '../gsd-db.ts';
import { migrateHierarchyToDb } from '../md-importer.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-import-done-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, '.gsd', relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

const ROADMAP_ALL_DONE = `# M001: Finished Milestone

**Vision:** Done work.

## Slices

- [x] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.

- [x] **S02: Second Slice** \`risk:medium\` \`depends:[S01]\`
  > After this: Also done.
`;

const ROADMAP_PARTIAL = `# M002: In-Progress Milestone

**Vision:** Mid-flight.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.

- [ ] **S02: Pending Slice** \`risk:medium\` \`depends:[S01]\`
  > After this: TBD.
`;

const ROADMAP_EMPTY = `# M003: Empty Milestone

**Vision:** No slices yet.

## Slices

`;

describe('migrateHierarchyToDb: all-done milestones import as complete (#4902)', () => {
  test('milestone with all [x] slices and no SUMMARY imports as complete', () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M001/M001-ROADMAP.md', ROADMAP_ALL_DONE);
      // No SUMMARY.md — the all-done roadmap check is the authoritative signal.

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      const milestones = getAllMilestones();
      const m001 = milestones.find((m) => m.id === 'M001');
      assert.ok(m001, 'M001 should be imported');
      assert.equal(
        m001!.status,
        'complete',
        'milestone with all-done slices must import as complete',
      );
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test('milestone with one pending slice imports as active (negative case)', () => {
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M002/M002-ROADMAP.md', ROADMAP_PARTIAL);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      const milestones = getAllMilestones();
      const m002 = milestones.find((m) => m.id === 'M002');
      assert.ok(m002, 'M002 should be imported');
      assert.equal(
        m002!.status,
        'active',
        'milestone with at least one pending slice must NOT be marked complete',
      );
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test('milestone with empty slice list does not import as complete', () => {
    // Guards the `roadmap.slices.length > 0` precondition: an empty roadmap
    // must not be misread as "everything is done" (vacuous truth bug).
    const base = createFixtureBase();
    try {
      writeFile(base, 'milestones/M003/M003-ROADMAP.md', ROADMAP_EMPTY);

      openDatabase(':memory:');
      migrateHierarchyToDb(base);

      const milestones = getAllMilestones();
      const m003 = milestones.find((m) => m.id === 'M003');
      assert.ok(m003, 'M003 should be imported');
      assert.notEqual(
        m003!.status,
        'complete',
        'empty roadmap (no slices) must not import as complete',
      );
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
