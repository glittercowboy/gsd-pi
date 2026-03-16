import { createTestContext } from './test-helpers.ts';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  openDatabase,
  closeDatabase,
  upsertDecision,
  upsertRequirement,
  insertArtifact,
  getDecisionById,
  getRequirementById,
  _getAdapter,
} from '../gsd-db.ts';
import {
  parseDecisionsTable,
  parseRequirementsSections,
} from '../md-importer.ts';
import {
  generateDecisionsMd,
  generateRequirementsMd,
  nextDecisionId,
  saveDecisionToDb,
  updateRequirementInDb,
  saveArtifactToDb,
} from '../db-writer.ts';
import type { Decision, Requirement } from '../types.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dbwriter-'));
  // Create .gsd directory structure
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* swallow */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const SAMPLE_DECISIONS: Decision[] = [
  {
    seq: 1,
    id: 'D001',
    when_context: 'M001',
    scope: 'library',
    decision: 'SQLite library',
    choice: 'better-sqlite3',
    rationale: 'Sync API',
    revisable: 'No',
    superseded_by: null,
  },
  {
    seq: 2,
    id: 'D002',
    when_context: 'M001',
    scope: 'arch',
    decision: 'DB location',
    choice: '.gsd/gsd.db',
    rationale: 'Derived state',
    revisable: 'No',
    superseded_by: null,
  },
  {
    seq: 3,
    id: 'D003',
    when_context: 'M001/S01',
    scope: 'impl',
    decision: 'Provider strategy (amends D001)',
    choice: 'node:sqlite fallback',
    rationale: 'Zero deps',
    revisable: 'Yes',
    superseded_by: null,
  },
];

