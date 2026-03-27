// Token Savings Validation Test
//
// Proves ≥30% character savings when using DB-scoped content vs full-markdown
// for planning/research prompt types. Uses realistic fixture data:
// 24 decisions across 3 milestones, 21 requirements across 5 slices in 2 milestones.
//
// Retires R016 (≥30% savings target) and provides evidence for R019 (no quality regression).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase } from '../../gsd-db.ts';
import { migrateFromMarkdown } from '../../md-importer.ts';
import {
  queryDecisions,
  queryRequirements,
  formatDecisionsForPrompt,
  formatRequirementsForPrompt,
} from '../../context-store.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';


// ─── Fixture Generators ────────────────────────────────────────────────────

/**
 * Generate a realistic DECISIONS.md with `count` decisions spread across milestones.
 * Each decision has realistic-length text in each column to produce meaningful size.
 */
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
    const choice = `Use ${['SQLite', 'Redis', 'in-memory cache', 'exponential backoff', 'token bucket'][(i - 1) % 5]} with ${['WAL mode', 'cluster mode', 'LRU eviction', 'jitter', 'sliding window'][(i - 1) % 5]} configuration for optimal ${scope} characteristics`;
    const rationale = `${['Built-in Node.js support eliminates external dependency', 'Sub-millisecond latency meets P99 requirement', 'Memory-efficient with bounded growth prevents OOM', 'Prevents thundering herd during recovery', 'Protects downstream services from burst traffic'][(i - 1) % 5]}. This aligns with our ${scope} principles established in the architecture review and satisfies the non-functional requirements for the ${milestone} milestone.`;
    const revisable = i % 3 === 0 ? 'no' : 'yes';

    lines.push(`| ${id} | ${when} | ${scope} | ${decision} | ${choice} | ${rationale} | ${revisable} |`);
  }

  return lines.join('\n');
}

/**
 * Generate a realistic REQUIREMENTS.md with `count` requirements spread across slices.
 * Each requirement has multiple detailed fields producing meaningful character content.
 */
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
    const why = `Critical for ${['user experience', 'data integrity', 'system reliability', 'security compliance', 'regulatory requirements', 'operational visibility', 'deployment safety'][(i - 1) % 7]}. Without this, the system would ${['degrade under load', 'lose data during failures', 'fail to recover from crashes', 'expose unauthorized data', 'violate compliance mandates', 'have stale data issues', 'break during schema changes'][(i - 1) % 7]}, which is unacceptable for production readiness.`;
    const source = `Architecture review ${milestone_shorthand((i - 1) % 3)}, stakeholder feedback round ${((i - 1) % 4) + 1}`;
    const primaryOwner = assignment.slice;
    const supportingSlices = sliceAssignments
      .filter(a => a.slice !== assignment.slice && a.milestone === assignment.milestone)
      .map(a => a.slice)
      .slice(0, 2)
      .join(', ');
    const validation = `${['Automated test suite covers all edge cases', 'Load test confirms P99 < 200ms under 1000 RPS', 'Chaos test proves recovery within 30s', 'Penetration test shows no unauthorized access paths', 'Audit log review confirms complete event capture', 'Integration test validates cache consistency', 'Migration test verifies zero-downtime upgrade'][(i - 1) % 7]}. Additionally, manual review by ${['architecture team', 'security team', 'SRE team', 'product owner', 'tech lead'][(i - 1) % 5]} confirms adherence to standards.`;
    const notes = `Tracked in ${['JIRA-123', 'JIRA-456', 'JIRA-789', 'JIRA-012', 'JIRA-345'][(i - 1) % 5]}. See also ${['ADR-001', 'ADR-002', 'ADR-003', 'ADR-004', 'ADR-005'][(i - 1) % 5]} for background context on this requirement domain.`;

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

function milestone_shorthand(index: number): string {
  return ['alpha', 'beta', 'GA'][index] ?? 'alpha';
}

// ─── Fixture Setup ─────────────────────────────────────────────────────────

const MILESTONES = ['M001', 'M002', 'M003'];

// Slice assignments: 5 slices spread across M001 and M002
const SLICE_ASSIGNMENTS = [
  { milestone: 'M001', slice: 'S01' },
  { milestone: 'M001', slice: 'S02' },
  { milestone: 'M001', slice: 'S03' },
  { milestone: 'M002', slice: 'S04' },
  { milestone: 'M002', slice: 'S05' },
];

const DECISIONS_COUNT = 24;
const REQUIREMENTS_COUNT = 21;

