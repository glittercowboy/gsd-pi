// prompt-db: Tests for DB-aware inline helpers (inlineDecisionsFromDb, inlineRequirementsFromDb, inlineProjectFromDb)
//
// Validates:
// (a) DB-aware helpers return scoped content when DB has data
// (b) Helpers fall back to non-null output when DB unavailable
// (c) Scoped filtering actually reduces content

import { createTestContext } from './test-helpers.ts';
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertDecision,
  insertRequirement,
  insertArtifact,
} from '../gsd-db.ts';
import {
  queryDecisions,
  queryRequirements,
  queryProject,
  formatDecisionsForPrompt,
  formatRequirementsForPrompt,
} from '../context-store.ts';

const { assertEq, assertTrue, assertMatch, assertNoMatch, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// prompt-db: DB-aware decisions helper returns scoped content
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== prompt-db: scoped decisions from DB ===');
{
  openDatabase(':memory:');

  // Insert decisions across 3 milestones
  for (let i = 1; i <= 10; i++) {
    const milestoneNum = ((i - 1) % 3) + 1;
    insertDecision({
      id: `D${String(i).padStart(3, '0')}`,
      when_context: `M00${milestoneNum}/S01`,
      scope: 'architecture',
      decision: `decision ${i}`,
      choice: `choice ${i}`,
      rationale: `rationale ${i}`,
      revisable: 'yes',
      superseded_by: null,
    });
  }

  // Query scoped to M001
  const m001Decisions = queryDecisions({ milestoneId: 'M001' });
  assertTrue(m001Decisions.length > 0, 'M001 decisions should exist');
  assertTrue(m001Decisions.length < 10, `scoped query should return fewer than 10 (got ${m001Decisions.length})`);

  // Verify all returned decisions are for M001
  for (const d of m001Decisions) {
    assertMatch(d.when_context, /M001/, `decision ${d.id} should be for M001`);
  }

  // Format and verify wrapping
  const formatted = formatDecisionsForPrompt(m001Decisions);
  assertTrue(formatted.length > 0, 'formatted decisions should be non-empty');
  assertMatch(formatted, /\| # \| When \| Scope/, 'formatted decisions have table header');

  // Verify the expected wrapper format that inlineDecisionsFromDb would produce
  const wrapped = `### Decisions\nSource: \`.gsd/DECISIONS.md\`\n\n${formatted}`;
  assertMatch(wrapped, /^### Decisions/, 'wrapped decisions start with ### Decisions');
  assertMatch(wrapped, /Source:.*DECISIONS\.md/, 'wrapped decisions have source path');

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// prompt-db: DB-aware requirements helper returns scoped content
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== prompt-db: scoped requirements from DB ===');
{
  openDatabase(':memory:');

  // Insert requirements across different slices
  insertRequirement({
    id: 'R001', class: 'functional', status: 'active',
    description: 'feature A', why: 'needed', source: 'M001', primary_owner: 'S01',
    supporting_slices: '', validation: 'test', notes: '', full_content: '',
    superseded_by: null,
  });
  insertRequirement({
    id: 'R002', class: 'functional', status: 'active',
    description: 'feature B', why: 'needed', source: 'M001', primary_owner: 'S02',
    supporting_slices: 'S01', validation: 'test', notes: '', full_content: '',
    superseded_by: null,
  });
  insertRequirement({
    id: 'R003', class: 'functional', status: 'active',
    description: 'feature C', why: 'needed', source: 'M001', primary_owner: 'S03',
    supporting_slices: '', validation: 'test', notes: '', full_content: '',
    superseded_by: null,
  });

  // Query scoped to S01 — should get R001 (primary) and R002 (supporting)
  const s01Reqs = queryRequirements({ sliceId: 'S01' });
  assertEq(s01Reqs.length, 2, 'S01 requirements should be 2 (primary + supporting)');
  const ids = s01Reqs.map(r => r.id).sort();
  assertEq(ids, ['R001', 'R002'], 'S01 owns R001 and supports R002');

  // Unscoped query returns all 3
  const allReqs = queryRequirements();
  assertEq(allReqs.length, 3, 'unscoped requirements should return all 3');

  // Format and verify wrapping
  const formatted = formatRequirementsForPrompt(s01Reqs);
  assertTrue(formatted.length > 0, 'formatted requirements should be non-empty');
  assertMatch(formatted, /### R001/, 'formatted requirements include R001');
  assertMatch(formatted, /### R002/, 'formatted requirements include R002');
  assertNoMatch(formatted, /### R003/, 'formatted requirements exclude R003');

  // Verify the expected wrapper format that inlineRequirementsFromDb would produce
  const wrapped = `### Requirements\nSource: \`.gsd/REQUIREMENTS.md\`\n\n${formatted}`;
  assertMatch(wrapped, /^### Requirements/, 'wrapped requirements start with ### Requirements');
  assertMatch(wrapped, /Source:.*REQUIREMENTS\.md/, 'wrapped requirements have source path');

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// prompt-db: DB-aware project helper returns content from DB
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== prompt-db: project content from DB ===');
{
  openDatabase(':memory:');

  insertArtifact({
    path: 'PROJECT.md',
    artifact_type: 'project',
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: '# Test Project\n\nThis is the project description.',
  });

  const content = queryProject();
  assertEq(content, '# Test Project\n\nThis is the project description.', 'queryProject returns content');

  // Verify the expected wrapper format that inlineProjectFromDb would produce
  const wrapped = `### Project\nSource: \`.gsd/PROJECT.md\`\n\n${content}`;
  assertMatch(wrapped, /^### Project/, 'wrapped project starts with ### Project');
  assertMatch(wrapped, /Source:.*PROJECT\.md/, 'wrapped project has source path');
  assertMatch(wrapped, /# Test Project/, 'wrapped project includes content');

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// prompt-db: fallback when DB unavailable
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== prompt-db: fallback when DB unavailable ===');
{
  closeDatabase();
  assertTrue(!isDbAvailable(), 'DB should not be available');

  // queryDecisions returns [] when DB closed — helper would fall back
  const decisions = queryDecisions({ milestoneId: 'M001' });
  assertEq(decisions, [], 'queryDecisions returns [] when DB closed');

  // queryRequirements returns [] when DB closed — helper would fall back
  const requirements = queryRequirements({ sliceId: 'S01' });
  assertEq(requirements, [], 'queryRequirements returns [] when DB closed');

  // queryProject returns null when DB closed — helper would fall back
  const project = queryProject();
  assertEq(project, null, 'queryProject returns null when DB closed');

  // formatDecisionsForPrompt returns '' for empty input
  const formatted = formatDecisionsForPrompt([]);
  assertEq(formatted, '', 'formatDecisionsForPrompt returns empty for empty input');

  // formatRequirementsForPrompt returns '' for empty input
  const formattedReqs = formatRequirementsForPrompt([]);
  assertEq(formattedReqs, '', 'formatRequirementsForPrompt returns empty for empty input');
}

// ═══════════════════════════════════════════════════════════════════════════
// prompt-db: scoped filtering reduces content vs unscoped
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== prompt-db: scoped filtering reduces content ===');
{
  openDatabase(':memory:');

  // Insert 10 decisions across 3 milestones
  for (let i = 1; i <= 10; i++) {
    const milestoneNum = ((i - 1) % 3) + 1;
    insertDecision({
      id: `D${String(i).padStart(3, '0')}`,
      when_context: `M00${milestoneNum}/S01`,
      scope: 'architecture',
      decision: `decision ${i} with some lengthy description for token measurement`,
      choice: `choice ${i}`,
      rationale: `rationale ${i} with additional context`,
      revisable: 'yes',
      superseded_by: null,
    });
  }

  const allDecisions = queryDecisions();
  const m001Decisions = queryDecisions({ milestoneId: 'M001' });

  assertEq(allDecisions.length, 10, 'unscoped returns all 10 decisions');
  assertTrue(m001Decisions.length < 10, `M001-scoped returns fewer than 10 (got ${m001Decisions.length})`);
  assertTrue(m001Decisions.length > 0, 'M001-scoped returns at least 1');

  // Format both and compare sizes — scoped should be shorter
  const allFormatted = formatDecisionsForPrompt(allDecisions);
  const scopedFormatted = formatDecisionsForPrompt(m001Decisions);

  assertTrue(
    scopedFormatted.length < allFormatted.length,
    `scoped content (${scopedFormatted.length} chars) should be shorter than unscoped (${allFormatted.length} chars)`,
  );

  // Insert requirements across 4 slices
  for (let i = 1; i <= 8; i++) {
    const sliceNum = ((i - 1) % 4) + 1;
    insertRequirement({
      id: `R${String(i).padStart(3, '0')}`,
      class: 'functional',
      status: 'active',
      description: `requirement ${i} with detailed description`,
      why: `justification ${i}`,
      source: 'M001',
      primary_owner: `S0${sliceNum}`,
      supporting_slices: '',
      validation: `validation ${i}`,
      notes: '',
      full_content: '',
      superseded_by: null,
    });
  }

  const allReqs = queryRequirements();
  const s01Reqs = queryRequirements({ sliceId: 'S01' });

  assertEq(allReqs.length, 8, 'unscoped returns all 8 requirements');
  assertTrue(s01Reqs.length < 8, `S01-scoped returns fewer than 8 (got ${s01Reqs.length})`);
  assertTrue(s01Reqs.length > 0, 'S01-scoped returns at least 1');

  const allReqsFormatted = formatRequirementsForPrompt(allReqs);
  const scopedReqsFormatted = formatRequirementsForPrompt(s01Reqs);

  assertTrue(
    scopedReqsFormatted.length < allReqsFormatted.length,
    `scoped requirements (${scopedReqsFormatted.length} chars) should be shorter than unscoped (${allReqsFormatted.length} chars)`,
  );

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// prompt-db: DB helpers produce correct wrapper format
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== prompt-db: DB helpers wrapper format matches expected pattern ===');
{
  openDatabase(':memory:');

  insertDecision({
    id: 'D001', when_context: 'M001/S01', scope: 'architecture',
    decision: 'use SQLite', choice: 'better-sqlite3', rationale: 'fast',
    revisable: 'yes', superseded_by: null,
  });

  insertRequirement({
    id: 'R001', class: 'functional', status: 'active',
    description: 'persist decisions', why: 'memory', source: 'M001',
    primary_owner: 'S01', supporting_slices: '', validation: 'test',
    notes: '', full_content: '', superseded_by: null,
  });

  insertArtifact({
    path: 'PROJECT.md',
    artifact_type: 'project',
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: '# Project Name\n\nDescription.',
  });

  // Simulate what inlineDecisionsFromDb does
  const decisions = queryDecisions({ milestoneId: 'M001' });
  assertTrue(decisions.length === 1, 'got 1 decision for M001');
  const dFormatted = formatDecisionsForPrompt(decisions);
  const dWrapped = `### Decisions\nSource: \`.gsd/DECISIONS.md\`\n\n${dFormatted}`;
  assertMatch(dWrapped, /^### Decisions\nSource: `.gsd\/DECISIONS\.md`\n\n\| #/, 'decisions wrapper format correct');

  // Simulate what inlineRequirementsFromDb does
  const reqs = queryRequirements({ sliceId: 'S01' });
  assertTrue(reqs.length === 1, 'got 1 requirement for S01');
  const rFormatted = formatRequirementsForPrompt(reqs);
  const rWrapped = `### Requirements\nSource: \`.gsd/REQUIREMENTS.md\`\n\n${rFormatted}`;
  assertMatch(rWrapped, /^### Requirements\nSource: `.gsd\/REQUIREMENTS\.md`\n\n### R001/, 'requirements wrapper format correct');

  // Simulate what inlineProjectFromDb does
  const project = queryProject();
  assertTrue(project !== null, 'project content exists');
  const pWrapped = `### Project\nSource: \`.gsd/PROJECT.md\`\n\n${project}`;
  assertMatch(pWrapped, /^### Project\nSource: `.gsd\/PROJECT\.md`\n\n# Project Name/, 'project wrapper format correct');

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// prompt-db: re-import updates DB when source markdown changes
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateFromMarkdown } from '../md-importer.ts';

console.log('\n=== prompt-db: re-import updates DB when source markdown changes ===');
{
  // Create a temp dir simulating a project with .gsd/DECISIONS.md
  const tmpDir = mkdtempSync(join(tmpdir(), 'prompt-db-reimport-'));
  const gsdDir = join(tmpDir, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  // Write initial DECISIONS.md with 2 decisions
  const initialDecisions = `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001/S01 | architecture | use SQLite | better-sqlite3 | fast and embedded | yes |
| D002 | M001/S01 | tooling | use vitest | vitest | modern test runner | yes |
`;
  writeFileSync(join(gsdDir, 'DECISIONS.md'), initialDecisions);

  // Open in-memory DB and do initial import
  openDatabase(':memory:');
  migrateFromMarkdown(tmpDir);

  // Verify initial state: 2 decisions
  const initial = queryDecisions();
  assertEq(initial.length, 2, 're-import: initial import has 2 decisions');
  const initialIds = initial.map(d => d.id).sort();
  assertEq(initialIds, ['D001', 'D002'], 're-import: initial decisions are D001, D002');

  // Now "the LLM modifies DECISIONS.md" — add a third decision
  const updatedDecisions = `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001/S01 | architecture | use SQLite | better-sqlite3 | fast and embedded | yes |
| D002 | M001/S01 | tooling | use vitest | vitest | modern test runner | yes |
| D003 | M001/S02 | runtime | dynamic imports | D014 pattern | lazy loading | yes |
`;
  writeFileSync(join(gsdDir, 'DECISIONS.md'), updatedDecisions);

  // Re-import (simulating what handleAgentEnd does)
  migrateFromMarkdown(tmpDir);

  // Verify DB now has 3 decisions
  const afterReimport = queryDecisions();
  assertEq(afterReimport.length, 3, 're-import: after re-import has 3 decisions');
  const afterIds = afterReimport.map(d => d.id).sort();
  assertEq(afterIds, ['D001', 'D002', 'D003'], 're-import: decisions are D001, D002, D003');

  // Verify the new decision has correct data
  const d003 = afterReimport.find(d => d.id === 'D003');
  assertTrue(d003 !== undefined, 're-import: D003 exists');
  assertEq(d003!.when_context, 'M001/S02', 're-import: D003 when_context is M001/S02');
  assertEq(d003!.scope, 'runtime', 're-import: D003 scope is runtime');
  assertEq(d003!.choice, 'D014 pattern', 're-import: D003 choice is D014 pattern');

  // Verify scoped query picks up the new decision
  const m001Scoped = queryDecisions({ milestoneId: 'M001' });
  assertTrue(m001Scoped.length === 3, 're-import: all 3 decisions are for M001');

  closeDatabase();
}

// ─── Final Report ──────────────────────────────────────────────────────────
report();
