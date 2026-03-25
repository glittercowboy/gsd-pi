// GSD Extension — write-intercept unit tests
// Tests isBlockedStateFile() and BLOCKED_WRITE_ERROR constant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedStateFile, BLOCKED_WRITE_ERROR } from '../write-intercept.ts';

// ─── isBlockedStateFile: blocked paths ───────────────────────────────────

test('write-intercept: blocks unix .gsd/STATE.md path', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/STATE.md'), true);
});

test('write-intercept: blocks relative path with dir prefix before .gsd/STATE.md', () => {
  assert.strictEqual(isBlockedStateFile('project/.gsd/STATE.md'), true);
});

test('write-intercept: blocks bare relative .gsd/STATE.md (no leading separator)', () => {
  // (^|[/\\]) matches paths that start with .gsd/ — covers the case where write
  // tools receive a bare relative path before the file exists (realpathSync fails).
  assert.strictEqual(isBlockedStateFile('.gsd/STATE.md'), true);
});

test('write-intercept: blocks nested project .gsd/STATE.md path', () => {
  assert.strictEqual(isBlockedStateFile('/Users/dev/my-project/.gsd/STATE.md'), true);
});

test('write-intercept: blocks .gsd/projects/<name>/STATE.md (symlinked projects path)', () => {
  assert.strictEqual(isBlockedStateFile('/home/user/.gsd/projects/my-project/STATE.md'), true);
});

// ─── isBlockedStateFile: allowed paths ───────────────────────────────────

test('write-intercept: allows .gsd/ROADMAP.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/ROADMAP.md'), false);
});

test('write-intercept: allows .gsd/PLAN.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/PLAN.md'), false);
});

test('write-intercept: allows .gsd/REQUIREMENTS.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/REQUIREMENTS.md'), false);
});

test('write-intercept: allows .gsd/SUMMARY.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/SUMMARY.md'), false);
});

test('write-intercept: allows .gsd/PROJECT.md', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/PROJECT.md'), false);
});

test('write-intercept: allows regular source files', () => {
  assert.strictEqual(isBlockedStateFile('/project/src/index.ts'), false);
});

test('write-intercept: allows slice plan files', () => {
  assert.strictEqual(isBlockedStateFile('/project/.gsd/milestones/M001/slices/S01/S01-PLAN.md'), false);
});

test('write-intercept: does not block files named STATE.md outside .gsd/', () => {
  assert.strictEqual(isBlockedStateFile('/project/docs/STATE.md'), false);
});

// ─── BLOCKED_WRITE_ERROR: content ────────────────────────────────────────

test('write-intercept: BLOCKED_WRITE_ERROR is a non-empty string', () => {
  assert.strictEqual(typeof BLOCKED_WRITE_ERROR, 'string');
  assert.ok(BLOCKED_WRITE_ERROR.length > 0);
});

test('write-intercept: BLOCKED_WRITE_ERROR mentions engine tool calls', () => {
  assert.ok(BLOCKED_WRITE_ERROR.includes('gsd_complete_task'), 'should mention gsd_complete_task');
  assert.ok(BLOCKED_WRITE_ERROR.includes('engine tool calls'), 'should mention engine tool calls');
});