const SAMPLE_REQUIREMENTS: Requirement[] = [
  {
    id: 'R001',
    class: 'core-capability',
    status: 'active',
    description: 'A SQLite database with typed wrappers',
    why: 'Foundation for storage',
    source: 'user',
    primary_owner: 'M001/S01',
    supporting_slices: 'none',
    validation: 'S01 verified',
    notes: 'WAL mode enabled',
    full_content: '',
    superseded_by: null,
  },
  {
    id: 'R002',
    class: 'failure-visibility',
    status: 'validated',
    description: 'Falls back to markdown if SQLite unavailable',
    why: 'Must not break on exotic platforms',
    source: 'user',
    primary_owner: 'M001/S01',
    supporting_slices: 'M001/S03',
    validation: 'S03 validated',
    notes: 'Transparent fallback',
    full_content: '',
    superseded_by: null,
  },
  {
    id: 'R030',
    class: 'differentiator',
    status: 'deferred',
    description: 'Vector search support',
    why: 'Semantic retrieval',
    source: 'user',
    primary_owner: 'none',
    supporting_slices: 'none',
    validation: 'unmapped',
    notes: 'Deferred to M002',
    full_content: '',
    superseded_by: null,
  },
  {
    id: 'R040',
    class: 'anti-feature',
    status: 'out-of-scope',
    description: 'GUI dashboard',
    why: 'CLI-first design',
    source: 'user',
    primary_owner: 'none',
    supporting_slices: 'none',
    validation: '',
    notes: '',
    full_content: '',
    superseded_by: null,
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Round-Trip Tests: Decisions
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── generateDecisionsMd round-trip ──');

{
  const md = generateDecisionsMd(SAMPLE_DECISIONS);
  const parsed = parseDecisionsTable(md);

  assertEq(parsed.length, SAMPLE_DECISIONS.length, 'decisions count matches');

  for (let i = 0; i < SAMPLE_DECISIONS.length; i++) {
    const orig = SAMPLE_DECISIONS[i];
    const rt = parsed[i];
    assertEq(rt.id, orig.id, `decision ${orig.id} id round-trips`);
    assertEq(rt.when_context, orig.when_context, `decision ${orig.id} when_context round-trips`);
    assertEq(rt.scope, orig.scope, `decision ${orig.id} scope round-trips`);
    assertEq(rt.decision, orig.decision, `decision ${orig.id} decision round-trips`);
    assertEq(rt.choice, orig.choice, `decision ${orig.id} choice round-trips`);
    assertEq(rt.rationale, orig.rationale, `decision ${orig.id} rationale round-trips`);
    assertEq(rt.revisable, orig.revisable, `decision ${orig.id} revisable round-trips`);
  }
}

console.log('\n── generateDecisionsMd format ──');

{
  const md = generateDecisionsMd(SAMPLE_DECISIONS);
  assertTrue(md.startsWith('# Decisions Register\n'), 'starts with H1 header');
  assertTrue(md.includes('<!-- Append-only'), 'contains HTML comment block');
  assertTrue(md.includes('| # | When | Scope'), 'contains table header');
  assertTrue(md.includes('|---|------|-------'), 'contains separator row');
}

console.log('\n── generateDecisionsMd empty input ──');

{
  const md = generateDecisionsMd([]);
  const parsed = parseDecisionsTable(md);
  assertEq(parsed.length, 0, 'empty decisions produces empty parse');
  assertTrue(md.includes('| # | When | Scope'), 'still has table header even when empty');
}

console.log('\n── generateDecisionsMd pipe escaping ──');

{
  const withPipe: Decision = {
    seq: 1,
    id: 'D001',
    when_context: 'M001',
    scope: 'arch',
    decision: 'Choice A | Choice B comparison',
    choice: 'A',
    rationale: 'Better',
    revisable: 'No',
    superseded_by: null,
  };
  const md = generateDecisionsMd([withPipe]);
  // Should not break the table — pipe in decision text should be escaped
  const parsed = parseDecisionsTable(md);
  assertTrue(parsed.length >= 1, 'pipe-containing decision parses without breaking table');
}

// ═══════════════════════════════════════════════════════════════════════════
// Round-Trip Tests: Requirements
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── generateRequirementsMd round-trip ──');

{
  const md = generateRequirementsMd(SAMPLE_REQUIREMENTS);
  const parsed = parseRequirementsSections(md);

  assertEq(parsed.length, SAMPLE_REQUIREMENTS.length, 'requirements count matches');

  for (const orig of SAMPLE_REQUIREMENTS) {
    const rt = parsed.find(r => r.id === orig.id);
    assertTrue(!!rt, `requirement ${orig.id} found in parsed output`);
    if (rt) {
      assertEq(rt.class, orig.class, `requirement ${orig.id} class round-trips`);
      assertEq(rt.description, orig.description, `requirement ${orig.id} description round-trips`);
      assertEq(rt.why, orig.why, `requirement ${orig.id} why round-trips`);
      assertEq(rt.source, orig.source, `requirement ${orig.id} source round-trips`);
      assertEq(rt.primary_owner, orig.primary_owner, `requirement ${orig.id} primary_owner round-trips`);
      assertEq(rt.supporting_slices, orig.supporting_slices, `requirement ${orig.id} supporting_slices round-trips`);
      if (orig.notes) {
        assertEq(rt.notes, orig.notes, `requirement ${orig.id} notes round-trips`);
      }
    }
  }
}

console.log('\n── generateRequirementsMd sections ──');

{
  const md = generateRequirementsMd(SAMPLE_REQUIREMENTS);
  assertTrue(md.includes('## Active'), 'has Active section');
  assertTrue(md.includes('## Validated'), 'has Validated section');
  assertTrue(md.includes('## Deferred'), 'has Deferred section');
  assertTrue(md.includes('## Out of Scope'), 'has Out of Scope section');
  assertTrue(md.includes('## Traceability'), 'has Traceability section');
  assertTrue(md.includes('## Coverage Summary'), 'has Coverage Summary section');
}

console.log('\n── generateRequirementsMd only populated sections ──');

{
  // Only active requirements — should only have Active section
  const activeOnly = SAMPLE_REQUIREMENTS.filter(r => r.status === 'active');
  const md = generateRequirementsMd(activeOnly);
  assertTrue(md.includes('## Active'), 'has Active section');
  assertTrue(!md.includes('## Validated'), 'no Validated section when no validated reqs');
  assertTrue(!md.includes('## Deferred'), 'no Deferred section when no deferred reqs');
  assertTrue(!md.includes('## Out of Scope'), 'no Out of Scope section when no out-of-scope reqs');
}

console.log('\n── generateRequirementsMd empty input ──');

{
  const md = generateRequirementsMd([]);
  const parsed = parseRequirementsSections(md);
  assertEq(parsed.length, 0, 'empty requirements produces empty parse');
}

// ═══════════════════════════════════════════════════════════════════════════
// nextDecisionId Tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── nextDecisionId ──');

{
  // Open in-memory DB
  openDatabase(':memory:');

  const id1 = await nextDecisionId();
  assertEq(id1, 'D001', 'first ID when no decisions exist');

  // Insert some decisions
  upsertDecision({
    id: 'D001',
    when_context: 'M001',
    scope: 'test',
    decision: 'test decision',
    choice: 'test choice',
    rationale: 'test',
    revisable: 'No',
    superseded_by: null,
  });
  upsertDecision({
    id: 'D005',
    when_context: 'M001',
    scope: 'test',
    decision: 'test decision 5',
    choice: 'test choice',
    rationale: 'test',
    revisable: 'No',
    superseded_by: null,
  });

  const id2 = await nextDecisionId();
  assertEq(id2, 'D006', 'next ID after D005 is D006');

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// saveDecisionToDb Tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── saveDecisionToDb ──');

{
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const result = await saveDecisionToDb({
      scope: 'arch',
      decision: 'Test decision',
      choice: 'Option A',
      rationale: 'Best option',
      when_context: 'M001',
    }, tmpDir);

    assertEq(result.id, 'D001', 'saveDecisionToDb returns D001 as first ID');

    // Verify DB state
    const dbDecision = getDecisionById('D001');
    assertTrue(!!dbDecision, 'decision exists in DB after save');
    assertEq(dbDecision?.scope, 'arch', 'DB decision has correct scope');
    assertEq(dbDecision?.choice, 'Option A', 'DB decision has correct choice');

    // Verify markdown file was written
    const mdPath = path.join(tmpDir, '.gsd', 'DECISIONS.md');
    assertTrue(fs.existsSync(mdPath), 'DECISIONS.md file created');

    const mdContent = fs.readFileSync(mdPath, 'utf-8');
    assertTrue(mdContent.includes('D001'), 'DECISIONS.md contains new decision ID');
    assertTrue(mdContent.includes('Test decision'), 'DECISIONS.md contains decision text');

    // Verify round-trip of the written file
    const parsed = parseDecisionsTable(mdContent);
    assertEq(parsed.length, 1, 'written DECISIONS.md parses to 1 decision');
    assertEq(parsed[0].id, 'D001', 'parsed decision has correct ID');

    // Add second decision
    const result2 = await saveDecisionToDb({
      scope: 'impl',
      decision: 'Second decision',
      choice: 'Option B',
      rationale: 'Also good',
    }, tmpDir);

    assertEq(result2.id, 'D002', 'second decision gets D002');

    const mdContent2 = fs.readFileSync(mdPath, 'utf-8');
    const parsed2 = parseDecisionsTable(mdContent2);
    assertEq(parsed2.length, 2, 'DECISIONS.md now has 2 decisions');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// updateRequirementInDb Tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── updateRequirementInDb ──');

{
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    // Seed a requirement
    upsertRequirement({
      id: 'R001',
      class: 'core-capability',
      status: 'active',
      description: 'Test requirement',
      why: 'Testing',
      source: 'test',
      primary_owner: 'M001/S01',
      supporting_slices: 'none',
      validation: 'unmapped',
      notes: '',
      full_content: '',
      superseded_by: null,
    });

    // Update it
    await updateRequirementInDb('R001', {
      status: 'validated',
      validation: 'S01 — all tests pass',
      notes: 'Validated in S01',
    }, tmpDir);

    // Verify DB state
    const updated = getRequirementById('R001');
    assertTrue(!!updated, 'requirement still exists after update');
    assertEq(updated?.status, 'validated', 'status updated in DB');
    assertEq(updated?.validation, 'S01 — all tests pass', 'validation updated in DB');
    assertEq(updated?.description, 'Test requirement', 'description preserved after update');

    // Verify markdown file was written
    const mdPath = path.join(tmpDir, '.gsd', 'REQUIREMENTS.md');
    assertTrue(fs.existsSync(mdPath), 'REQUIREMENTS.md file created');

    const mdContent = fs.readFileSync(mdPath, 'utf-8');
    assertTrue(mdContent.includes('R001'), 'REQUIREMENTS.md contains requirement ID');
    assertTrue(mdContent.includes('validated'), 'REQUIREMENTS.md shows updated status');

    // Verify round-trip
    const parsed = parseRequirementsSections(mdContent);
    assertEq(parsed.length, 1, 'parsed 1 requirement from written file');
    assertEq(parsed[0].status, 'validated', 'parsed status matches update');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
}

console.log('\n── updateRequirementInDb — not found ──');

{
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    let threw = false;
    try {
      await updateRequirementInDb('R999', { status: 'validated' }, tmpDir);
    } catch (err) {
      threw = true;
      assertTrue(
        (err as Error).message.includes('R999'),
        'error message mentions the missing ID',
      );
    }
    assertTrue(threw, 'throws when requirement not found');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// saveArtifactToDb Tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── saveArtifactToDb ──');

{
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const content = '# Task Summary\n\nTest content\n';
    await saveArtifactToDb({
      path: 'milestones/M001/slices/S06/tasks/T01-SUMMARY.md',
      artifact_type: 'SUMMARY',
      content,
      milestone_id: 'M001',
      slice_id: 'S06',
      task_id: 'T01',
    }, tmpDir);

    // Verify DB state
    const adapter = _getAdapter();
    assertTrue(!!adapter, 'adapter available');
    const row = adapter!
      .prepare('SELECT * FROM artifacts WHERE path = ?')
      .get('milestones/M001/slices/S06/tasks/T01-SUMMARY.md');
    assertTrue(!!row, 'artifact exists in DB');
    assertEq(row!['artifact_type'], 'SUMMARY', 'artifact type correct in DB');
    assertEq(row!['milestone_id'], 'M001', 'milestone_id correct in DB');
    assertEq(row!['slice_id'], 'S06', 'slice_id correct in DB');
    assertEq(row!['task_id'], 'T01', 'task_id correct in DB');

    // Verify file on disk
    const filePath = path.join(
      tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S06', 'tasks', 'T01-SUMMARY.md',
    );
    assertTrue(fs.existsSync(filePath), 'artifact file written to disk');
    assertEq(fs.readFileSync(filePath, 'utf-8'), content, 'file content matches');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Full Round-Trip: DB → Markdown → Parse → Compare
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Full DB round-trip: decisions ──');

{
  openDatabase(':memory:');

  // Insert via DB
  for (const d of SAMPLE_DECISIONS) {
    upsertDecision({
      id: d.id,
      when_context: d.when_context,
      scope: d.scope,
      decision: d.decision,
      choice: d.choice,
      rationale: d.rationale,
      revisable: d.revisable,
      superseded_by: d.superseded_by,
    });
  }

  // Generate markdown from DB state
  const adapter = _getAdapter()!;
  const rows = adapter.prepare('SELECT * FROM decisions ORDER BY seq').all();
  const dbDecisions: Decision[] = rows.map(row => ({
    seq: row['seq'] as number,
    id: row['id'] as string,
    when_context: row['when_context'] as string,
    scope: row['scope'] as string,
    decision: row['decision'] as string,
    choice: row['choice'] as string,
    rationale: row['rationale'] as string,
    revisable: row['revisable'] as string,
    superseded_by: (row['superseded_by'] as string) ?? null,
  }));

  const md = generateDecisionsMd(dbDecisions);
  const parsed = parseDecisionsTable(md);

  assertEq(parsed.length, SAMPLE_DECISIONS.length, 'DB round-trip decision count');
  for (const orig of SAMPLE_DECISIONS) {
    const rt = parsed.find(p => p.id === orig.id);
    assertTrue(!!rt, `DB round-trip: ${orig.id} found`);
    if (rt) {
      assertEq(rt.scope, orig.scope, `DB round-trip: ${orig.id} scope`);
      assertEq(rt.choice, orig.choice, `DB round-trip: ${orig.id} choice`);
    }
  }

  closeDatabase();
}

console.log('\n── Full DB round-trip: requirements ──');

{
  openDatabase(':memory:');

  for (const r of SAMPLE_REQUIREMENTS) {
    upsertRequirement(r);
  }

  const adapter = _getAdapter()!;
  const rows = adapter.prepare('SELECT * FROM requirements ORDER BY id').all();
  const dbReqs: Requirement[] = rows.map(row => ({
    id: row['id'] as string,
    class: row['class'] as string,
    status: row['status'] as string,
    description: row['description'] as string,
    why: row['why'] as string,
    source: row['source'] as string,
    primary_owner: row['primary_owner'] as string,
    supporting_slices: row['supporting_slices'] as string,
    validation: row['validation'] as string,
    notes: row['notes'] as string,
    full_content: row['full_content'] as string,
    superseded_by: (row['superseded_by'] as string) ?? null,
  }));

  const md = generateRequirementsMd(dbReqs);
  const parsed = parseRequirementsSections(md);

  assertEq(parsed.length, SAMPLE_REQUIREMENTS.length, 'DB round-trip requirement count');
  for (const orig of SAMPLE_REQUIREMENTS) {
    const rt = parsed.find(p => p.id === orig.id);
    assertTrue(!!rt, `DB round-trip: ${orig.id} found`);
    if (rt) {
      assertEq(rt.class, orig.class, `DB round-trip: ${orig.id} class`);
      assertEq(rt.description, orig.description, `DB round-trip: ${orig.id} description`);
    }
  }

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════

report();