const decisionsMarkdown = generateDecisionsMarkdown(DECISIONS_COUNT, MILESTONES);
const requirementsMarkdown = generateRequirementsMarkdown(REQUIREMENTS_COUNT, SLICE_ASSIGNMENTS);

const PROJECT_CONTENT = `# Test Project

A test project for validating token savings with DB-scoped content.

## Goals
- Validate ≥30% character savings on planning prompts
- Ensure quality of scoped content (correct items, no cross-contamination)

## Architecture
- SQLite-backed artifact storage with markdown import
- Milestone/slice-scoped queries for prompt injection
- Fallback to full markdown when DB unavailable
`;

// ═══════════════════════════════════════════════════════════════════════════
// Test: Plan-slice savings (≥30%)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== token-savings: plan-slice prompt ≥30% character savings ===');
{
  const base = mkdtempSync(join(tmpdir(), 'gsd-token-savings-'));
  mkdirSync(join(base, '.gsd'), { recursive: true });
  writeFileSync(join(base, '.gsd', 'DECISIONS.md'), decisionsMarkdown);
  writeFileSync(join(base, '.gsd', 'REQUIREMENTS.md'), requirementsMarkdown);
  writeFileSync(join(base, '.gsd', 'PROJECT.md'), PROJECT_CONTENT);

  // Open :memory: DB and import
  openDatabase(':memory:');
  const result = migrateFromMarkdown(base);

  assert.ok(result.decisions === DECISIONS_COUNT, `imported ${result.decisions} decisions, expected ${DECISIONS_COUNT}`);
  assert.ok(result.requirements === REQUIREMENTS_COUNT, `imported ${result.requirements} requirements, expected ${REQUIREMENTS_COUNT}`);

  // ── DB-scoped content for plan-slice (M001 decisions + S01 requirements) ──
  const scopedDecisions = queryDecisions({ milestoneId: 'M001' });
  const scopedRequirements = queryRequirements({ sliceId: 'S01' });
  const dbDecisionsContent = formatDecisionsForPrompt(scopedDecisions);
  const dbRequirementsContent = formatRequirementsForPrompt(scopedRequirements);

  // ── Full-markdown equivalents (what inlineGsdRootFile would return) ──
  const fullDecisionsContent = readFileSync(join(base, '.gsd', 'DECISIONS.md'), 'utf-8');
  const fullRequirementsContent = readFileSync(join(base, '.gsd', 'REQUIREMENTS.md'), 'utf-8');

  // DB-scoped total vs full-markdown total
  const dbTotal = dbDecisionsContent.length + dbRequirementsContent.length;
  const fullTotal = fullDecisionsContent.length + fullRequirementsContent.length;

  const savingsPercent = ((fullTotal - dbTotal) / fullTotal) * 100;
  console.log(`  Plan-slice savings: ${savingsPercent.toFixed(1)}% (DB: ${dbTotal} chars, full: ${fullTotal} chars)`);

  assert.ok(dbTotal > 0, 'DB-scoped content is non-empty');
  assert.ok(dbDecisionsContent.length > 0, 'DB-scoped decisions content is non-empty');
  assert.ok(dbRequirementsContent.length > 0, 'DB-scoped requirements content is non-empty');
  assert.ok(savingsPercent >= 30, `plan-slice savings ≥30% (actual: ${savingsPercent.toFixed(1)}%)`);
  assert.ok(dbTotal < fullTotal * 0.70, `DB total (${dbTotal}) < 70% of full total (${fullTotal})`);

  // ── Verify correct scoping: decisions ──
  // M001 decisions: those with when_context containing 'M001' — indices 1,4,7,10,13,16,19,22
  // (24 decisions round-robin across M001/M002/M003 → 8 for M001)
  assert.ok(scopedDecisions.length === 8, `M001 decisions: expected 8, got ${scopedDecisions.length}`);
  for (const d of scopedDecisions) {
    assert.ok(d.when_context.includes('M001'), `decision ${d.id} should have M001 in when_context, got "${d.when_context}"`);
  }

  // Verify NO decisions from other milestones leak in
  for (const d of scopedDecisions) {
    assert.doesNotMatch(d.when_context, /M002|M003/, `decision ${d.id} should not contain M002 or M003`);
  }

  // ── Verify correct scoping: requirements ──
  // S01 requirements: those assigned to S01 as primary_owner
  // S01 appears in positions 1,6,11,16,21 (5 assignments cycling, 21 reqs → indices 0,5,10,15,20)
  assert.ok(scopedRequirements.length > 0, 'S01 requirements non-empty');
  for (const r of scopedRequirements) {
    assert.ok(
      r.primary_owner.includes('S01') || r.supporting_slices.includes('S01'),
      `requirement ${r.id} should be owned by or support S01`,
    );
  }

  // Verify specific expected IDs are present
  const scopedDecisionIds = scopedDecisions.map(d => d.id);
  assert.ok(scopedDecisionIds.includes('D001'), 'M001 scoped decisions includes D001');
  assert.ok(scopedDecisionIds.includes('D004'), 'M001 scoped decisions includes D004');
  assert.ok(!scopedDecisionIds.includes('D002'), 'M001 scoped decisions excludes D002 (M002)');
  assert.ok(!scopedDecisionIds.includes('D003'), 'M001 scoped decisions excludes D003 (M003)');

  const scopedReqIds = scopedRequirements.map(r => r.id);
  assert.ok(scopedReqIds.includes('R001'), 'S01 scoped requirements includes R001');

  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Research-milestone savings
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== token-savings: research-milestone prompt shows meaningful savings ===');
{
  const base = mkdtempSync(join(tmpdir(), 'gsd-token-savings-'));
  mkdirSync(join(base, '.gsd'), { recursive: true });
  writeFileSync(join(base, '.gsd', 'DECISIONS.md'), decisionsMarkdown);
  writeFileSync(join(base, '.gsd', 'REQUIREMENTS.md'), requirementsMarkdown);
  writeFileSync(join(base, '.gsd', 'PROJECT.md'), PROJECT_CONTENT);

  openDatabase(':memory:');
  migrateFromMarkdown(base);

  // ── Research-milestone: M001 decisions + ALL requirements ──
  const scopedDecisions = queryDecisions({ milestoneId: 'M001' });
  const allRequirements = queryRequirements(); // no filter — all requirements
  const dbDecisionsContent = formatDecisionsForPrompt(scopedDecisions);
  const dbRequirementsContent = formatRequirementsForPrompt(allRequirements);

  const fullDecisionsContent = readFileSync(join(base, '.gsd', 'DECISIONS.md'), 'utf-8');
  const fullRequirementsContent = readFileSync(join(base, '.gsd', 'REQUIREMENTS.md'), 'utf-8');

  // Decisions should still show savings (8 of 24 scoped to M001)
  const decisionsSavings = ((fullDecisionsContent.length - dbDecisionsContent.length) / fullDecisionsContent.length) * 100;
  console.log(`  Decisions savings (M001): ${decisionsSavings.toFixed(1)}% (DB: ${dbDecisionsContent.length}, full: ${fullDecisionsContent.length})`);

  assert.ok(decisionsSavings > 0, `decisions savings > 0% (actual: ${decisionsSavings.toFixed(1)}%)`);
  assert.ok(scopedDecisions.length === 8, `M001 decisions: 8 of 24 total`);
  assert.ok(allRequirements.length === REQUIREMENTS_COUNT, `all requirements returned: ${allRequirements.length}`);

  // Requirements: DB-formatted vs raw markdown — formatted output may differ in size
  // but decisions savings alone should make the composite meaningful
  const dbTotal = dbDecisionsContent.length + dbRequirementsContent.length;
  const fullTotal = fullDecisionsContent.length + fullRequirementsContent.length;
  const compositeSavings = ((fullTotal - dbTotal) / fullTotal) * 100;
  console.log(`  Research-milestone composite savings: ${compositeSavings.toFixed(1)}% (DB: ${dbTotal}, full: ${fullTotal})`);

  // With 8/24 decisions = 66% reduction in decisions, even if requirements are equal,
  // the composite should show meaningful savings
  assert.ok(compositeSavings > 10, `research-milestone shows >10% composite savings (actual: ${compositeSavings.toFixed(1)}%)`);
  assert.ok(decisionsSavings >= 30, `decisions-only savings ≥30% for M001 scope (actual: ${decisionsSavings.toFixed(1)}%)`);

  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Quality — correct content, no cross-contamination
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== token-savings: quality — correct scoping, no cross-contamination ===');
{
  const base = mkdtempSync(join(tmpdir(), 'gsd-token-savings-'));
  mkdirSync(join(base, '.gsd'), { recursive: true });
  writeFileSync(join(base, '.gsd', 'DECISIONS.md'), decisionsMarkdown);
  writeFileSync(join(base, '.gsd', 'REQUIREMENTS.md'), requirementsMarkdown);
  writeFileSync(join(base, '.gsd', 'PROJECT.md'), PROJECT_CONTENT);

  openDatabase(':memory:');
  migrateFromMarkdown(base);

  // ── M002-scoped decisions should not contain M001/M003 items ──
  const m002Decisions = queryDecisions({ milestoneId: 'M002' });
  assert.ok(m002Decisions.length === 8, `M002 decisions: expected 8, got ${m002Decisions.length}`);
  for (const d of m002Decisions) {
    assert.ok(d.when_context.includes('M002'), `M002 decision ${d.id} has M002 in when_context`);
    assert.doesNotMatch(d.when_context, /M001|M003/, `M002 decision ${d.id} should not contain M001/M003`);
  }

  // ── S04-scoped requirements should only include S04-related items ──
  const s04Requirements = queryRequirements({ sliceId: 'S04' });
  assert.ok(s04Requirements.length > 0, 'S04 requirements non-empty');
  for (const r of s04Requirements) {
    assert.ok(
      r.primary_owner.includes('S04') || r.supporting_slices.includes('S04'),
      `S04 requirement ${r.id} should be owned by or support S04`,
    );
  }

  // ── Verify formatted output is well-formed and non-empty ──
  const formattedDecisions = formatDecisionsForPrompt(m002Decisions);
  assert.ok(formattedDecisions.length > 0, 'formatted M002 decisions is non-empty');
  assert.match(formattedDecisions, /\| D/, 'formatted decisions contains decision rows');
  assert.match(formattedDecisions, /\| # \|/, 'formatted decisions has table header');

  const formattedReqs = formatRequirementsForPrompt(s04Requirements);
  assert.ok(formattedReqs.length > 0, 'formatted S04 requirements is non-empty');
  assert.match(formattedReqs, /### R\d+/, 'formatted requirements has requirement headings');

  // ── Verify all milestones have decisions and counts add up ──
  const m001Count = queryDecisions({ milestoneId: 'M001' }).length;
  const m002Count = queryDecisions({ milestoneId: 'M002' }).length;
  const m003Count = queryDecisions({ milestoneId: 'M003' }).length;
  const allCount = queryDecisions().length;

  assert.ok(m001Count === 8, `M001: 8 decisions (got ${m001Count})`);
  assert.ok(m002Count === 8, `M002: 8 decisions (got ${m002Count})`);
  assert.ok(m003Count === 8, `M003: 8 decisions (got ${m003Count})`);
  assert.ok(allCount === DECISIONS_COUNT, `all: ${DECISIONS_COUNT} decisions (got ${allCount})`);
  assert.ok(m001Count + m002Count + m003Count === allCount, 'milestone decision counts sum to total');

  // ── Verify all slices have requirements ──
  const s01Reqs = queryRequirements({ sliceId: 'S01' });
  const s02Reqs = queryRequirements({ sliceId: 'S02' });
  const s03Reqs = queryRequirements({ sliceId: 'S03' });
  const s04Reqs = queryRequirements({ sliceId: 'S04' });
  const s05Reqs = queryRequirements({ sliceId: 'S05' });

  assert.ok(s01Reqs.length > 0, 'S01 has requirements');
  assert.ok(s02Reqs.length > 0, 'S02 has requirements');
  assert.ok(s03Reqs.length > 0, 'S03 has requirements');
  assert.ok(s04Reqs.length > 0, 'S04 has requirements');
  assert.ok(s05Reqs.length > 0, 'S05 has requirements');

  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Fixture data realism — sufficient volume and distribution
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== token-savings: fixture data realism ===');
{
  // Verify fixture generators produce sufficient volume
  assert.ok(DECISIONS_COUNT >= 20, `decisions count ≥ 20 (actual: ${DECISIONS_COUNT})`);
  assert.ok(REQUIREMENTS_COUNT >= 20, `requirements count ≥ 20 (actual: ${REQUIREMENTS_COUNT})`);
  assert.ok(MILESTONES.length >= 3, `milestones ≥ 3 (actual: ${MILESTONES.length})`);
  assert.ok(SLICE_ASSIGNMENTS.length >= 5, `slice assignments ≥ 5 (actual: ${SLICE_ASSIGNMENTS.length})`);

  // Verify markdown content is substantial
  assert.ok(decisionsMarkdown.length > 1000, `decisions markdown > 1000 chars (actual: ${decisionsMarkdown.length})`);
  assert.ok(requirementsMarkdown.length > 1000, `requirements markdown > 1000 chars (actual: ${requirementsMarkdown.length})`);

  // Verify content structure
  assert.match(decisionsMarkdown, /\| D001 \|/, 'decisions markdown has D001');
  assert.match(decisionsMarkdown, /\| D024 \|/, 'decisions markdown has D024');
  assert.match(requirementsMarkdown, /### R001/, 'requirements markdown has R001');
  assert.match(requirementsMarkdown, /### R021/, 'requirements markdown has R021');
}

// ─── Report ────────────────────────────────────────────────────────────────
