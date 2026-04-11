/**
 * Regression test for #3699 — import milestones with all-done slices as complete
 *
 * During DB migration, milestones whose roadmap slices are all marked done
 * should be imported with status "complete" instead of "active".
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const importerSrc = readFileSync(
  join(__dirname, '..', 'md-importer.ts'),
  'utf-8',
);

describe('import done milestones as complete (#3699)', () => {
  test('all-slices-done check sets milestoneStatus to complete', () => {
    // The importer should check if all roadmap slices are done
    assert.match(importerSrc, /roadmap\.slices\.every\(s\s*=>\s*s\.done\)/,
      'should check roadmap.slices.every(s => s.done)');
  });

  test('milestoneStatus is set to complete when all slices done', () => {
    // Find the all-done guard and verify it sets 'complete'
    const everyIdx = importerSrc.indexOf('roadmap.slices.every(s => s.done)');
    assert.ok(everyIdx > -1, 'all-slices-done check should exist');
    const afterCheck = importerSrc.slice(everyIdx, everyIdx + 200);
    assert.match(afterCheck, /milestoneStatus\s*=\s*'complete'/,
      'should set milestoneStatus to complete when all slices are done');
  });

  test('roadmap.slices.length > 0 guard prevents false positives', () => {
    assert.match(importerSrc, /roadmap\.slices\.length\s*>\s*0/,
      'should guard against empty slices array');
  });
});
