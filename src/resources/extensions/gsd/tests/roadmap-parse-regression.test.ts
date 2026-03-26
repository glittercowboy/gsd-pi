/**
 * roadmap-parse-regression.test.ts — Regression tests for roadmap parsing.
 *
 * Exercises parseRoadmapSlices() and the prose fallback parser against
 * every known LLM-generated roadmap variant that has caused production bugs.
 *
 * Regression coverage for:
 *   #807   Prose slice headers not parsed → "No slice eligible" block
 *   #1248  Prose header regex only matched H2 with colon separator
 *   #1243  Same root cause as #1248
 *
 * Also covers dependency expansion (range syntax) and edge cases.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoadmapSlices, expandDependencies } from '../roadmap-slices.ts';
  // ═══════════════════════════════════════════════════════════════════════
  // A. Standard machine-readable format (should always work)
  // ═══════════════════════════════════════════════════════════════════════


describe('roadmap-parse-regression', () => {
test('A. Standard checkbox format', () => {
    const content = [
      '# M001: Test Project',
      '',
      '## Slices',
      '',
      '- [ ] **S01: First Slice** `risk:low` `depends:[]`',
      '- [ ] **S02: Second Slice** `risk:medium` `depends:[S01]`',
      '- [x] **S03: Third Slice** `risk:high` `depends:[S01,S02]`',
      '',
      '## Boundary Map',
      '',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 3, 'standard format: 3 slices');
    assert.deepStrictEqual(slices[0].id, 'S01', 'S01 id');
    assert.deepStrictEqual(slices[0].title, 'First Slice', 'S01 title');
    assert.deepStrictEqual(slices[0].done, false, 'S01 not done');
    assert.deepStrictEqual(slices[0].risk, 'low', 'S01 risk');
    assert.deepStrictEqual(slices[0].depends.length, 0, 'S01 no deps');

    assert.deepStrictEqual(slices[1].id, 'S02', 'S02 id');
    assert.deepStrictEqual(slices[1].depends.length, 1, 'S02 has 1 dep');
    assert.deepStrictEqual(slices[1].depends[0], 'S01', 'S02 depends on S01');

    assert.deepStrictEqual(slices[2].id, 'S03', 'S03 id');
    assert.deepStrictEqual(slices[2].done, true, 'S03 is done');
    assert.deepStrictEqual(slices[2].risk, 'high', 'S03 risk');
    assert.deepStrictEqual(slices[2].depends.length, 2, 'S03 has 2 deps');
});

  // ═══════════════════════════════════════════════════════════════════════
  // B. Prose fallback: H2 with colon (the only format the old regex matched)
  // ═══════════════════════════════════════════════════════════════════════
test('B. Prose fallback: H2 with colon', () => {
    const content = [
      '# M001: Test',
      '',
      '## S01: Setup Foundation',
      '',
      'Do the setup work.',
      '',
      '## S02: Core Features',
      '',
      'Build the features.',
      '',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, 'prose H2 colon: 2 slices');
    assert.deepStrictEqual(slices[0].id, 'S01', 'S01 id');
    assert.deepStrictEqual(slices[0].title, 'Setup Foundation', 'S01 title');
    assert.deepStrictEqual(slices[1].id, 'S02', 'S02 id');
    assert.deepStrictEqual(slices[1].title, 'Core Features', 'S02 title');
});

  // ═══════════════════════════════════════════════════════════════════════
  // C. Regression #1248: H3 headers (the old regex only matched ##)
  // ═══════════════════════════════════════════════════════════════════════
test('C. #1248: H3 headers', () => {
    const content = [
      '# M001: Test',
      '',
      '### S01: Setup Foundation',
      '',
      'Do the setup work.',
      '',
      '### S02: Core Features',
      '',
      'Build the features.',
      '',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, '#1248 H3: 2 slices parsed');
    assert.deepStrictEqual(slices[0].id, 'S01', 'S01 from H3');
    assert.deepStrictEqual(slices[1].id, 'S02', 'S02 from H3');
});

  // ═══════════════════════════════════════════════════════════════════════
  // D. Regression #1248: H4 headers
  // ═══════════════════════════════════════════════════════════════════════
test('D. #1248: H4 headers', () => {
    const content = [
      '# M001: Test',
      '',
      '#### S01: Setup Foundation',
      '',
      '#### S02: Core Features',
      '',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, '#1248 H4: 2 slices parsed');
});

  // ═══════════════════════════════════════════════════════════════════════
  // E. Regression #1248: H1 header (unusual but LLMs produce it)
  // ═══════════════════════════════════════════════════════════════════════
test('E. #1248: H1 headers', () => {
    const content = [
      '# S01: Setup Foundation',
      '',
      'Setup stuff.',
      '',
      '# S02: Core Features',
      '',
      'Build stuff.',
      '',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, '#1248 H1: 2 slices parsed');
});

  // ═══════════════════════════════════════════════════════════════════════
  // F. Regression #1248: Bold-wrapped IDs
  // ═══════════════════════════════════════════════════════════════════════
test('F. #1248: Bold-wrapped', () => {
    const content1 = '## **S01: Setup Foundation**\n\nDo stuff.\n\n## **S02: Features**\n\nMore stuff.\n';
    const slices1 = parseRoadmapSlices(content1);
    assert.deepStrictEqual(slices1.length, 2, 'bold-wrapped: 2 slices');
    assert.deepStrictEqual(slices1[0].title, 'Setup Foundation', 'bold-wrapped: title extracted without bold');

    const content2 = '## **S01**: Setup Foundation\n\n## **S02**: Features\n';
    const slices2 = parseRoadmapSlices(content2);
    assert.deepStrictEqual(slices2.length, 2, 'bold ID only: 2 slices');
});

  // ═══════════════════════════════════════════════════════════════════════
  // G. Regression #1248: Dot separator
  // ═══════════════════════════════════════════════════════════════════════
test('G. #1248: Dot separator', () => {
    const content = '## S01. Setup Foundation\n\n## S02. Core Features\n';
    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, 'dot separator: 2 slices');
    assert.deepStrictEqual(slices[0].title, 'Setup Foundation', 'dot separator: title');
});

  // ═══════════════════════════════════════════════════════════════════════
  // H. Regression #1248: Em dash separator
  // ═══════════════════════════════════════════════════════════════════════
test('H. #1248: Em/en dash separators', () => {
    const content = '## S01 — Setup Foundation\n\n## S02 – Core Features\n';
    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, 'em/en dash: 2 slices');
});

  // ═══════════════════════════════════════════════════════════════════════
  // I. Regression #1248: Space-only separator (no punctuation)
  // ═══════════════════════════════════════════════════════════════════════
test('I. #1248: Space-only separator', () => {
    const content = '## S01 Setup Foundation\n\n## S02 Core Features\n';
    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, 'space-only: 2 slices');
    assert.deepStrictEqual(slices[0].title, 'Setup Foundation', 'space-only: title');
});

  // ═══════════════════════════════════════════════════════════════════════
  // J. Regression #1248: Non-zero-padded IDs
  // ═══════════════════════════════════════════════════════════════════════
test('J. #1248: Non-zero-padded IDs', () => {
    const content = '## S1: Setup\n\n## S2: Features\n';
    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, 'non-padded: 2 slices');
    assert.deepStrictEqual(slices[0].id, 'S1', 'non-padded: S1');
});

  // ═══════════════════════════════════════════════════════════════════════
  // K. Regression #1248: "Slice" prefix
  // ═══════════════════════════════════════════════════════════════════════
test('K. #1248: "Slice" prefix', () => {
    const content = '## Slice S01: Setup Foundation\n\n## Slice S02: Core Features\n';
    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, 'Slice prefix: 2 slices');
    assert.deepStrictEqual(slices[0].id, 'S01', 'Slice prefix: S01');
});

  // ═══════════════════════════════════════════════════════════════════════
  // L. Prose with "Depends on:" line
  // ═══════════════════════════════════════════════════════════════════════
test('L. Prose with Depends on:', () => {
    const content = [
      '## S01: Foundation',
      '',
      'Build the base.',
      '',
      '## S02: Features',
      '',
      '**Depends on:** S01',
      '',
      'Build features.',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, 'prose deps: 2 slices');
    assert.deepStrictEqual(slices[1].depends.length, 1, 'S02 has 1 dep');
    assert.deepStrictEqual(slices[1].depends[0], 'S01', 'S02 depends on S01');
});

  // ═══════════════════════════════════════════════════════════════════════
  // M. Empty / edge cases
  // ═══════════════════════════════════════════════════════════════════════
test('M. Edge cases', () => {
    assert.deepStrictEqual(parseRoadmapSlices('').length, 0, 'empty content → 0 slices');
    assert.deepStrictEqual(parseRoadmapSlices('# Just a title\n\nSome text.').length, 0, 'no slices at all → 0');

    // Mixed format: ## Slices section with one checkbox + prose below
    const mixed = [
      '## Slices',
      '',
      '- [ ] **S01: Foundation** `risk:low` `depends:[]`',
      '',
      '## S02: Features',
      '',
      'Prose content.',
    ].join('\n');
    const mixedSlices = parseRoadmapSlices(mixed);
    // The ## Slices section takes priority — prose headers outside it aren't picked up
    assert.deepStrictEqual(mixedSlices.length, 1, 'mixed: only 1 slice from ## Slices section');
    assert.deepStrictEqual(mixedSlices[0].id, 'S01', 'mixed: S01 from checkbox');
});

  // ═══════════════════════════════════════════════════════════════════════
  // N. Dependency range expansion
  // ═══════════════════════════════════════════════════════════════════════
test('N. Dependency range expansion', () => {
    assert.deepStrictEqual(
      expandDependencies(['S01-S04']),
      ['S01', 'S02', 'S03', 'S04'],
      'S01-S04 → 4 individual deps',
    );

    assert.deepStrictEqual(
      expandDependencies(['S01..S03']),
      ['S01', 'S02', 'S03'],
      'S01..S03 → 3 individual deps',
    );

    assert.deepStrictEqual(
      expandDependencies(['S01']),
      ['S01'],
      'single dep passes through',
    );

    assert.deepStrictEqual(
      expandDependencies(['S01', 'S03-S05']),
      ['S01', 'S03', 'S04', 'S05'],
      'mixed single + range',
    );

    assert.deepStrictEqual(
      expandDependencies(['']),
      [],
      'empty string filtered out',
    );
});

  // ═══════════════════════════════════════════════════════════════════════
  // O. No-separator colon-less: "S01:Title" (no space after colon)
  // ═══════════════════════════════════════════════════════════════════════
test('O. No space after colon', () => {
    const content = '## S01:Foundation\n\n## S02:Features\n';
    const slices = parseRoadmapSlices(content);
    // The regex uses [:\s.—–-]* which allows colon with no space
    assert.deepStrictEqual(slices.length, 2, 'no-space-colon: 2 slices');
});

  // ═══════════════════════════════════════════════════════════════════════
  // P. Three-digit padded IDs
  // ═══════════════════════════════════════════════════════════════════════
test('P. Three-digit padded IDs', () => {
    const content = '## S001: Foundation\n\n## S002: Features\n';
    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, 'three-digit: 2 slices');
    assert.deepStrictEqual(slices[0].id, 'S001', 'three-digit: S001');
});

  // ═══════════════════════════════════════════════════════════════════════
  // Q. Regression #1736: Table format under ## Slices
  // ═══════════════════════════════════════════════════════════════════════
test('Q. #1736: Table format under ## Slices', () => {
    const content = [
      '# M001: Test',
      '',
      '## Slices',
      '',
      '| Slice | Title | Risk | Status |',
      '| --- | --- | --- | --- |',
      '| S01 | Setup Foundation | Low | [x] Done |',
      '| S02 | Core Features | High | [ ] Pending |',
      '| S03 | Polish | Medium | [x] Done |',
      '',
      '## Boundary Map',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 3, '#1736 table: 3 slices');
    assert.deepStrictEqual(slices[0].id, 'S01', '#1736 table: S01 id');
    assert.deepStrictEqual(slices[0].title, 'Setup Foundation', '#1736 table: S01 title');
    assert.deepStrictEqual(slices[0].done, true, '#1736 table: S01 done');
    assert.deepStrictEqual(slices[0].risk, 'low', '#1736 table: S01 risk');
    assert.deepStrictEqual(slices[1].done, false, '#1736 table: S02 not done');
    assert.deepStrictEqual(slices[2].done, true, '#1736 table: S03 done');
});

  // ═══════════════════════════════════════════════════════════════════════
  // R. Regression #1736: Table format under ## Slice Overview
  // ═══════════════════════════════════════════════════════════════════════
test('R. #1736: Table format under ## Slice Overview', () => {
    const content = [
      '# M002: Overview Heading',
      '',
      '## Slice Overview',
      '',
      '| ID | Description | Risk | Done |',
      '|---|---|---|---|',
      '| S01 | Foundation | High | [x] |',
      '| S02 | API Layer | Medium | [ ] |',
      '',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, '#1736 overview: 2 slices');
    assert.deepStrictEqual(slices[0].done, true, '#1736 overview: S01 done');
    assert.deepStrictEqual(slices[1].done, false, '#1736 overview: S02 not done');
});

  // ═══════════════════════════════════════════════════════════════════════
  // S. Regression #1736: Table with Done/Complete text status
  // ═══════════════════════════════════════════════════════════════════════
test('S. #1736: Table with text status', () => {
    const content = [
      '# M003: Status Text',
      '',
      '## Slices',
      '',
      '| Slice | Title | Risk | Status |',
      '|---|---|---|---|',
      '| S01 | First | Low | Done |',
      '| S02 | Second | High | Pending |',
      '| S03 | Third | Medium | Completed |',
      '',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 3, '#1736 text status: 3 slices');
    assert.ok(slices[0].done, '#1736 text status: Done = true');
    assert.ok(!slices[1].done, '#1736 text status: Pending = false');
    assert.ok(slices[2].done, '#1736 text status: Completed = true');
});

  // ═══════════════════════════════════════════════════════════════════════
  // T. Regression #1736: Checkbox format still works after table support
  // ═══════════════════════════════════════════════════════════════════════
test('T. #1736: Checkbox format unchanged', () => {
    const content = [
      '# M005: Unchanged',
      '',
      '## Slices',
      '',
      '- [x] **S01: First** `risk:low` `depends:[]`',
      '  > After this: demo works.',
      '- [ ] **S02: Second** `risk:medium` `depends:[S01]`',
      '',
    ].join('\n');

    const slices = parseRoadmapSlices(content);
    assert.deepStrictEqual(slices.length, 2, '#1736 checkbox compat: 2 slices');
    assert.deepStrictEqual(slices[0].done, true, '#1736 checkbox compat: S01 done');
    assert.deepStrictEqual(slices[0].demo, 'demo works.', '#1736 checkbox compat: demo');
    assert.deepStrictEqual(slices[1].done, false, '#1736 checkbox compat: S02 not done');
});

});
