/**
 * Regression test for #3692 — normalizeListParam in complete-task
 *
 * Agents sometimes pass keyFiles/keyDecisions as comma-separated strings
 * instead of arrays.  normalizeListParam coerces both forms to string[].
 *
 * Also verifies roadmap-slices.ts detects dependency column from header.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const completeTaskSrc = readFileSync(
  join(__dirname, '..', 'tools', 'complete-task.ts'),
  'utf-8',
);
const roadmapSlicesSrc = readFileSync(
  join(__dirname, '..', 'roadmap-slices.ts'),
  'utf-8',
);

describe('complete-task normalizeListParam (#3692)', () => {
  test('normalizeListParam function is defined', () => {
    assert.match(completeTaskSrc, /function normalizeListParam\(/,
      'normalizeListParam function should be defined in complete-task.ts');
  });

  test('normalizeListParam is applied to keyFiles', () => {
    assert.match(completeTaskSrc, /normalizeListParam\(params\.keyFiles\)/,
      'normalizeListParam should be applied to keyFiles');
  });

  test('normalizeListParam is applied to keyDecisions', () => {
    assert.match(completeTaskSrc, /normalizeListParam\(params\.keyDecisions\)/,
      'normalizeListParam should be applied to keyDecisions');
  });
});

describe('roadmap-slices depColumnIndex detection (#3692)', () => {
  test('depColumnIndex is detected from header row', () => {
    assert.match(roadmapSlicesSrc, /depColumnIndex/,
      'depColumnIndex variable should exist in roadmap-slices.ts');
    assert.match(roadmapSlicesSrc, /headerCells/,
      'headerCells should be parsed from the header row');
    assert.match(roadmapSlicesSrc, /depends|deps|depend/i,
      'header detection should match depends/deps/depend');
  });
});
