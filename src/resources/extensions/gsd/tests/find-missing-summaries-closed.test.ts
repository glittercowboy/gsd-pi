/**
 * Regression test for #3669 — findMissingSummaries skips closed slices
 *
 * When a slice has status "skipped", "complete", or "done", it should be
 * excluded from the missing-summary check because closed slices intentionally
 * lack SUMMARY files (or their DB status is authoritative).
 *
 * This is a structural verification test — it reads the source to confirm the
 * CLOSED_STATUSES guard exists at the filter site.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'auto-dispatch.ts'), 'utf-8');

describe('findMissingSummaries closed-status exclusion (#3669)', () => {
  test('CLOSED_STATUSES set includes skipped, complete, and done', () => {
    // The source must define a CLOSED_STATUSES set with all three statuses
    assert.match(source, /CLOSED_STATUSES.*=.*new Set\(/,
      'CLOSED_STATUSES set should be defined');
    assert.match(source, /"skipped"/, 'CLOSED_STATUSES should include "skipped"');
    assert.match(source, /"complete"/, 'CLOSED_STATUSES should include "complete"');
    assert.match(source, /"done"/, 'CLOSED_STATUSES should include "done"');
  });

  test('filter uses CLOSED_STATUSES.has() to exclude closed slices', () => {
    assert.match(source, /CLOSED_STATUSES\.has\(s\.status\)/,
      'filter should call CLOSED_STATUSES.has(s.status)');
  });

  test('findMissingSummaries function exists', () => {
    assert.match(source, /function findMissingSummaries\(/,
      'findMissingSummaries function should be defined');
  });

  test('filter is negated (excludes closed, keeps open)', () => {
    // The filter should use !CLOSED_STATUSES.has() to exclude closed slices
    assert.match(source, /!CLOSED_STATUSES\.has\(s\.status\)/,
      'filter should negate CLOSED_STATUSES.has() to exclude closed slices');
  });
});
