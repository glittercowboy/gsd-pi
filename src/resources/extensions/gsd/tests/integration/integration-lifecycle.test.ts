// Integration Lifecycle Test
//
// Proves full M001 subsystem composition end-to-end:
// realistic markdown on disk → migrateFromMarkdown → scoped DB queries →
// formatted prompt output → token savings validation → re-import after changes →
// structured tool write-back → DB consistency verification.
//
// Crosses ≥4 module boundaries: gsd-db, md-importer, context-store, db-writer.
// Uses file-backed DB (not :memory:) for WAL fidelity.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase, isDbAvailable, _getAdapter } from '../../gsd-db.ts';
import { migrateFromMarkdown, parseDecisionsTable } from '../../md-importer.ts';
import {
  queryDecisions,
  queryRequirements,
  formatDecisionsForPrompt,
  formatRequirementsForPrompt,
} from '../../context-store.ts';
import { saveDecisionToDb, generateDecisionsMd } from '../../db-writer.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Fixture Generators (duplicated from token-savings.test.ts — file-scoped) ──

function generateDecisionsMarkdown(count: number, milestones: string[]): string {
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
    const milestone = milestones[(i - 1) % milestones.length];
    const sliceNum = ((i - 1) % 5) + 1;
    const when = `${milestone}/S${String(sliceNum).padStart(2, '0')}`;
    const scope = ['architecture', 'testing', 'observability', 'security', 'performance'][(i - 1) % 5];
    const decision = `${scope} decision ${i}: implement ${scope}-level ${['caching', 'validation', 'retry logic', 'circuit breaker', 'rate limiting'][(i - 1) % 5]} for the ${['API layer', 'data pipeline', 'auth subsystem', 'notification service', 'background workers'][(i - 1) % 5]}`;
    const choice = `Use ${['SQLite', 'Redis', 'in-memory cache', 'exponential backoff', 'token bucket'][(i - 1) % 5]} with ${['WAL mode', 'cluster mode', 'LRU eviction', 'jitter', 'sliding window'][(i - 1) % 5]}`;
    const rationale = `${['Built-in Node.js support eliminates external dependency', 'Sub-millisecond latency meets P99 requirement', 'Memory-efficient with bounded growth prevents OOM', 'Prevents thundering herd during recovery', 'Protects downstream services from burst traffic'][(i - 1) % 5]}. Aligns with ${scope} principles for ${milestone}.`;
    const revisable = i % 3 === 0 ? 'no' : 'yes';

    lines.push(`| ${id} | ${when} | ${scope} | ${decision} | ${choice} | ${rationale} | ${revisable} |`);
  }

  return lines.join('\n');
}

function milestone_shorthand(index: number): string {
  return ['alpha', 'beta', 'GA'][index] ?? 'alpha';
}

