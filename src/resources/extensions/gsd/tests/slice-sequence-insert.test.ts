/**
 * Regression test for #3697 — set slice sequence on insert
 *
 * All three insertSlice call sites must pass a sequence value so slices
 * are ordered correctly instead of defaulting to 0.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const planMilestoneSrc = readFileSync(
  join(__dirname, '..', 'tools', 'plan-milestone.ts'),
  'utf-8',
);
const reassessRoadmapSrc = readFileSync(
  join(__dirname, '..', 'tools', 'reassess-roadmap.ts'),
  'utf-8',
);
const mdImporterSrc = readFileSync(
  join(__dirname, '..', 'md-importer.ts'),
  'utf-8',
);

describe('slice sequence on insert (#3697)', () => {
  test('plan-milestone.ts passes sequence to insertSlice', () => {
    assert.match(planMilestoneSrc, /insertSlice\(/,
      'plan-milestone.ts should call insertSlice');
    assert.match(planMilestoneSrc, /sequence:\s*i\s*\+\s*1/,
      'plan-milestone.ts should pass sequence: i + 1');
  });

  test('reassess-roadmap.ts passes sequence to insertSlice', () => {
    assert.match(reassessRoadmapSrc, /insertSlice\(/,
      'reassess-roadmap.ts should call insertSlice');
    assert.match(reassessRoadmapSrc, /sequence:\s*existingCount\s*\+\s*i\s*\+\s*1/,
      'reassess-roadmap.ts should pass sequence: existingCount + i + 1');
  });

  test('md-importer.ts passes sequence to insertSlice', () => {
    assert.match(mdImporterSrc, /insertSlice\(/,
      'md-importer.ts should call insertSlice');
    assert.match(mdImporterSrc, /sequence:\s*si\s*\+\s*1/,
      'md-importer.ts should pass sequence: si + 1');
  });
});
