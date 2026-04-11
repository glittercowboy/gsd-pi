/**
 * Regression test — .bg-shell/ added to BASELINE_PATTERNS in gitignore.ts
 *
 * The bg-shell background process directory was not included in the
 * baseline gitignore patterns, causing it to appear as untracked in
 * git status and potentially be committed.
 *
 * Structural verification test — reads source to confirm .bg-shell/
 * is in BASELINE_PATTERNS.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'gitignore.ts'), 'utf-8');

describe('.bg-shell/ in BASELINE_PATTERNS', () => {
  test('BASELINE_PATTERNS array is defined', () => {
    assert.match(source, /const BASELINE_PATTERNS\s*=/,
      'BASELINE_PATTERNS should be defined');
  });

  test('.bg-shell/ is included in BASELINE_PATTERNS', () => {
    // Extract the BASELINE_PATTERNS array content
    const patternsStart = source.indexOf('BASELINE_PATTERNS');
    const arrayStart = source.indexOf('[', patternsStart);
    const arrayEnd = source.indexOf('] as const', arrayStart);
    const patternsContent = source.slice(arrayStart, arrayEnd);
    assert.match(patternsContent, /\.bg-shell\//,
      '.bg-shell/ should be in BASELINE_PATTERNS');
  });
});
