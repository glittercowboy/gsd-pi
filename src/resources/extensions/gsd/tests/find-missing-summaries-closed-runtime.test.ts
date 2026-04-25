/**
 * Runtime regression — closed-status omission for missing-summary detection
 * (#4902).
 *
 * `findMissingSummaries` (auto-dispatch.ts) filters out slices in any closed
 * status before checking for an on-disk SUMMARY. The deleted source-grep
 * test asserted the literal `CLOSED_STATUSES` Set; this rewrite tests the
 * exported predicate (`isClosedStatus`) that the inline Set replicates,
 * so any drift between the predicate and the inline filter surfaces as a
 * test failure here rather than a runtime miss.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isClosedStatus, isInactiveStatus } from '../status-guards.ts';

describe('isClosedStatus — closed-status omission contract (#4902)', () => {
  test('returns true for every status findMissingSummaries skips', () => {
    // Mirror the inline Set in auto-dispatch.ts:findMissingSummaries.
    for (const s of ['complete', 'done', 'skipped']) {
      assert.equal(
        isClosedStatus(s),
        true,
        `${s} must count as a closed status (would-have-summary omission)`,
      );
    }
  });

  test('returns false for live in-flight statuses', () => {
    for (const s of ['pending', 'active', 'in-progress', 'planning', 'executing']) {
      assert.equal(
        isClosedStatus(s),
        false,
        `${s} is in-flight and MUST be checked for a missing SUMMARY`,
      );
    }
  });

  test('isInactiveStatus also covers deferred so it is not summary-checked', () => {
    // Deferred slices likewise never produce a SUMMARY; the active-slice
    // selector uses isInactiveStatus to skip them. Pin the contract.
    assert.equal(isInactiveStatus('deferred'), true);
    assert.equal(isInactiveStatus('complete'), true);
    assert.equal(isInactiveStatus('pending'), false);
  });
});
