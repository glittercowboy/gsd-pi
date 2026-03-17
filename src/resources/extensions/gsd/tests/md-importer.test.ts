import { createTestContext } from './test-helpers.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openDatabase,
  closeDatabase,
  getDecisionById,
  getActiveDecisions,
  getRequirementById,
  getActiveRequirements,
  insertArtifact,
  _getAdapter,
} from '../gsd-db.ts';
import {
  parseDecisionsTable,
  parseRequirementsSections,
  migrateFromMarkdown,
} from '../md-importer.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const DECISIONS_MD = `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001 | library | SQLite library | better-sqlite3 | Sync API | No |
| D002 | M001 | arch | DB location | .gsd/gsd.db | Derived state | No |
| D010 | M001/S01 | library | Provider strategy (amends D001) | node:sqlite fallback | Zero deps | No |
| D020 | M001/S02 | library | Importer approach (amends D010) | Direct parse | Simple | Yes |
`;

const REQUIREMENTS_MD = `# Requirements

## Active

### R001 — SQLite DB layer
- Class: core-capability
- Status: active
- Description: A SQLite database with typed wrappers
- Why it matters: Foundation for storage
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: unmapped
- Notes: WAL mode enabled

### R002 — Graceful fallback
- Class: failure-visibility
- Status: active
- Description: Falls back to markdown if SQLite unavailable
- Why it matters: Must not break on exotic platforms
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S03
- Validation: unmapped
- Notes: Transparent fallback

## Validated

### R017 — Sub-5ms query latency
- Validated by: M001/S01
- Proof: 50 decisions queried in 0.62ms

## Deferred

### R030 — Vector search
- Class: differentiator
- Status: deferred
- Description: Rust crate for embeddings
- Why it matters: Semantic retrieval
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred to M002

## Out of Scope

