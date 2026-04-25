/**
 * Regression test for #3578 — note captures marked as executed
 *
 * Note-classified captures were stuck in "resolved but not executed" limbo
 * because executeTriageResolutions only handled inject/replan/defer. The fix
 * adds a filter for classification === "note" and calls markCaptureExecuted
 * for each matching capture.
 *
 * Structural verification test — reads source to confirm the note filter
 * and markCaptureExecuted call exist.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, '..', 'triage-resolution.ts'), 'utf-8');

describe('note captures executed in triage resolution (#3578)', () => {
  test('markCaptureExecuted is imported', () => {
    assert.match(source, /markCaptureExecuted/,
      'markCaptureExecuted should be imported');
  });

  test('note classification filter exists', () => {
    assert.match(source, /classification\s*===\s*"note"/,
      'filter should check classification === "note"');
  });

  test('note filter checks resolved status and not-executed', () => {
    assert.match(source, /status\s*===\s*"resolved"\s*&&\s*!c\.executed\s*&&\s*c\.classification\s*===\s*"note"/,
      'filter should check resolved + not-executed + note classification');
  });

  test('markCaptureExecuted is called for note captures', () => {
    // The source should call markCaptureExecuted for note captures
    const noteSection = source.slice(source.indexOf('classification === "note"'));
    assert.match(noteSection, /markCaptureExecuted\(basePath,\s*cap\.id\)/,
      'markCaptureExecuted should be called for note captures');
  });
});
