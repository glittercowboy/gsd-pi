/**
 * Regression test for #3671 — isGhostMilestone detects phantom queued rows
 *
 * gsd_milestone_generate_id inserts a DB row with status "queued" as a side
 * effect. If the milestone is never planned, isGhostMilestone previously
 * returned false for any milestone with a DB row, blocking the state machine.
 *
 * The fix makes isGhostMilestone treat a "queued" DB row with no disk
 * artifacts (CONTEXT, ROADMAP, SUMMARY) as a ghost.
 *
 * This structural test verifies the dbRow.status === 'queued' guard exists.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'state.ts'), 'utf-8');

describe('isGhostMilestone phantom queued detection (#3671)', () => {
  test('isGhostMilestone function exists', () => {
    assert.match(source, /export function isGhostMilestone\(/,
      'isGhostMilestone should be exported');
  });

  test('checks dbRow.status === queued', () => {
    assert.match(source, /dbRow\.status\s*===\s*['"]queued['"]/,
      'isGhostMilestone should check dbRow.status === "queued"');
  });

  test('checks for CONTEXT disk artifact', () => {
    assert.match(source, /resolveMilestoneFile\(basePath,\s*mid,\s*["']CONTEXT["']\)/,
      'should check for CONTEXT file');
  });

  test('checks for ROADMAP disk artifact', () => {
    assert.match(source, /resolveMilestoneFile\(basePath,\s*mid,\s*["']ROADMAP["']\)/,
      'should check for ROADMAP file');
  });

  test('checks for SUMMARY disk artifact', () => {
    assert.match(source, /resolveMilestoneFile\(basePath,\s*mid,\s*["']SUMMARY["']\)/,
      'should check for SUMMARY file');
  });

  test('returns !hasContent for queued rows (ghost if no artifacts)', () => {
    assert.match(source, /return !hasContent/,
      'should return !hasContent for queued phantom milestones');
  });
});
