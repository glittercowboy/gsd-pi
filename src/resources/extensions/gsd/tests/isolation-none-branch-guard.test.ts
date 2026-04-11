/**
 * Regression test for #3675 — isolation:none stale branch guard
 *
 * When switching from isolation:branch/worktree to isolation:none, HEAD
 * could remain on a milestone/<MID> branch. The fix in auto-start.ts
 * detects this and auto-checks out to the integration branch.
 *
 * This structural test verifies the milestone/ branch check exists
 * in auto-start.ts.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'auto-start.ts'), 'utf-8');

describe('isolation:none stale branch guard (#3675)', () => {
  test('checks for milestone/ branch prefix', () => {
    assert.match(source, /startsWith\(["']milestone\//,
      'auto-start should check for milestone/ branch prefix');
  });

  test('imports nativeGetCurrentBranch', () => {
    assert.match(source, /nativeGetCurrentBranch/,
      'auto-start should import nativeGetCurrentBranch');
  });

  test('imports nativeDetectMainBranch', () => {
    assert.match(source, /nativeDetectMainBranch/,
      'auto-start should import nativeDetectMainBranch');
  });

  test('imports nativeCheckoutBranch', () => {
    assert.match(source, /nativeCheckoutBranch/,
      'auto-start should import nativeCheckoutBranch');
  });

  test('guard is conditional on isolation mode "none"', () => {
    assert.match(source, /getIsolationMode\(\)\s*===\s*["']none["']/,
      'guard should only activate when isolation mode is "none"');
  });

  test('calls nativeCheckoutBranch to return to integration branch', () => {
    assert.match(source, /nativeCheckoutBranch\(base,\s*integrationBranch\)/,
      'should checkout to the integration branch');
  });

  test('guard is wrapped in try-catch (non-fatal)', () => {
    // Find the milestone/ check and verify it is inside a try block
    const milestoneIdx = source.indexOf('startsWith("milestone/")');
    assert.ok(milestoneIdx > 0, 'milestone/ check should exist');
    const before = source.slice(Math.max(0, milestoneIdx - 500), milestoneIdx);
    assert.match(before, /try\s*\{/,
      'milestone branch guard should be inside a try block');
  });
});
