import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
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
  extractDeferredSliceRef,
} from '../db-writer.ts';
import type { Decision, Requirement } from '../types.ts';

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
    made_by: 'collaborative',
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
    made_by: 'agent',
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
    made_by: 'human',
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

describe('db-writer', () => {
  test('generateDecisionsMd round-trip', () => {
    const md = generateDecisionsMd(SAMPLE_DECISIONS);
    const parsed = parseDecisionsTable(md);

    assert.deepStrictEqual(parsed.length, SAMPLE_DECISIONS.length, 'decisions count matches');

    for (let i = 0; i < SAMPLE_DECISIONS.length; i++) {
      const orig = SAMPLE_DECISIONS[i];
      const rt = parsed[i];
      assert.deepStrictEqual(rt.id, orig.id, `decision ${orig.id} id round-trips`);
      assert.deepStrictEqual(rt.when_context, orig.when_context, `decision ${orig.id} when_context round-trips`);
      assert.deepStrictEqual(rt.scope, orig.scope, `decision ${orig.id} scope round-trips`);
      assert.deepStrictEqual(rt.decision, orig.decision, `decision ${orig.id} decision round-trips`);
      assert.deepStrictEqual(rt.choice, orig.choice, `decision ${orig.id} choice round-trips`);
      assert.deepStrictEqual(rt.rationale, orig.rationale, `decision ${orig.id} rationale round-trips`);
      assert.deepStrictEqual(rt.revisable, orig.revisable, `decision ${orig.id} revisable round-trips`);
      assert.deepStrictEqual(rt.made_by, orig.made_by, `decision ${orig.id} made_by round-trips`);
    }
  });

  test('generateDecisionsMd format', () => {
    const md = generateDecisionsMd(SAMPLE_DECISIONS);
    assert.ok(md.startsWith('# Decisions Register\n'), 'starts with H1 header');
    assert.ok(md.includes('<!-- Append-only'), 'contains HTML comment block');
    assert.ok(md.includes('| # | When | Scope'), 'contains table header');
    assert.ok(md.includes('|---|------|-------'), 'contains separator row');
    assert.ok(md.includes('| Made By |'), 'contains Made By column header');
  });

  test('generateDecisionsMd empty input', () => {
    const md = generateDecisionsMd([]);
    const parsed = parseDecisionsTable(md);
    assert.deepStrictEqual(parsed.length, 0, 'empty decisions produces empty parse');
    assert.ok(md.includes('| # | When | Scope'), 'still has table header even when empty');
  });

  test('generateDecisionsMd pipe escaping', () => {
    const withPipe: Decision = {
      seq: 1,
      id: 'D001',
      when_context: 'M001',
      scope: 'arch',
      decision: 'Choice A | Choice B comparison',
      choice: 'A',
      rationale: 'Better',
      revisable: 'No',
      made_by: 'agent',
      superseded_by: null,
    };
    const md = generateDecisionsMd([withPipe]);
    // Should not break the table — pipe in decision text should be escaped
    const parsed = parseDecisionsTable(md);
    assert.ok(parsed.length >= 1, 'pipe-containing decision parses without breaking table');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Round-Trip Tests: Requirements
  // ═══════════════════════════════════════════════════════════════════════════

  test('generateRequirementsMd round-trip', () => {
    const md = generateRequirementsMd(SAMPLE_REQUIREMENTS);
    const parsed = parseRequirementsSections(md);

    assert.deepStrictEqual(parsed.length, SAMPLE_REQUIREMENTS.length, 'requirements count matches');

    for (const orig of SAMPLE_REQUIREMENTS) {
      const rt = parsed.find(r => r.id === orig.id);
      assert.ok(!!rt, `requirement ${orig.id} found in parsed output`);
      if (rt) {
        assert.deepStrictEqual(rt.class, orig.class, `requirement ${orig.id} class round-trips`);
        assert.deepStrictEqual(rt.description, orig.description, `requirement ${orig.id} description round-trips`);
        assert.deepStrictEqual(rt.why, orig.why, `requirement ${orig.id} why round-trips`);
        assert.deepStrictEqual(rt.source, orig.source, `requirement ${orig.id} source round-trips`);
        assert.deepStrictEqual(rt.primary_owner, orig.primary_owner, `requirement ${orig.id} primary_owner round-trips`);
        assert.deepStrictEqual(rt.supporting_slices, orig.supporting_slices, `requirement ${orig.id} supporting_slices round-trips`);
        if (orig.notes) {
          assert.deepStrictEqual(rt.notes, orig.notes, `requirement ${orig.id} notes round-trips`);
        }
      }
    }
  });

  test('generateRequirementsMd sections', () => {
    const md = generateRequirementsMd(SAMPLE_REQUIREMENTS);
    assert.ok(md.includes('## Active'), 'has Active section');
    assert.ok(md.includes('## Validated'), 'has Validated section');
    assert.ok(md.includes('## Deferred'), 'has Deferred section');
    assert.ok(md.includes('## Out of Scope'), 'has Out of Scope section');
    assert.ok(md.includes('## Traceability'), 'has Traceability section');
    assert.ok(md.includes('## Coverage Summary'), 'has Coverage Summary section');
  });

  test('generateRequirementsMd only populated sections', () => {
    // Only active requirements — should only have Active section
    const activeOnly = SAMPLE_REQUIREMENTS.filter(r => r.status === 'active');
    const md = generateRequirementsMd(activeOnly);
    assert.ok(md.includes('## Active'), 'has Active section');
    assert.ok(!md.includes('## Validated'), 'no Validated section when no validated reqs');
    assert.ok(!md.includes('## Deferred'), 'no Deferred section when no deferred reqs');
    assert.ok(!md.includes('## Out of Scope'), 'no Out of Scope section when no out-of-scope reqs');
  });

  test('generateRequirementsMd empty input', () => {
    const md = generateRequirementsMd([]);
    const parsed = parseRequirementsSections(md);
    assert.deepStrictEqual(parsed.length, 0, 'empty requirements produces empty parse');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // nextDecisionId Tests
  // ═══════════════════════════════════════════════════════════════════════════

  test('nextDecisionId', async () => {
    // Open in-memory DB
    openDatabase(':memory:');

    const id1 = await nextDecisionId();
    assert.deepStrictEqual(id1, 'D001', 'first ID when no decisions exist');

    // Insert some decisions
    upsertDecision({
      id: 'D001',
      when_context: 'M001',
      scope: 'test',
      decision: 'test decision',
      choice: 'test choice',
      rationale: 'test',
      revisable: 'No',
      made_by: 'agent',
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
      made_by: 'agent',
      superseded_by: null,
    });

    const id2 = await nextDecisionId();
    assert.deepStrictEqual(id2, 'D006', 'next ID after D005 is D006');

    closeDatabase();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // saveDecisionToDb Tests
  // ═══════════════════════════════════════════════════════════════════════════

  test('saveDecisionToDb', async () => {
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

      assert.deepStrictEqual(result.id, 'D001', 'saveDecisionToDb returns D001 as first ID');

      // Verify DB state
      const dbDecision = getDecisionById('D001');
      assert.ok(!!dbDecision, 'decision exists in DB after save');
      assert.deepStrictEqual(dbDecision?.scope, 'arch', 'DB decision has correct scope');
      assert.deepStrictEqual(dbDecision?.choice, 'Option A', 'DB decision has correct choice');

      // Verify markdown file was written
      const mdPath = path.join(tmpDir, '.gsd', 'DECISIONS.md');
      assert.ok(fs.existsSync(mdPath), 'DECISIONS.md file created');

      const mdContent = fs.readFileSync(mdPath, 'utf-8');
      assert.ok(mdContent.includes('D001'), 'DECISIONS.md contains new decision ID');
      assert.ok(mdContent.includes('Test decision'), 'DECISIONS.md contains decision text');

      // Verify round-trip of the written file
      const parsed = parseDecisionsTable(mdContent);
      assert.deepStrictEqual(parsed.length, 1, 'written DECISIONS.md parses to 1 decision');
      assert.deepStrictEqual(parsed[0].id, 'D001', 'parsed decision has correct ID');

      // Add second decision
      const result2 = await saveDecisionToDb({
        scope: 'impl',
        decision: 'Second decision',
        choice: 'Option B',
        rationale: 'Also good',
      }, tmpDir);

      assert.deepStrictEqual(result2.id, 'D002', 'second decision gets D002');

      const mdContent2 = fs.readFileSync(mdPath, 'utf-8');
      const parsed2 = parseDecisionsTable(mdContent2);
      assert.deepStrictEqual(parsed2.length, 2, 'DECISIONS.md now has 2 decisions');
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Parallel save race condition regression (#3326, #3339, #3459)
  // ═══════════════════════════════════════════════════════════════════════════

  test('parallel saveDecisionToDb calls produce unique IDs', async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    openDatabase(dbPath);

    try {
      // Fire 5 saves concurrently — before the fix, all would get D001
      const results = await Promise.all([
        saveDecisionToDb({ scope: 'a', decision: 'd1', choice: 'c1', rationale: 'r1' }, tmpDir),
        saveDecisionToDb({ scope: 'b', decision: 'd2', choice: 'c2', rationale: 'r2' }, tmpDir),
        saveDecisionToDb({ scope: 'c', decision: 'd3', choice: 'c3', rationale: 'r3' }, tmpDir),
        saveDecisionToDb({ scope: 'd', decision: 'd4', choice: 'c4', rationale: 'r4' }, tmpDir),
        saveDecisionToDb({ scope: 'e', decision: 'd5', choice: 'c5', rationale: 'r5' }, tmpDir),
      ]);

      const ids = results.map((r) => r.id);
      const uniqueIds = new Set(ids);

      // All 5 IDs must be unique
      assert.equal(uniqueIds.size, 5, `Expected 5 unique IDs, got ${uniqueIds.size}: ${ids.join(', ')}`);

      // IDs should be D001-D005 (order may vary due to concurrency)
      for (const id of ids) {
        assert.match(id, /^D\d{3}$/, `ID ${id} should match D### pattern`);
      }

      // Verify all 5 exist in DB
      for (const id of ids) {
        const row = getDecisionById(id);
        assert.ok(row, `Decision ${id} should exist in DB`);
      }
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // updateRequirementInDb Tests
  // ═══════════════════════════════════════════════════════════════════════════

  test('updateRequirementInDb', async () => {
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
      assert.ok(!!updated, 'requirement still exists after update');
      assert.deepStrictEqual(updated?.status, 'validated', 'status updated in DB');
      assert.deepStrictEqual(updated?.validation, 'S01 — all tests pass', 'validation updated in DB');
      assert.deepStrictEqual(updated?.description, 'Test requirement', 'description preserved after update');

      // Verify markdown file was written
      const mdPath = path.join(tmpDir, '.gsd', 'REQUIREMENTS.md');
      assert.ok(fs.existsSync(mdPath), 'REQUIREMENTS.md file created');

      const mdContent = fs.readFileSync(mdPath, 'utf-8');
      assert.ok(mdContent.includes('R001'), 'REQUIREMENTS.md contains requirement ID');
      assert.ok(mdContent.includes('validated'), 'REQUIREMENTS.md shows updated status');

      // Verify round-trip
      const parsed = parseRequirementsSections(mdContent);
      assert.deepStrictEqual(parsed.length, 1, 'parsed 1 requirement from written file');
      assert.deepStrictEqual(parsed[0].status, 'validated', 'parsed status matches update');
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('updateRequirementInDb — upserts when not found (#2919)', async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    openDatabase(dbPath);

    try {
      // Previously threw; now upserts a skeleton requirement with the provided updates
      await updateRequirementInDb('R999', { status: 'validated' }, tmpDir);
      const created = getRequirementById('R999');
      assert.ok(created !== null, 'R999 should be created by upsert');
      assert.deepStrictEqual(created!.status, 'validated', 'Upserted requirement should have validated status');
      assert.deepStrictEqual(created!.id, 'R999', 'Upserted requirement should keep the provided ID');
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('updateRequirementInDb — seeds from REQUIREMENTS.md when DB empty (#3346)', async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    openDatabase(dbPath);

    try {
      // Write a REQUIREMENTS.md with real content (simulating discussion phase output)
      const reqContent = [
        '# Requirements',
        '',
        '## Active',
        '',
        '### R005 — User authentication',
        '- Class: functional',
        '- Why: Users need secure access',
        '- Source: user-research',
        '- Primary owner: M001/S02',
        '',
        '### R007 — API rate limiting',
        '- Class: non-functional',
        '- Why: Prevent abuse',
        '- Source: architecture',
        '- Primary owner: M001/S03',
        '',
        '## Validated',
        '',
        '### R001 — Database schema',
        '- Class: functional',
        '- Why: Foundation for storage',
        '- Source: design',
        '- Validation: S01 verified',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.gsd', 'REQUIREMENTS.md'), reqContent);

      // DB is empty — no requirements seeded. Update R005 to "validated".
      // Before #3346 fix: this would create a skeleton with empty fields.
      // After fix: this seeds all 3 requirements from REQUIREMENTS.md first.
      await updateRequirementInDb('R005', {
        status: 'validated',
        validation: 'S02 — auth flow verified',
      }, tmpDir);

      // R005 should have the update AND the original content from markdown
      const r005 = getRequirementById('R005');
      assert.ok(r005, 'R005 should exist');
      assert.equal(r005!.status, 'validated', 'status should be updated');
      assert.equal(r005!.validation, 'S02 — auth flow verified', 'validation should be updated');
      assert.equal(r005!.class, 'functional', 'class should be preserved from REQUIREMENTS.md');
      assert.ok(r005!.description?.includes('authentication') || r005!.full_content?.includes('authentication'),
        'original content should be preserved');

      // R007 and R001 should also be seeded (not just the one being updated)
      const r007 = getRequirementById('R007');
      assert.ok(r007, 'R007 should be seeded from REQUIREMENTS.md');
      assert.equal(r007!.status, 'active', 'R007 status should be active');

      const r001 = getRequirementById('R001');
      assert.ok(r001, 'R001 should be seeded from REQUIREMENTS.md');
      assert.equal(r001!.status, 'validated', 'R001 status should be validated (from section heading)');
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // saveArtifactToDb Tests
  // ═══════════════════════════════════════════════════════════════════════════

  test('saveArtifactToDb', async () => {
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
      assert.ok(!!adapter, 'adapter available');
      const row = adapter!
        .prepare('SELECT * FROM artifacts WHERE path = ?')
        .get('milestones/M001/slices/S06/tasks/T01-SUMMARY.md');
      assert.ok(!!row, 'artifact exists in DB');
      assert.deepStrictEqual(row!['artifact_type'], 'SUMMARY', 'artifact type correct in DB');
      assert.deepStrictEqual(row!['milestone_id'], 'M001', 'milestone_id correct in DB');
      assert.deepStrictEqual(row!['slice_id'], 'S06', 'slice_id correct in DB');
      assert.deepStrictEqual(row!['task_id'], 'T01', 'task_id correct in DB');

      // Verify file on disk
      const filePath = path.join(
        tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S06', 'tasks', 'T01-SUMMARY.md',
      );
      assert.ok(fs.existsSync(filePath), 'artifact file written to disk');
      assert.deepStrictEqual(fs.readFileSync(filePath, 'utf-8'), content, 'file content matches');
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('saveArtifactToDb — shrinkage guard preserves larger existing file', async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    openDatabase(dbPath);

    try {
      const fullContent = '# Full Research\n\n' + 'x'.repeat(20000) + '\n';
      const abbreviatedContent = '# Summary\n\nShort version.\n';

      // Pre-create the file with full content (simulating a prior `write` tool call)
      const relPath = 'milestones/M001/M001-RESEARCH.md';
      const filePath = path.join(tmpDir, '.gsd', relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fullContent);

      // Call saveArtifactToDb with abbreviated content — should trigger shrinkage guard
      await saveArtifactToDb({
        path: relPath,
        artifact_type: 'RESEARCH',
        content: abbreviatedContent,
        milestone_id: 'M001',
      }, tmpDir);

      // Disk file should be preserved (not overwritten)
      assert.deepStrictEqual(
        fs.readFileSync(filePath, 'utf-8'),
        fullContent,
        'disk file preserved — shrinkage guard prevented overwrite',
      );

      // DB should contain the full disk content, not the abbreviated content
      const adapter = _getAdapter();
      const row = adapter!
        .prepare('SELECT full_content FROM artifacts WHERE path = ?')
        .get(relPath);
      assert.deepStrictEqual(
        row!['full_content'],
        fullContent,
        'DB stores the richer disk content instead of abbreviated content',
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('saveArtifactToDb — allows overwrite when new content is similar size', async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    openDatabase(dbPath);

    try {
      const oldContent = '# Summary v1\n\nOriginal content here.\n';
      const newContent = '# Summary v2\n\nUpdated content here with more details.\n';

      const relPath = 'milestones/M001/M001-SUMMARY.md';
      const filePath = path.join(tmpDir, '.gsd', relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, oldContent);

      await saveArtifactToDb({
        path: relPath,
        artifact_type: 'SUMMARY',
        content: newContent,
        milestone_id: 'M001',
      }, tmpDir);

      // Disk file should be updated (new content is >=50% of old size)
      assert.deepStrictEqual(
        fs.readFileSync(filePath, 'utf-8'),
        newContent,
        'disk file updated when new content is similar size',
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Full Round-Trip: DB → Markdown → Parse → Compare
  // ═══════════════════════════════════════════════════════════════════════════

  test('Full DB round-trip: decisions', () => {
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
        made_by: d.made_by,
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
      made_by: (row['made_by'] as string as import('../types.js').DecisionMadeBy) ?? 'agent',
      superseded_by: (row['superseded_by'] as string) ?? null,
    }));

    const md = generateDecisionsMd(dbDecisions);
    const parsed = parseDecisionsTable(md);

    assert.deepStrictEqual(parsed.length, SAMPLE_DECISIONS.length, 'DB round-trip decision count');
    for (const orig of SAMPLE_DECISIONS) {
      const rt = parsed.find(p => p.id === orig.id);
      assert.ok(!!rt, `DB round-trip: ${orig.id} found`);
      if (rt) {
        assert.deepStrictEqual(rt.scope, orig.scope, `DB round-trip: ${orig.id} scope`);
        assert.deepStrictEqual(rt.choice, orig.choice, `DB round-trip: ${orig.id} choice`);
      }
    }

    closeDatabase();
  });

  test('Full DB round-trip: requirements', () => {
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

    assert.deepStrictEqual(parsed.length, SAMPLE_REQUIREMENTS.length, 'DB round-trip requirement count');
    for (const orig of SAMPLE_REQUIREMENTS) {
      const rt = parsed.find(p => p.id === orig.id);
      assert.ok(!!rt, `DB round-trip: ${orig.id} found`);
      if (rt) {
        assert.deepStrictEqual(rt.class, orig.class, `DB round-trip: ${orig.id} class`);
        assert.deepStrictEqual(rt.description, orig.description, `DB round-trip: ${orig.id} description`);
      }
    }

    closeDatabase();
  });

  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  //  extractDeferredSliceRef
  // ═══════════════════════════════════════════════════════════════════════════

  describe('extractDeferredSliceRef', () => {
    const fields = (scope: string, choice: string, decision: string) => ({
      scope,
      choice,
      decision,
    });

    test('detects deferral in scope with M###/S## pattern in choice', () => {
      const result = extractDeferredSliceRef(
        fields('deferral of low-priority work', 'Move M001/S03 to backlog', ''),
      );
      assert.deepStrictEqual(result, { milestoneId: 'M001', sliceId: 'S03' });
    });

    test('detects deferral in choice field', () => {
      const result = extractDeferredSliceRef(
        fields('slice prioritization', 'defer M002/S01 until next sprint', ''),
      );
      assert.deepStrictEqual(result, { milestoneId: 'M002', sliceId: 'S01' });
    });

    test('detects deferral in decision field', () => {
      const result = extractDeferredSliceRef(
        fields('resource constraints', '', 'deferred M010/S12 pending review'),
      );
      assert.deepStrictEqual(result, { milestoneId: 'M010', sliceId: 'S12' });
    });

    test('returns null when no M###/S## pattern is present', () => {
      const result = extractDeferredSliceRef(
        fields('deferral of work', 'will revisit later', 'deferred indefinitely'),
      );
      assert.strictEqual(result, null);
    });

    test('recognises "deferring" variant', () => {
      const result = extractDeferredSliceRef(
        fields('deferring this slice', 'M005/S02 can wait', ''),
      );
      assert.deepStrictEqual(result, { milestoneId: 'M005', sliceId: 'S02' });
    });

    test('recognises "defers" variant', () => {
      const result = extractDeferredSliceRef(
        fields('team defers slice', 'M100/S10 not urgent', ''),
      );
      assert.deepStrictEqual(result, { milestoneId: 'M100', sliceId: 'S10' });
    });

    test('returns first M###/S## match when multiple patterns exist', () => {
      const result = extractDeferredSliceRef(
        fields('', 'defer M003/S01 and M003/S02', ''),
      );
      assert.deepStrictEqual(result, { milestoneId: 'M003', sliceId: 'S01' });
    });

    test('returns null when no deferral keyword is present', () => {
      const result = extractDeferredSliceRef(
        fields('approved work', 'M001/S01 is ready', 'proceed with M001/S01'),
      );
      assert.strictEqual(result, null);
    });
  });

});
