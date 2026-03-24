// Integration Edge Case Tests
//
// Three scenarios that only had per-module coverage before:
// 1. Empty project — no markdown files → migration finds nothing → queries return empty
// 2. Partial migration — DECISIONS.md exists but no REQUIREMENTS.md → no crash
// 3. Fallback mode — _resetProvider → queries degrade → re-open restores
//
// Uses real module imports (no mocks), file-backed DBs, temp directories.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase, isDbAvailable, _resetProvider } from '../gsd-db.ts';
import { migrateFromMarkdown } from '../md-importer.ts';
import {
  queryDecisions,
  queryRequirements,
  formatDecisionsForPrompt,
  formatRequirementsForPrompt,
} from '../context-store.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Fixture Helper ────────────────────────────────────────────────────────

function generateDecisionsMarkdown(count: number): string {
  const lines: string[] = [
    '# Decisions Register',
    '',
    '<!-- Append-only. Never edit or remove existing rows. -->',
    '',
    '| # | When | Scope | Decision | Choice | Rationale | Revisable? |',
    '|---|------|-------|----------|--------|-----------|------------|',
  ];

  for (let i = 1; i <= count; i++) {
    const id = `D${String(i).padStart(3, '0')}`;
    const milestone = i <= 3 ? 'M001' : 'M002';
    lines.push(`| ${id} | ${milestone}/S01 | testing | decision ${i} text | choice ${i} | rationale ${i} | yes |`);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// Edge Case 1: Empty Project
// ═══════════════════════════════════════════════════════════════════════════

test('integration-edge: empty project', () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-int-edge-empty-'));
  const gsdDir = join(base, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  const dbPath = join(gsdDir, 'test-edge-empty.db');

  try {
    // Open DB first so migrateFromMarkdown doesn't auto-create at default path
    openDatabase(dbPath);
    assert.ok(isDbAvailable(), 'empty: DB available after open');

    // Migrate with no markdown files on disk
    const result = migrateFromMarkdown(base);

    assert.deepStrictEqual(result.decisions, 0, 'empty: 0 decisions imported');
    assert.deepStrictEqual(result.requirements, 0, 'empty: 0 requirements imported');
    assert.deepStrictEqual(result.artifacts, 0, 'empty: 0 artifacts imported');

    // Query decisions → empty array
    const decisions = queryDecisions();
    assert.deepStrictEqual(decisions.length, 0, 'empty: queryDecisions returns empty array');

    // Query requirements → empty array
    const requirements = queryRequirements();
    assert.deepStrictEqual(requirements.length, 0, 'empty: queryRequirements returns empty array');

    // Query with scope filters → still empty, no crash
    const scopedDecisions = queryDecisions({ milestoneId: 'M001' });
    assert.deepStrictEqual(scopedDecisions.length, 0, 'empty: scoped queryDecisions returns empty');

    const scopedRequirements = queryRequirements({ sliceId: 'S01' });
    assert.deepStrictEqual(scopedRequirements.length, 0, 'empty: scoped queryRequirements returns empty');

    // Format empty results → empty strings
    const formattedD = formatDecisionsForPrompt([]);
    const formattedR = formatRequirementsForPrompt([]);
    assert.deepStrictEqual(formattedD, '', 'empty: formatDecisionsForPrompt returns empty string');
    assert.deepStrictEqual(formattedR, '', 'empty: formatRequirementsForPrompt returns empty string');

    // Format with actual empty query results
    const formattedD2 = formatDecisionsForPrompt(decisions);
    const formattedR2 = formatRequirementsForPrompt(requirements);
    assert.deepStrictEqual(formattedD2, '', 'empty: format of empty query decisions is empty string');
    assert.deepStrictEqual(formattedR2, '', 'empty: format of empty query requirements is empty string');

    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge Case 2: Partial Migration (decisions only, no requirements)
// ═══════════════════════════════════════════════════════════════════════════

test('integration-edge: partial migration', () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-int-edge-partial-'));
  const gsdDir = join(base, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  // Write DECISIONS.md but NOT REQUIREMENTS.md
  const decisionsMarkdown = generateDecisionsMarkdown(6);
  writeFileSync(join(gsdDir, 'DECISIONS.md'), decisionsMarkdown);

  const dbPath = join(gsdDir, 'test-edge-partial.db');

  try {
    openDatabase(dbPath);
    assert.ok(isDbAvailable(), 'partial: DB available after open');

    const result = migrateFromMarkdown(base);

    // Decisions imported, requirements skipped gracefully
    assert.ok(result.decisions === 6, `partial: imported ${result.decisions} decisions, expected 6`);
    assert.deepStrictEqual(result.requirements, 0, 'partial: 0 requirements imported (no file)');

    // Decisions queryable
    const decisions = queryDecisions();
    assert.ok(decisions.length === 6, `partial: queryDecisions returns 6 (got ${decisions.length})`);

    const m001Decisions = queryDecisions({ milestoneId: 'M001' });
    assert.ok(m001Decisions.length > 0, 'partial: M001 decisions non-empty');
    assert.ok(m001Decisions.length < decisions.length, 'partial: M001 scope filters correctly');

    // Requirements return empty — no crash
    const requirements = queryRequirements();
    assert.deepStrictEqual(requirements.length, 0, 'partial: queryRequirements returns empty');

    const scopedReqs = queryRequirements({ sliceId: 'S01' });
    assert.deepStrictEqual(scopedReqs.length, 0, 'partial: scoped queryRequirements returns empty');

    // Format works on partial data
    const formattedD = formatDecisionsForPrompt(m001Decisions);
    assert.ok(formattedD.length > 0, 'partial: formatted decisions non-empty');

    const formattedR = formatRequirementsForPrompt(requirements);
    assert.deepStrictEqual(formattedR, '', 'partial: formatted empty requirements is empty string');

    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge Case 3: Fallback Mode (_resetProvider)
// ═══════════════════════════════════════════════════════════════════════════

test('integration-edge: fallback mode', () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-int-edge-fallback-'));
  const gsdDir = join(base, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  const decisionsMarkdown = generateDecisionsMarkdown(4);
  writeFileSync(join(gsdDir, 'DECISIONS.md'), decisionsMarkdown);

  const dbPath = join(gsdDir, 'test-edge-fallback.db');

  try {
    // Step 1: Open DB normally and verify it works
    openDatabase(dbPath);
    assert.ok(isDbAvailable(), 'fallback: DB available after open');

    migrateFromMarkdown(base);
    const before = queryDecisions();
    assert.ok(before.length === 4, `fallback: 4 decisions before reset (got ${before.length})`);

    // Step 2: Close and reset provider → DB unavailable
    closeDatabase();
    _resetProvider();
    assert.ok(!isDbAvailable(), 'fallback: DB unavailable after _resetProvider');

    // Step 3: Queries degrade gracefully (return empty, don't throw)
    const degradedDecisions = queryDecisions();
    assert.deepStrictEqual(degradedDecisions.length, 0, 'fallback: queryDecisions returns empty when unavailable');

    const degradedRequirements = queryRequirements();
    assert.deepStrictEqual(degradedRequirements.length, 0, 'fallback: queryRequirements returns empty when unavailable');

    const degradedScopedD = queryDecisions({ milestoneId: 'M001' });
    assert.deepStrictEqual(degradedScopedD.length, 0, 'fallback: scoped queryDecisions returns empty when unavailable');

    const degradedScopedR = queryRequirements({ sliceId: 'S01' });
    assert.deepStrictEqual(degradedScopedR.length, 0, 'fallback: scoped queryRequirements returns empty when unavailable');

    // Format functions work on empty arrays (no crash)
    const formattedD = formatDecisionsForPrompt(degradedDecisions);
    assert.deepStrictEqual(formattedD, '', 'fallback: format degraded decisions is empty');

    const formattedR = formatRequirementsForPrompt(degradedRequirements);
    assert.deepStrictEqual(formattedR, '', 'fallback: format degraded requirements is empty');

    // Step 4: Re-open DB → restores availability
    openDatabase(dbPath);
    assert.ok(isDbAvailable(), 'fallback: DB available after re-open');

    // Data should be there from the file-backed DB (persisted by first open)
    // But rows may need re-import since the DB was freshly opened from the file
    migrateFromMarkdown(base);
    const restored = queryDecisions();
    assert.ok(restored.length === 4, `fallback: 4 decisions after re-open (got ${restored.length})`);

    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── Report ────────────────────────────────────────────────────────────────

