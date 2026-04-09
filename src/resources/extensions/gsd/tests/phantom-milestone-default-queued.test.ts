/**
 * Regression test for #3695 — insertMilestone defaults status to "queued"
 *
 * Milestones were being auto-created with status "active", causing phantom
 * milestones to appear as active work.  The fix defaults to "queued" so
 * new milestones must be explicitly activated.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbSrc = readFileSync(
  join(__dirname, '..', 'gsd-db.ts'),
  'utf-8',
);

describe('insertMilestone defaults status to queued (#3695)', () => {
  test('insertMilestone function exists', () => {
    assert.match(dbSrc, /export function insertMilestone\(/,
      'insertMilestone should be exported from gsd-db.ts');
  });

  test('default status is "queued" not "active"', () => {
    // The status parameter should default to "queued" via nullish coalescing
    assert.match(dbSrc, /m\.status\s*\?\?\s*"queued"/,
      'insertMilestone should default status to "queued"');
  });

  test('comment explains the rationale', () => {
    assert.match(dbSrc, /never auto-create milestones as "active"/i,
      'should have a comment explaining why default is queued');
  });
});
