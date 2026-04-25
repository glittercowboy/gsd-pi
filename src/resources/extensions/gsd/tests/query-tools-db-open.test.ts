/**
 * Regression test for #3672 — query-tools uses ensureDbOpen
 *
 * gsd_milestone_status previously called isDbAvailable() but never
 * ensureDbOpen(), making it always fail outside auto-mode sessions.
 * The fix imports ensureDbOpen from dynamic-tools and calls it before
 * querying the DB.
 *
 * This structural test verifies the ensureDbOpen import and usage exist
 * in query-tools.ts.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'bootstrap', 'query-tools.ts'), 'utf-8');

describe('query-tools ensureDbOpen usage (#3672)', () => {
  test('imports ensureDbOpen from dynamic-tools', () => {
    assert.match(source, /ensureDbOpen.*import\(|import.*ensureDbOpen/,
      'query-tools should import ensureDbOpen');
  });

  test('calls ensureDbOpen() before DB queries', () => {
    assert.match(source, /await ensureDbOpen\(\)/,
      'query-tools should call await ensureDbOpen()');
  });

  test('no longer imports isDbAvailable in the execute path', () => {
    // The old code imported isDbAvailable and checked it; the fix removed that
    // The execute function should not destructure isDbAvailable from gsd-db
    const executeBlock = source.slice(source.indexOf('async execute('));
    assert.doesNotMatch(executeBlock, /isDbAvailable,/,
      'execute path should not destructure isDbAvailable (replaced by ensureDbOpen)');
  });

  test('uses dbAvailable result from ensureDbOpen', () => {
    assert.match(source, /dbAvailable\s*=\s*await ensureDbOpen\(\)/,
      'should store ensureDbOpen result in dbAvailable');
  });
});
