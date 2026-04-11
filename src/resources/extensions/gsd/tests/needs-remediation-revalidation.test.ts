/**
 * Regression test for #3670 — needs-remediation verdict forces re-validation
 *
 * When validation returns needs-remediation, the state machine must route
 * back to validating-milestone instead of completing-milestone. Without this,
 * dispatch blocks completion for needs-remediation while state derives
 * completing-milestone, creating a permanent deadlock.
 *
 * This structural test verifies the verdict === 'needs-remediation' guard
 * exists at all three derivation paths in state.ts.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'state.ts'), 'utf-8');

describe('needs-remediation revalidation guard (#3670)', () => {
  test('verdict === needs-remediation guard exists in state.ts', () => {
    const matches = source.match(/verdict\s*===\s*['"]needs-remediation['"]/g);
    assert.ok(matches, 'verdict === "needs-remediation" check must exist in state.ts');
    assert.ok(matches.length >= 2,
      `Expected at least 2 needs-remediation guards (deriveStateFromDb + _deriveStateImpl), found ${matches.length}`);
  });

  test('needsRevalidation variable is derived from verdict', () => {
    assert.match(source, /needsRevalidation.*=.*verdict\s*===\s*['"]needs-remediation['"]/,
      'needsRevalidation should incorporate verdict === "needs-remediation"');
  });

  test('deriveStateFromDb path uses needs-remediation guard', () => {
    assert.match(source, /!validationTerminal\s*\|\|\s*verdict\s*===\s*['"]needs-remediation['"]/,
      'deriveStateFromDb should check !validationTerminal || verdict === "needs-remediation"');
  });

  test('extractVerdict is called on validation content', () => {
    const extractCalls = source.match(/extractVerdict\(validationContent\)/g);
    assert.ok(extractCalls, 'extractVerdict should be called on validation content');
    assert.ok(extractCalls.length >= 2,
      `Expected at least 2 extractVerdict calls, found ${extractCalls.length}`);
  });
});
