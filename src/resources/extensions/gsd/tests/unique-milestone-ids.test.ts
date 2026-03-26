// Tests for unique milestone ID exports from T01/S01 — covers the S01→S02 boundary contract.
//
// Sections:
//   (a) MILESTONE_ID_RE: regex matching/rejection
//   (b) extractMilestoneSeq: old/new/invalid → number
//   (c) parseMilestoneId: old/new/invalid → structured result
//   (d) milestoneIdSort: ordering of mixed arrays
//   (e) generateMilestoneSuffix: format, length, uniqueness
//   (f) nextMilestoneId: uniqueEnabled true/false, mixed arrays
//   (g) maxMilestoneNum: empty, old, new, mixed, non-matching
//   (h) Preferences round-trip: validate, merge behavior via renderPreferencesForSystemPrompt

import {
  MILESTONE_ID_RE,
  extractMilestoneSeq,
  parseMilestoneId,
  milestoneIdSort,
  generateMilestoneSuffix,
  nextMilestoneId,
  maxMilestoneNum,
} from '../guided-flow.ts';

import { renderPreferencesForSystemPrompt } from '../preferences.ts';
import type { GSDPreferences } from '../preferences.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';


// ─── Tests ─────────────────────────────────────────────────────────────────

describe('unique-milestone-ids', async () => {
  console.log('unique-milestone-ids tests');

  // (a) MILESTONE_ID_RE
  {
    console.log('  (a) MILESTONE_ID_RE');
    // Should match
    assert.ok(MILESTONE_ID_RE.test('M001'), 'matches M001');
    assert.ok(MILESTONE_ID_RE.test('M999'), 'matches M999');
    assert.ok(MILESTONE_ID_RE.test('M001-abc123'), 'matches M001-abc123');
    assert.ok(MILESTONE_ID_RE.test('M042-z9a8b7'), 'matches M042-z9a8b7');

    // Should reject
    assert.ok(!MILESTONE_ID_RE.test('M1'), 'rejects M1 (too few digits)');
    assert.ok(!MILESTONE_ID_RE.test('M0001'), 'rejects M0001 (too many digits)');
    assert.ok(!MILESTONE_ID_RE.test('M001-ABCDEF'), 'rejects M001-ABCDEF (uppercase prefix)');
    assert.ok(!MILESTONE_ID_RE.test('M001-short'), 'rejects M001-short (5-char prefix)');
    assert.ok(!MILESTONE_ID_RE.test('M001-toolong1'), 'rejects M001-toolong1 (>6-char prefix)');
    assert.ok(!MILESTONE_ID_RE.test('IM001'), 'rejects IM001 (prefix before M)');
    assert.ok(!MILESTONE_ID_RE.test(''), 'rejects empty string');
    assert.ok(!MILESTONE_ID_RE.test('M001extra'), 'rejects M001extra (trailing chars)');
    assert.ok(!MILESTONE_ID_RE.test('notes'), 'rejects non-milestone string');
  }

  // (b) extractMilestoneSeq
  {
    console.log('  (b) extractMilestoneSeq');
    // Old format
    assert.deepStrictEqual(extractMilestoneSeq('M001'), 1, 'M001 → 1');
    assert.deepStrictEqual(extractMilestoneSeq('M042'), 42, 'M042 → 42');
    assert.deepStrictEqual(extractMilestoneSeq('M999'), 999, 'M999 → 999');

    // Unique format
    assert.deepStrictEqual(extractMilestoneSeq('M001-abc123'), 1, 'M001-abc123 → 1');
    assert.deepStrictEqual(extractMilestoneSeq('M042-z9a8b7'), 42, 'M042-z9a8b7 → 42');

    // Invalid → 0
    assert.deepStrictEqual(extractMilestoneSeq(''), 0, 'empty → 0');
    assert.deepStrictEqual(extractMilestoneSeq('notes'), 0, 'notes → 0');
    assert.deepStrictEqual(extractMilestoneSeq('M1'), 0, 'M1 → 0');
    assert.deepStrictEqual(extractMilestoneSeq('.DS_Store'), 0, '.DS_Store → 0');
    assert.deepStrictEqual(extractMilestoneSeq('M-ABC-001'), 0, 'M-ABC-001 (old format) → 0');
  }

  // (c) parseMilestoneId
  {
    console.log('  (c) parseMilestoneId');
    // Old format — no suffix
    assert.deepStrictEqual(parseMilestoneId('M001'), { num: 1 }, 'M001 → { num: 1 }');
    assert.deepStrictEqual(parseMilestoneId('M042'), { num: 42 }, 'M042 → { num: 42 }');

    // Unique format — with suffix
    assert.deepStrictEqual(parseMilestoneId('M001-abc123'), { suffix: 'abc123', num: 1 }, 'M001-abc123 → { suffix, num }');
    assert.deepStrictEqual(parseMilestoneId('M042-z9a8b7'), { suffix: 'z9a8b7', num: 42 }, 'M042-z9a8b7 → { suffix, num }');

    // Invalid → { num: 0 }
    assert.deepStrictEqual(parseMilestoneId(''), { num: 0 }, 'empty → { num: 0 }');
    assert.deepStrictEqual(parseMilestoneId('notes'), { num: 0 }, 'notes → { num: 0 }');
    assert.deepStrictEqual(parseMilestoneId('M001-ABCDEF'), { num: 0 }, 'uppercase suffix → { num: 0 }');
    assert.deepStrictEqual(parseMilestoneId('M1'), { num: 0 }, 'M1 → { num: 0 }');
  }

  // (d) milestoneIdSort
  {
    console.log('  (d) milestoneIdSort');
    const mixed = ['M003-abc123', 'M001', 'M002-z9a8b7'];
    const sorted = [...mixed].sort(milestoneIdSort);
    assert.deepStrictEqual(sorted, ['M001', 'M002-z9a8b7', 'M003-abc123'], 'sorts mixed IDs by sequence number');

    // All old format
    const oldOnly = ['M003', 'M001', 'M002'];
    assert.deepStrictEqual([...oldOnly].sort(milestoneIdSort), ['M001', 'M002', 'M003'], 'sorts old-format IDs');

    // Invalid entries sort to front (seq 0)
    const withInvalid = ['M002', 'notes', 'M001'];
    assert.deepStrictEqual([...withInvalid].sort(milestoneIdSort), ['notes', 'M001', 'M002'], 'invalid entries (seq 0) sort first');
  }

  // (e) generateMilestoneSuffix
  {
    console.log('  (e) generateMilestoneSuffix');
    const suffix1 = generateMilestoneSuffix();
    assert.deepStrictEqual(suffix1.length, 6, 'suffix length is 6');
    assert.match(suffix1, /^[a-z0-9]{6}$/, 'suffix matches [a-z0-9]{6}');

    const suffix2 = generateMilestoneSuffix();
    assert.deepStrictEqual(suffix2.length, 6, 'second suffix length is 6');
    assert.match(suffix2, /^[a-z0-9]{6}$/, 'second suffix matches [a-z0-9]{6}');

    // Two calls should produce different results (36^6 = ~2.2B possibilities)
    assert.ok(suffix1 !== suffix2, 'two calls produce different suffixes');
  }

  // (f) nextMilestoneId
  {
    console.log('  (f) nextMilestoneId');
    // uniqueEnabled=false (default) → old format
    assert.deepStrictEqual(nextMilestoneId([]), 'M001', 'empty + uniqueEnabled=false → M001');
    assert.deepStrictEqual(nextMilestoneId(['M001', 'M002']), 'M003', 'sequential + uniqueEnabled=false → M003');
    assert.deepStrictEqual(nextMilestoneId(['M001', 'M002'], false), 'M003', 'explicit false → M003');

    // uniqueEnabled=true → unique format
    const newId = nextMilestoneId([], true);
    assert.match(newId, MILESTONE_ID_RE, 'uniqueEnabled=true produces valid ID');
    assert.ok(newId.startsWith('M001-'), 'uniqueEnabled=true starts with M001-');
    assert.match(newId, /^M001-[a-z0-9]{6}$/, 'empty + uniqueEnabled=true → M001-{rand6}');

    // Mixed array with uniqueEnabled=true
    const mixedIds = ['M001', 'M003-abc123', 'M002'];
    const nextNew = nextMilestoneId(mixedIds, true);
    assert.match(nextNew, MILESTONE_ID_RE, 'mixed array + uniqueEnabled=true → valid ID');
    assert.match(nextNew, /^M004-[a-z0-9]{6}$/, 'mixed array max=3 → M004-{rand6}');

    // Mixed array with uniqueEnabled=false
    assert.deepStrictEqual(nextMilestoneId(mixedIds, false), 'M004', 'mixed array + uniqueEnabled=false → M004');

    // Correct sequential number from mixed arrays
    const mixedIds2 = ['M005-xyz999', 'M002'];
    assert.deepStrictEqual(nextMilestoneId(mixedIds2, false), 'M006', 'mixed max=5 → M006');
    const nextNew2 = nextMilestoneId(mixedIds2, true);
    assert.match(nextNew2, /^M006-[a-z0-9]{6}$/, 'mixed max=5 + unique → M006-{rand6}');
  }

  // (g) maxMilestoneNum
  {
    console.log('  (g) maxMilestoneNum');
    // Empty
    assert.deepStrictEqual(maxMilestoneNum([]), 0, 'empty → 0');

    // Old format only
    assert.deepStrictEqual(maxMilestoneNum(['M001', 'M002', 'M003']), 3, 'old format only → 3');

    // Unique format only — must not return NaN
    assert.deepStrictEqual(maxMilestoneNum(['M001-abc123', 'M002-def456']), 2, 'unique format only → 2');
    assert.ok(!Number.isNaN(maxMilestoneNum(['M001-abc123'])), 'unique format does not return NaN');

    // Mixed formats
    assert.deepStrictEqual(maxMilestoneNum(['M001', 'M003-abc123', 'M002']), 3, 'mixed → 3');

    // Non-matching entries ignored
    assert.deepStrictEqual(maxMilestoneNum(['M001', 'notes', '.DS_Store', 'M003']), 3, 'non-matching ignored → 3');
    assert.deepStrictEqual(maxMilestoneNum(['notes', '.DS_Store']), 0, 'all non-matching → 0');
  }

  // (h) Preferences round-trip via renderPreferencesForSystemPrompt
  {
    console.log('  (h) Preferences round-trip');

    // validate { unique_milestone_ids: true } → field preserved (no validation error)
    const prefsTrue: GSDPreferences = { unique_milestone_ids: true };
    const renderedTrue = renderPreferencesForSystemPrompt(prefsTrue);
    assert.ok(!renderedTrue.includes('some preference values were ignored'), 'unique_milestone_ids: true validates without error');

    // validate { unique_milestone_ids: undefined } → field absent (no error)
    const prefsUndefined: GSDPreferences = {};
    const renderedUndefined = renderPreferencesForSystemPrompt(prefsUndefined);
    assert.ok(!renderedUndefined.includes('some preference values were ignored'), 'undefined unique_milestone_ids validates without error');

    // validate { unique_milestone_ids: false } → also valid
    const prefsFalse: GSDPreferences = { unique_milestone_ids: false };
    const renderedFalse = renderPreferencesForSystemPrompt(prefsFalse);
    assert.ok(!renderedFalse.includes('some preference values were ignored'), 'unique_milestone_ids: false validates without error');

    // validate coercion: truthy non-boolean → coerced to boolean (no crash)
    const prefsCoerced: GSDPreferences = { unique_milestone_ids: 1 as unknown as boolean };
    const renderedCoerced = renderPreferencesForSystemPrompt(prefsCoerced);
    assert.ok(!renderedCoerced.includes('some preference values were ignored'), 'truthy non-boolean coerces without validation error');

    // GSDPreferences interface accepts the field (compile-time check — if this compiles, it works)
    const prefs: GSDPreferences = { unique_milestone_ids: true, version: 1 };
    assert.ok(prefs.unique_milestone_ids === true, 'GSDPreferences interface accepts unique_milestone_ids');
  }
});
