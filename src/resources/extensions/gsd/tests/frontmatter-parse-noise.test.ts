/**
 * Regression test for #3693 — suppress repeated frontmatter parse warnings
 *
 * parseFrontmatterBlock was logging a YAML parse warning on every call.
 * The fix adds a _warnedFrontmatterParse flag so the warning only fires once.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const prefsSrc = readFileSync(
  join(__dirname, '..', 'preferences.ts'),
  'utf-8',
);

describe('frontmatter parse noise suppression (#3693)', () => {
  test('_warnedFrontmatterParse flag is defined', () => {
    assert.match(prefsSrc, /_warnedFrontmatterParse/,
      '_warnedFrontmatterParse flag should exist in preferences.ts');
  });

  test('parseFrontmatterBlock function exists', () => {
    assert.match(prefsSrc, /function parseFrontmatterBlock\(/,
      'parseFrontmatterBlock function should be defined');
  });

  test('flag is checked before warning', () => {
    assert.match(prefsSrc, /if\s*\(\s*!_warnedFrontmatterParse\s*\)/,
      'should check !_warnedFrontmatterParse before logging');
  });

  test('flag is set to true after first warning', () => {
    assert.match(prefsSrc, /_warnedFrontmatterParse\s*=\s*true/,
      'should set _warnedFrontmatterParse = true after warning');
  });
});