function generateRequirementsMarkdown(count: number, sliceAssignments: { milestone: string; slice: string }[]): string {
  const lines: string[] = [
    '# Requirements',
    '',
    '## Active',
    '',
  ];

  for (let i = 1; i <= count; i++) {
    const id = `R${String(i).padStart(3, '0')}`;
    const assignment = sliceAssignments[(i - 1) % sliceAssignments.length];
    const reqClass = ['functional', 'non-functional', 'constraint', 'functional', 'non-functional'][(i - 1) % 5];
    const description = `${['Response latency', 'Data consistency', 'Error recovery', 'Access control', 'Audit logging', 'Cache invalidation', 'Schema migration'][(i - 1) % 7]} requirement for ${assignment.milestone}/${assignment.slice}`;
    const why = `Critical for ${['user experience', 'data integrity', 'system reliability', 'security compliance', 'regulatory requirements', 'operational visibility', 'deployment safety'][(i - 1) % 7]}. Without this, the system would ${['degrade under load', 'lose data during failures', 'fail to recover from crashes', 'expose unauthorized data', 'violate compliance mandates', 'have stale data issues', 'break during schema changes'][(i - 1) % 7]}.`;
    const source = `Architecture review ${milestone_shorthand((i - 1) % 3)}, stakeholder feedback round ${((i - 1) % 4) + 1}`;
    const primaryOwner = assignment.slice;
    const supportingSlices = sliceAssignments
      .filter(a => a.slice !== assignment.slice && a.milestone === assignment.milestone)
      .map(a => a.slice)
      .slice(0, 2)
      .join(', ');
    const validation = `${['Automated test suite covers all edge cases', 'Load test confirms P99 < 200ms under 1000 RPS', 'Chaos test proves recovery within 30s', 'Penetration test shows no unauthorized access paths', 'Audit log review confirms complete event capture', 'Integration test validates cache consistency', 'Migration test verifies zero-downtime upgrade'][(i - 1) % 7]}.`;
    const notes = `Tracked in JIRA-${100 + i}. See ADR-${((i - 1) % 5) + 1} for background.`;

    lines.push(`### ${id} — ${description}`);
    lines.push('');
    lines.push(`- Class: ${reqClass}`);
    lines.push(`- Status: active`);
    lines.push(`- Why it matters: ${why}`);
    lines.push(`- Source: ${source}`);
    lines.push(`- Primary owning slice: ${primaryOwner}`);
    if (supportingSlices) {
      lines.push(`- Supporting slices: ${supportingSlices}`);
    }
    lines.push(`- Validation: ${validation}`);
    lines.push(`- Notes: ${notes}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Fixture Constants ─────────────────────────────────────────────────────

const MILESTONES = ['M001', 'M002'];
const SLICE_ASSIGNMENTS = [
  { milestone: 'M001', slice: 'S01' },
  { milestone: 'M001', slice: 'S02' },
  { milestone: 'M001', slice: 'S03' },
  { milestone: 'M002', slice: 'S04' },
  { milestone: 'M002', slice: 'S05' },
];
const DECISIONS_COUNT = 14;
const REQUIREMENTS_COUNT = 12;

const ROADMAP_CONTENT = `# M001: Test Milestone\n\n**Vision:** Integration test milestone.\n\n## Slices\n\n- [ ] **S01: First Slice** \`risk:low\` \`depends:[]\`\n  > After this: Done.\n`;

// ═══════════════════════════════════════════════════════════════════════════
// Full Lifecycle Integration Test
// ═══════════════════════════════════════════════════════════════════════════

test('integration-lifecycle: full pipeline', async () => {
    // ── Step 1: Set up temp dir with realistic .gsd/ structure ──────────
    const base = mkdtempSync(join(tmpdir(), 'gsd-int-lifecycle-'));
    const gsdDir = join(base, '.gsd');
    mkdirSync(gsdDir, { recursive: true });
    mkdirSync(join(gsdDir, 'milestones', 'M001'), { recursive: true });
    mkdirSync(join(gsdDir, 'milestones', 'M002'), { recursive: true });

    const decisionsMarkdown = generateDecisionsMarkdown(DECISIONS_COUNT, MILESTONES);
    const requirementsMarkdown = generateRequirementsMarkdown(REQUIREMENTS_COUNT, SLICE_ASSIGNMENTS);

    writeFileSync(join(gsdDir, 'DECISIONS.md'), decisionsMarkdown);
    writeFileSync(join(gsdDir, 'REQUIREMENTS.md'), requirementsMarkdown);
    writeFileSync(join(gsdDir, 'milestones', 'M001', 'M001-ROADMAP.md'), ROADMAP_CONTENT);

    const dbPath = join(gsdDir, 'test-lifecycle.db');

    try {
      // ── Step 2: Open file-backed DB + migrateFromMarkdown ──────────────
      openDatabase(dbPath);
      assert.ok(isDbAvailable(), 'lifecycle: DB is available after open');

      const result = migrateFromMarkdown(base);

      assert.ok(result.decisions === DECISIONS_COUNT, `lifecycle: imported ${result.decisions} decisions, expected ${DECISIONS_COUNT}`);
      assert.ok(result.requirements === REQUIREMENTS_COUNT, `lifecycle: imported ${result.requirements} requirements, expected ${REQUIREMENTS_COUNT}`);
      assert.ok(result.artifacts >= 1, `lifecycle: imported at least 1 artifact (got ${result.artifacts})`);

      // Verify file-backed DB uses WAL
      const adapter = _getAdapter()!;
      const mode = adapter.prepare('PRAGMA journal_mode').get();
      assert.deepStrictEqual(mode?.['journal_mode'], 'wal', 'lifecycle: file-backed DB uses WAL mode');

      // ── Step 3: Scoped queries — decisions by milestone ────────────────
      const allDecisions = queryDecisions();
      const m001Decisions = queryDecisions({ milestoneId: 'M001' });
      const m002Decisions = queryDecisions({ milestoneId: 'M002' });

      assert.ok(allDecisions.length === DECISIONS_COUNT, `lifecycle: all decisions count = ${DECISIONS_COUNT} (got ${allDecisions.length})`);
      assert.ok(m001Decisions.length > 0, 'lifecycle: M001 decisions non-empty');
      assert.ok(m002Decisions.length > 0, 'lifecycle: M002 decisions non-empty');
      assert.ok(m001Decisions.length < allDecisions.length, 'lifecycle: M001 filtered count < total count');
      assert.ok(m002Decisions.length < allDecisions.length, 'lifecycle: M002 filtered count < total count');
      assert.deepStrictEqual(m001Decisions.length + m002Decisions.length, allDecisions.length, 'lifecycle: M001 + M002 = total decisions');

      // Verify scoping correctness
      for (const d of m001Decisions) {
        assert.ok(d.when_context.includes('M001'), `lifecycle: M001 decision ${d.id} has M001 in when_context`);
      }
      for (const d of m002Decisions) {
        assert.ok(d.when_context.includes('M002'), `lifecycle: M002 decision ${d.id} has M002 in when_context`);
      }

      // ── Step 4: Scoped queries — requirements by slice ─────────────────
      const allRequirements = queryRequirements();
      const s01Requirements = queryRequirements({ sliceId: 'S01' });
      const s04Requirements = queryRequirements({ sliceId: 'S04' });

      assert.ok(allRequirements.length === REQUIREMENTS_COUNT, `lifecycle: all requirements count = ${REQUIREMENTS_COUNT} (got ${allRequirements.length})`);
      assert.ok(s01Requirements.length > 0, 'lifecycle: S01 requirements non-empty');
      assert.ok(s04Requirements.length > 0, 'lifecycle: S04 requirements non-empty');
      assert.ok(s01Requirements.length < allRequirements.length, 'lifecycle: S01 filtered count < total count');

      // ── Step 5: Format + token savings validation ──────────────────────
      const formattedDecisions = formatDecisionsForPrompt(m001Decisions);
      const formattedRequirements = formatRequirementsForPrompt(s01Requirements);

      assert.ok(formattedDecisions.length > 0, 'lifecycle: formatted M001 decisions non-empty');
      assert.ok(formattedRequirements.length > 0, 'lifecycle: formatted S01 requirements non-empty');
      assert.match(formattedDecisions, /\| D/, 'lifecycle: formatted decisions contains decision rows');
      assert.match(formattedRequirements, /### R\d+/, 'lifecycle: formatted requirements has headings');

      // Token savings: scoped output vs full file content
      const fullDecisionsContent = readFileSync(join(gsdDir, 'DECISIONS.md'), 'utf-8');
      const fullRequirementsContent = readFileSync(join(gsdDir, 'REQUIREMENTS.md'), 'utf-8');
      const dbScopedTotal = formattedDecisions.length + formattedRequirements.length;
      const fullTotal = fullDecisionsContent.length + fullRequirementsContent.length;
      const savingsPercent = ((fullTotal - dbScopedTotal) / fullTotal) * 100;

      console.log(`  Token savings: ${savingsPercent.toFixed(1)}% (scoped: ${dbScopedTotal}, full: ${fullTotal})`);

      assert.ok(dbScopedTotal > 0, 'lifecycle: scoped content non-empty');
      assert.ok(dbScopedTotal < fullTotal, 'lifecycle: scoped content smaller than full content');
      assert.ok(savingsPercent >= 30, `lifecycle: savings ≥30% (actual: ${savingsPercent.toFixed(1)}%)`);

      // ── Step 6: Simulate content change → re-import ────────────────────
      const newDecisionRow = `| D${DECISIONS_COUNT + 1} | M001/S01 | testing | new decision added after initial import | choice X | rationale Y | yes |`;
      appendFileSync(join(gsdDir, 'DECISIONS.md'), '\n' + newDecisionRow + '\n');

      const result2 = migrateFromMarkdown(base);
      assert.ok(result2.decisions === DECISIONS_COUNT + 1, `lifecycle: re-import got ${result2.decisions} decisions, expected ${DECISIONS_COUNT + 1}`);

      const afterReimport = queryDecisions();
      assert.ok(afterReimport.length === DECISIONS_COUNT + 1, `lifecycle: DB has ${DECISIONS_COUNT + 1} decisions after re-import (got ${afterReimport.length})`);

      // Verify the new decision is queryable
      const newM001 = queryDecisions({ milestoneId: 'M001' });
      const foundNew = newM001.some(d => d.id === `D${DECISIONS_COUNT + 1}`);
      assert.ok(foundNew, `lifecycle: newly imported D${DECISIONS_COUNT + 1} found in M001 scope`);

      // ── Step 7: saveDecisionToDb write-back + round-trip ───────────────
      const saved = await saveDecisionToDb(
        {
          scope: 'M001/S01',
          decision: 'integration test write-back decision',
          choice: 'option Z',
          rationale: 'proves round-trip fidelity',
          when_context: 'M001/S01',
        },
        base,
      );

      assert.ok(typeof saved.id === 'string', 'lifecycle: saveDecisionToDb returned an id');
      assert.match(saved.id, /^D\d+$/, 'lifecycle: saved ID matches D### pattern');

      // Query back from DB
      const allAfterSave = queryDecisions();
      const savedDecision = allAfterSave.find(d => d.id === saved.id);
      assert.ok(savedDecision !== null && savedDecision !== undefined, `lifecycle: saved decision ${saved.id} found in DB`);
      assert.deepStrictEqual(savedDecision?.decision, 'integration test write-back decision', 'lifecycle: saved decision text matches');
      assert.deepStrictEqual(savedDecision?.choice, 'option Z', 'lifecycle: saved choice matches');

      // Verify DECISIONS.md was regenerated with the new decision
      const regeneratedMd = readFileSync(join(gsdDir, 'DECISIONS.md'), 'utf-8');
      assert.ok(regeneratedMd.includes(saved.id), `lifecycle: regenerated DECISIONS.md contains ${saved.id}`);
      assert.ok(regeneratedMd.includes('integration test write-back decision'), 'lifecycle: regenerated md contains write-back text');

      // Round-trip: parse regenerated markdown back → verify field fidelity
      const reparsed = parseDecisionsTable(regeneratedMd);
      const reparsedSaved = reparsed.find(d => d.id === saved.id);
      assert.ok(reparsedSaved !== undefined, `lifecycle: reparsed markdown contains ${saved.id}`);
      assert.deepStrictEqual(reparsedSaved?.choice, 'option Z', 'lifecycle: round-trip choice preserved');
      assert.deepStrictEqual(reparsedSaved?.rationale, 'proves round-trip fidelity', 'lifecycle: round-trip rationale preserved');

      // ── Step 8: DB consistency — total count sanity ─────────────────────
      const finalCount = queryDecisions().length;
      // Original 14 + 1 re-import + 1 saveDecisionToDb = 16
      assert.ok(finalCount === DECISIONS_COUNT + 2, `lifecycle: final DB count = ${DECISIONS_COUNT + 2} (got ${finalCount})`);

      closeDatabase();
    } finally {
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    }
});

