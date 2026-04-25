/**
 * Regression test for #3624 — cap run-uat dispatch attempts
 *
 * When verification commands fail before writing a verdict, the run-uat
 * dispatch rule fires repeatedly in an infinite loop. The fix adds a
 * MAX_UAT_ATTEMPTS constant and calls incrementUatCount before dispatch
 * to cap the number of attempts.
 *
 * Structural verification test — reads source to confirm MAX_UAT_ATTEMPTS
 * and incrementUatCount exist.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'auto-dispatch.ts'), 'utf-8');

describe('run-uat replay cap (#3624)', () => {
  test('MAX_UAT_ATTEMPTS constant is defined', () => {
    assert.match(source, /const MAX_UAT_ATTEMPTS\s*=\s*\d+/,
      'MAX_UAT_ATTEMPTS constant should be defined');
  });

  test('incrementUatCount function is exported', () => {
    assert.match(source, /export function incrementUatCount\(/,
      'incrementUatCount should be an exported function');
  });

  test('getUatCount function is exported', () => {
    assert.match(source, /export function getUatCount\(/,
      'getUatCount should be an exported function');
  });

  test('incrementUatCount is called before dispatch in rule', () => {
    // incrementUatCount should be called before the dispatch return
    const ruleSection = source.slice(source.indexOf('checkNeedsRunUat'));
    assert.match(ruleSection, /incrementUatCount\(/,
      'incrementUatCount should be called in the dispatch rule');
  });

  test('attempts are compared against MAX_UAT_ATTEMPTS', () => {
    assert.match(source, /attempts\s*>\s*MAX_UAT_ATTEMPTS/,
      'dispatch should check attempts > MAX_UAT_ATTEMPTS');
  });
});
