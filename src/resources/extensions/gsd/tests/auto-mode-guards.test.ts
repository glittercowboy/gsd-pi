/**
 * Regression tests for auto-mode guards (#4704 Tier 2 / #4712).
 *
 * Validates the defense-in-depth writer asserts in milestone-actions.ts —
 * parkMilestone, unparkMilestone, and discardMilestone must refuse to run
 * while auto-mode is active, regardless of the calling dispatch path.
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parkMilestone, unparkMilestone, discardMilestone } from '../milestone-actions.ts';
import { _setAutoActiveForTest } from '../auto.ts';

function createFixture(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-guard-test-'));
  const mDir = join(base, '.gsd', 'milestones', 'M001');
  mkdirSync(mDir, { recursive: true });
  writeFileSync(join(mDir, 'M001-ROADMAP.md'), '# M001\n', 'utf-8');
  return base;
}

describe('auto-mode guards (milestone-actions)', () => {
  afterEach(() => {
    _setAutoActiveForTest(false);
  });

  test('parkMilestone throws when auto-mode is active', () => {
    const base = createFixture();
    try {
      _setAutoActiveForTest(true);
      assert.throws(
        () => parkMilestone(base, 'M001', 'test'),
        /auto-mode is active/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('unparkMilestone throws when auto-mode is active', () => {
    const base = createFixture();
    try {
      _setAutoActiveForTest(true);
      assert.throws(
        () => unparkMilestone(base, 'M001'),
        /auto-mode is active/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('discardMilestone throws when auto-mode is active', () => {
    const base = createFixture();
    try {
      _setAutoActiveForTest(true);
      assert.throws(
        () => discardMilestone(base, 'M001'),
        /auto-mode is active/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('parkMilestone proceeds normally when auto-mode is inactive', () => {
    const base = createFixture();
    try {
      _setAutoActiveForTest(false);
      const result = parkMilestone(base, 'M001', 'baseline');
      assert.ok(result, 'park succeeds when auto is inactive');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
