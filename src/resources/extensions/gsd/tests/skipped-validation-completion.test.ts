/**
 * Regression test for #3698 — allow milestone completion when validation
 * was skipped by preference
 *
 * When validation is skipped due to user preference (e.g. budget profile),
 * auto-dispatch should recognize the "skipped by preference" pattern and
 * allow completion instead of treating it as a missing validation.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const autoDispatchSrc = readFileSync(
  join(__dirname, '..', 'auto-dispatch.ts'),
  'utf-8',
);

describe('skipped validation completion (#3698)', () => {
  test('skippedByPreference regex detection exists', () => {
    assert.match(autoDispatchSrc, /skippedByPreference/,
      'skippedByPreference variable should exist in auto-dispatch.ts');
  });

  test('regex matches skip-by-preference patterns', () => {
    assert.match(autoDispatchSrc, /skip\(\?:ped\)\?\[\\s\\-\]\+\(\?:by\|per\|due to\)/,
      'should have regex matching "skipped by/per/due to" patterns');
  });

  test('skippedByPreference feeds into operational check', () => {
    assert.match(autoDispatchSrc, /hasOperationalCheck\s*=\s*skippedByPreference/,
      'skippedByPreference should be part of hasOperationalCheck');
  });
});