### R040 — Web UI
- Class: anti-feature
- Status: out-of-scope
- Description: No web interface for DB
- Why it matters: Prevents scope creep
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Excluded in PRD
`;

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createFixtureTree(baseDir: string): void {
  const gsd = path.join(baseDir, '.gsd');
  fs.mkdirSync(gsd, { recursive: true });
  fs.writeFileSync(path.join(gsd, 'DECISIONS.md'), DECISIONS_MD);
  fs.writeFileSync(path.join(gsd, 'REQUIREMENTS.md'), REQUIREMENTS_MD);
  fs.writeFileSync(path.join(gsd, 'PROJECT.md'), '# Test Project\nA test project.');

  // Create milestone hierarchy
  const m001 = path.join(gsd, 'milestones', 'M001');
  fs.mkdirSync(m001, { recursive: true });
  fs.writeFileSync(path.join(m001, 'M001-ROADMAP.md'), '# M001 Roadmap\nTest roadmap content.');
  fs.writeFileSync(path.join(m001, 'M001-CONTEXT.md'), '# M001 Context\nTest context.');

  // Create slice
  const s01 = path.join(m001, 'slices', 'S01');
  fs.mkdirSync(s01, { recursive: true });
  fs.writeFileSync(path.join(s01, 'S01-PLAN.md'), '# S01 Plan\nTest plan.');
  fs.writeFileSync(path.join(s01, 'S01-SUMMARY.md'), '# S01 Summary\nTest summary.');

  // Create tasks
  const tasks = path.join(s01, 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'T01-PLAN.md'), '# T01 Plan\nTask plan.');
  fs.writeFileSync(path.join(tasks, 'T01-SUMMARY.md'), '# T01 Summary\nTask summary.');
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// md-importer: parseDecisionsTable
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== md-importer: parseDecisionsTable ===');

{
  const decisions = parseDecisionsTable(DECISIONS_MD);
  assertEq(decisions.length, 4, 'should parse 4 decisions');
  assertEq(decisions[0].id, 'D001', 'first decision should be D001');
  assertEq(decisions[0].decision, 'SQLite library', 'D001 decision text');
  assertEq(decisions[0].choice, 'better-sqlite3', 'D001 choice');
  assertEq(decisions[0].scope, 'library', 'D001 scope');
  assertEq(decisions[0].revisable, 'No', 'D001 revisable');
}

console.log('=== md-importer: supersession detection ===');

{
  const decisions = parseDecisionsTable(DECISIONS_MD);

  // D010 amends D001 → D001.superseded_by = D010
  const d001 = decisions.find(d => d.id === 'D001');
  assertEq(d001?.superseded_by, 'D010', 'D001 should be superseded by D010');

  // D020 amends D010 → D010.superseded_by = D020
  const d010 = decisions.find(d => d.id === 'D010');
  assertEq(d010?.superseded_by, 'D020', 'D010 should be superseded by D020');

  // D002 is not amended
  const d002 = decisions.find(d => d.id === 'D002');
  assertEq(d002?.superseded_by, null, 'D002 should not be superseded');

  // D020 is the latest in chain, not superseded
  const d020 = decisions.find(d => d.id === 'D020');
  assertEq(d020?.superseded_by, null, 'D020 should not be superseded');
}

console.log('=== md-importer: malformed/empty rows skipped ===');

{
  const malformedInput = `# Decisions

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001 | lib | Pick lib | sqlite | Fast | No |
| not-a-decision | bad | x | y | z | w | q |
| | | | | | | |
| D003 | M001 | arch | Config | JSON | Simple | Yes |
`;
  const decisions = parseDecisionsTable(malformedInput);
  assertEq(decisions.length, 2, 'should skip rows without D-prefix IDs');
  assertEq(decisions[0].id, 'D001', 'first valid row');
  assertEq(decisions[1].id, 'D003', 'second valid row (skipping malformed)');
}

// ═══════════════════════════════════════════════════════════════════════════
// md-importer: parseRequirementsSections
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== md-importer: parseRequirementsSections ===');

{
  const reqs = parseRequirementsSections(REQUIREMENTS_MD);
  assertEq(reqs.length, 5, 'should parse 5 unique requirements');

  const r001 = reqs.find(r => r.id === 'R001');
  assertTrue(!!r001, 'R001 should exist');
  assertEq(r001?.class, 'core-capability', 'R001 class');
  assertEq(r001?.status, 'active', 'R001 status');
  assertEq(r001?.description, 'A SQLite database with typed wrappers', 'R001 description');
  assertEq(r001?.why, 'Foundation for storage', 'R001 why');
  assertEq(r001?.source, 'user', 'R001 source');
  assertEq(r001?.primary_owner, 'M001/S01', 'R001 primary_owner');
  assertEq(r001?.supporting_slices, 'none', 'R001 supporting_slices');
  assertEq(r001?.validation, 'unmapped', 'R001 validation');
  assertEq(r001?.notes, 'WAL mode enabled', 'R001 notes');
  assertTrue(r001?.full_content?.includes('### R001') ?? false, 'R001 full_content should have heading');

  // Validated section — R017 (abbreviated format with "Validated by" / "Proof" bullets)
  const r017 = reqs.find(r => r.id === 'R017');
  assertTrue(!!r017, 'R017 should exist');
  assertEq(r017?.status, 'validated', 'R017 status from validated section');
  assertEq(r017?.validation, 'M001/S01', 'R017 validation (from "Validated by" bullet)');
  assertEq(r017?.notes, '50 decisions queried in 0.62ms', 'R017 notes (from "Proof" bullet)');

  // Deferred requirement
  const r030 = reqs.find(r => r.id === 'R030');
  assertEq(r030?.status, 'deferred', 'R030 status should be deferred');
  assertEq(r030?.class, 'differentiator', 'R030 class');
  assertEq(r030?.description, 'Rust crate for embeddings', 'R030 description');

  // Out of scope
  const r040 = reqs.find(r => r.id === 'R040');
  assertEq(r040?.status, 'out-of-scope', 'R040 status should be out-of-scope');
  assertEq(r040?.class, 'anti-feature', 'R040 class');
}

// ═══════════════════════════════════════════════════════════════════════════
// md-importer: migrateFromMarkdown orchestrator
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== md-importer: migrateFromMarkdown orchestrator ===');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-import-test-'));
  createFixtureTree(tmpDir);

  try {
    openDatabase(':memory:');
    const result = migrateFromMarkdown(tmpDir);

    assertEq(result.decisions, 4, 'should import 4 decisions');
    assertEq(result.requirements, 5, 'should import 5 requirements');
    assertTrue(result.artifacts > 0, 'should import some artifacts');

    // Verify decisions queryable
    const d001 = getDecisionById('D001');
    assertTrue(!!d001, 'D001 should be queryable');
    assertEq(d001?.superseded_by, 'D010', 'D001 superseded_by should be D010');

    // Verify requirements queryable
    const r001 = getRequirementById('R001');
    assertTrue(!!r001, 'R001 should be queryable');
    assertEq(r001?.status, 'active', 'R001 status from DB');

    // Verify active views
    const activeD = getActiveDecisions();
    assertEq(activeD.length, 2, 'should have 2 active decisions (D002, D020)');

    // Verify artifacts table
    const adapter = _getAdapter();
    const artifacts = adapter?.prepare('SELECT count(*) as c FROM artifacts').get();
    assertTrue((artifacts?.c as number) > 0, 'artifacts table should have rows');

    // Verify hierarchy correctness
    const roadmap = adapter?.prepare('SELECT * FROM artifacts WHERE artifact_type = :type').get({ ':type': 'ROADMAP' });
    assertTrue(!!roadmap, 'ROADMAP artifact should exist');
    assertEq(roadmap?.milestone_id, 'M001', 'ROADMAP should be in M001');

    const taskPlan = adapter?.prepare('SELECT * FROM artifacts WHERE task_id = :taskId AND artifact_type = :type').get({
      ':taskId': 'T01',
      ':type': 'PLAN',
    });
    assertTrue(!!taskPlan, 'T01-PLAN artifact should exist');

    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// md-importer: idempotent re-import
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== md-importer: idempotent re-import ===');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-idemp-test-'));
  createFixtureTree(tmpDir);

  try {
    openDatabase(':memory:');
    const r1 = migrateFromMarkdown(tmpDir);
    const r2 = migrateFromMarkdown(tmpDir);

    assertEq(r1.decisions, r2.decisions, 'double import should produce same decision count');
    assertEq(r1.requirements, r2.requirements, 'double import should produce same requirement count');
    assertEq(r1.artifacts, r2.artifacts, 'double import should produce same artifact count');

    // Verify no duplicates
    const adapter = _getAdapter();
    const dc = adapter?.prepare('SELECT count(*) as c FROM decisions').get()?.c as number;
    const rc = adapter?.prepare('SELECT count(*) as c FROM requirements').get()?.c as number;
    const ac = adapter?.prepare('SELECT count(*) as c FROM artifacts').get()?.c as number;

    assertEq(dc, r1.decisions, 'DB decision count matches import count');
    assertEq(rc, r1.requirements, 'DB requirement count matches import count');
    assertEq(ac, r1.artifacts, 'DB artifact count matches import count');

    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// md-importer: missing file graceful handling
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== md-importer: missing file handling ===');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-empty-test-'));
  // Create empty .gsd/ with no files
  fs.mkdirSync(path.join(tmpDir, '.gsd'), { recursive: true });

  try {
    openDatabase(':memory:');
    const result = migrateFromMarkdown(tmpDir);

    assertEq(result.decisions, 0, 'missing DECISIONS.md → 0 decisions');
    assertEq(result.requirements, 0, 'missing REQUIREMENTS.md → 0 requirements');
    assertEq(result.artifacts, 0, 'empty tree → 0 artifacts');

    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// md-importer: schema v1→v2 migration on existing DBs
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== md-importer: schema v1→v2 migration ===');

{
  // This test verifies that opening a fresh DB auto-migrates to current schema version
  openDatabase(':memory:');
  const adapter = _getAdapter();
  const version = adapter?.prepare('SELECT MAX(version) as v FROM schema_version').get();
  assertEq(version?.v, 3, 'new DB should be at schema version 3');

  // Artifacts table should exist
  const tableCheck = adapter?.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
  assertEq(tableCheck?.c, 1, 'artifacts table should exist');

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// md-importer: round-trip fidelity
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== md-importer: round-trip fidelity ===');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-roundtrip-test-'));
  createFixtureTree(tmpDir);

  try {
    openDatabase(':memory:');
    migrateFromMarkdown(tmpDir);

    // Round-trip: verify imported field values match source
    const d002 = getDecisionById('D002');
    assertEq(d002?.when_context, 'M001', 'D002 when_context round-trip');
    assertEq(d002?.scope, 'arch', 'D002 scope round-trip');
    assertEq(d002?.decision, 'DB location', 'D002 decision round-trip');
    assertEq(d002?.choice, '.gsd/gsd.db', 'D002 choice round-trip');
    assertEq(d002?.rationale, 'Derived state', 'D002 rationale round-trip');

    const r002 = getRequirementById('R002');
    assertEq(r002?.class, 'failure-visibility', 'R002 class round-trip');
    assertEq(r002?.description, 'Falls back to markdown if SQLite unavailable', 'R002 description round-trip');
    assertEq(r002?.why, 'Must not break on exotic platforms', 'R002 why round-trip');
    assertEq(r002?.primary_owner, 'M001/S01', 'R002 primary_owner round-trip');
    assertEq(r002?.supporting_slices, 'M001/S03', 'R002 supporting_slices round-trip');
    assertEq(r002?.notes, 'Transparent fallback', 'R002 notes round-trip');
    assertEq(r002?.validation, 'unmapped', 'R002 validation round-trip');

    // Verify artifact content is stored
    const adapter = _getAdapter();
    const project = adapter?.prepare("SELECT * FROM artifacts WHERE path = :path").get({ ':path': 'PROJECT.md' });
    assertTrue((project?.full_content as string)?.includes('Test Project'), 'PROJECT.md content round-trip');

    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════

report();
