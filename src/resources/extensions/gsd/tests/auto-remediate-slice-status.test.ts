/**
 * Regression test for #3673 — auto-remediate stale slice DB status
 *
 * When complete-slice fails after writing SUMMARY.md but before calling
 * updateSliceStatus(), the DB stays stale and the post-unit check
 * previously reported this as a "rogue" artifact, causing infinite
 * re-dispatch. The fix calls updateSliceStatus() to sync the DB.
 *
 * This structural test verifies updateSliceStatus is imported and called
 * in the complete-slice branch of auto-post-unit.ts.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'auto-post-unit.ts'), 'utf-8');

describe('auto-remediate stale slice status (#3673)', () => {
  test('updateSliceStatus is imported from gsd-db', () => {
    assert.match(source, /import\s*\{[^}]*updateSliceStatus[^}]*\}\s*from\s*["']\.\/gsd-db/,
      'updateSliceStatus should be imported from gsd-db');
  });

  test('updateSliceStatus is called with "complete" status', () => {
    assert.match(source, /updateSliceStatus\(mid,\s*sid,\s*["']complete["']/,
      'updateSliceStatus should be called with "complete" status');
  });

  test('remediation is wrapped in try-catch for fallback to rogue detection', () => {
    // The updateSliceStatus call should be in a try block with a catch
    // that falls back to rogues.push
    const updateIdx = source.indexOf('updateSliceStatus(mid, sid');
    assert.ok(updateIdx > 0, 'updateSliceStatus call should exist');

    // Find surrounding try-catch
    const before = source.slice(Math.max(0, updateIdx - 200), updateIdx);
    assert.match(before, /try\s*\{/,
      'updateSliceStatus should be inside a try block');

    const after = source.slice(updateIdx, updateIdx + 300);
    assert.match(after, /catch/,
      'try block should have a catch for fallback');
  });

  test('rogue detection still exists as fallback', () => {
    // rogues.push should appear in the catch block
    assert.match(source, /rogues\.push\(\{.*path:\s*summaryPath/,
      'rogues.push fallback should still exist');
  });
});
