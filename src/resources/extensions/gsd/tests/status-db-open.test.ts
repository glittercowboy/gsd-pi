/**
 * Regression test for #3691 — /gsd status opens DB before deriveState
 *
 * In cold sessions the DB was not opened before deriveState, causing
 * status to fall back to filesystem-only state.  The fix adds an
 * ensureDbOpen() call before deriveState in handleStatus.
 *
 * Also verifies that quick.ts checks getIsolationMode before branching.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const coreSrc = readFileSync(
  join(__dirname, '..', 'commands', 'handlers', 'core.ts'),
  'utf-8',
);
const quickSrc = readFileSync(
  join(__dirname, '..', 'quick.ts'),
  'utf-8',
);

describe('status opens DB before deriveState (#3691)', () => {
  test('handleStatus calls ensureDbOpen before deriveState', () => {
    const ensureIdx = coreSrc.indexOf('ensureDbOpen');
    const deriveIdx = coreSrc.indexOf('deriveState(basePath)');
    assert.ok(ensureIdx > -1, 'ensureDbOpen call should exist in core.ts');
    assert.ok(deriveIdx > -1, 'deriveState(basePath) call should exist in core.ts');
    assert.ok(
      ensureIdx < deriveIdx,
      'ensureDbOpen must appear before deriveState so DB is ready',
    );
  });

  test('quick.ts checks getIsolationMode before branching', () => {
    assert.match(quickSrc, /getIsolationMode\(\)/,
      'quick.ts should call getIsolationMode()');
    assert.match(quickSrc, /getIsolationMode\(\)\s*!==\s*"none"/,
      'quick.ts should compare isolation mode against "none"');
  });
});
