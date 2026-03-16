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
  formatDecisionsForPrompt,
  formatRequirementsForPrompt,
  queryArtifact,
  queryProject,
} from '../context-store.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// context-store: fallback when DB not open
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== context-store: fallback returns empty when DB not open ===');
{
  closeDatabase();
  assertTrue(!isDbAvailable(), 'DB should not be available');

  const d = queryDecisions();
  assertEq(d, [], 'queryDecisions returns [] when DB closed');

  const r = queryRequirements();
  assertEq(r, [], 'queryRequirements returns [] when DB closed');

  const df = queryDecisions({ milestoneId: 'M001' });
  assertEq(df, [], 'queryDecisions with opts returns [] when DB closed');

  const rf = queryRequirements({ sliceId: 'S01' });
  assertEq(rf, [], 'queryRequirements with opts returns [] when DB closed');
}

// ═══════════════════════════════════════════════════════════════════════════
// context-store: query decisions
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== context-store: query all active decisions ===');
{
  openDatabase(':memory:');

  insertDecision({
    id: 'D001', when_context: 'M001/S01', scope: 'architecture',
    decision: 'use SQLite', choice: 'node:sqlite', rationale: 'built-in',
    revisable: 'yes', superseded_by: 'D003', // superseded!
  });
  insertDecision({
    id: 'D002', when_context: 'M001/S01', scope: 'architecture',
    decision: 'use WAL mode', choice: 'WAL', rationale: 'concurrent reads',
    revisable: 'no', superseded_by: null,
  });
  insertDecision({
    id: 'D003', when_context: 'M002/S01', scope: 'performance',
    decision: 'use better-sqlite3', choice: 'better-sqlite3', rationale: 'faster',
    revisable: 'yes', superseded_by: null,
  });

  const all = queryDecisions();
  assertEq(all.length, 2, 'query all active decisions returns 2 (superseded excluded)');
  const ids = all.map(d => d.id);
  assertTrue(ids.includes('D002'), 'D002 should be in active results');
  assertTrue(ids.includes('D003'), 'D003 should be in active results');
  assertTrue(!ids.includes('D001'), 'D001 (superseded) should NOT be in active results');

  closeDatabase();
}

console.log('\n=== context-store: query decisions by milestone ===');
{
  openDatabase(':memory:');

  insertDecision({
    id: 'D001', when_context: 'M001/S01', scope: 'architecture',
    decision: 'decision A', choice: 'A', rationale: 'r', revisable: 'yes',
    superseded_by: null,
  });
  insertDecision({
    id: 'D002', when_context: 'M002/S02', scope: 'architecture',
    decision: 'decision B', choice: 'B', rationale: 'r', revisable: 'yes',
    superseded_by: null,
  });

  const m1 = queryDecisions({ milestoneId: 'M001' });
  assertEq(m1.length, 1, 'milestone filter M001 returns 1');
  assertEq(m1[0]?.id, 'D001', 'milestone filter returns D001');

  const m2 = queryDecisions({ milestoneId: 'M002' });
  assertEq(m2.length, 1, 'milestone filter M002 returns 1');
  assertEq(m2[0]?.id, 'D002', 'milestone filter returns D002');

  closeDatabase();
}

console.log('\n=== context-store: query decisions by scope ===');
{
  openDatabase(':memory:');

  insertDecision({
    id: 'D001', when_context: 'M001/S01', scope: 'architecture',
    decision: 'decision A', choice: 'A', rationale: 'r', revisable: 'yes',
    superseded_by: null,
  });
  insertDecision({
    id: 'D002', when_context: 'M001/S01', scope: 'performance',
    decision: 'decision B', choice: 'B', rationale: 'r', revisable: 'yes',
    superseded_by: null,
  });

  const arch = queryDecisions({ scope: 'architecture' });
  assertEq(arch.length, 1, 'scope filter architecture returns 1');
  assertEq(arch[0]?.id, 'D001', 'scope filter returns D001');

  const perf = queryDecisions({ scope: 'performance' });
  assertEq(perf.length, 1, 'scope filter performance returns 1');
  assertEq(perf[0]?.id, 'D002', 'scope filter returns D002');

  const none = queryDecisions({ scope: 'nonexistent' });
  assertEq(none.length, 0, 'scope filter nonexistent returns 0');

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// context-store: query requirements
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== context-store: query all active requirements ===');
{
  openDatabase(':memory:');

  insertRequirement({
    id: 'R001', class: 'functional', status: 'active',
    description: 'req A', why: 'w', source: 'M001', primary_owner: 'S01',
    supporting_slices: 'S02', validation: 'v', notes: '', full_content: '',
    superseded_by: 'R003', // superseded!
  });
  insertRequirement({
    id: 'R002', class: 'non-functional', status: 'active',
    description: 'req B', why: 'w', source: 'M001', primary_owner: 'S01',
    supporting_slices: '', validation: 'v', notes: '', full_content: '',
    superseded_by: null,
  });
  insertRequirement({
    id: 'R003', class: 'functional', status: 'validated',
    description: 'req C', why: 'w', source: 'M001', primary_owner: 'S02',
    supporting_slices: 'S01', validation: 'v', notes: '', full_content: '',
    superseded_by: null,
  });

  const all = queryRequirements();
  assertEq(all.length, 2, 'query all active requirements returns 2 (superseded excluded)');
  const ids = all.map(r => r.id);
  assertTrue(ids.includes('R002'), 'R002 should be active');
  assertTrue(ids.includes('R003'), 'R003 should be active');
  assertTrue(!ids.includes('R001'), 'R001 (superseded) should NOT be active');

  closeDatabase();
}

console.log('\n=== context-store: query requirements by slice ===');
{
  openDatabase(':memory:');

  insertRequirement({
    id: 'R001', class: 'functional', status: 'active',
    description: 'req A', why: 'w', source: 'M001', primary_owner: 'S01',
    supporting_slices: '', validation: 'v', notes: '', full_content: '',
    superseded_by: null,
  });
  insertRequirement({
    id: 'R002', class: 'functional', status: 'active',
    description: 'req B', why: 'w', source: 'M001', primary_owner: 'S02',
    supporting_slices: 'S01', validation: 'v', notes: '', full_content: '',
    superseded_by: null,
  });
  insertRequirement({
    id: 'R003', class: 'functional', status: 'active',
    description: 'req C', why: 'w', source: 'M001', primary_owner: 'S03',
    supporting_slices: '', validation: 'v', notes: '', full_content: '',
    superseded_by: null,
  });

  const s01 = queryRequirements({ sliceId: 'S01' });
  assertEq(s01.length, 2, 'slice filter S01 returns 2 (primary + supporting)');
  const s01ids = s01.map(r => r.id).sort();
  assertEq(s01ids, ['R001', 'R002'], 'S01 owns R001 and supports R002');

  const s03 = queryRequirements({ sliceId: 'S03' });
  assertEq(s03.length, 1, 'slice filter S03 returns 1');
  assertEq(s03[0]?.id, 'R003', 'S03 owns R003');

  closeDatabase();
}

console.log('\n=== context-store: query requirements by status ===');
{
  openDatabase(':memory:');

  insertRequirement({
    id: 'R001', class: 'functional', status: 'active',
    description: 'req A', why: 'w', source: 'M001', primary_owner: 'S01',
    supporting_slices: '', validation: 'v', notes: '', full_content: '',
    superseded_by: null,
  });
  insertRequirement({
    id: 'R002', class: 'functional', status: 'validated',
    description: 'req B', why: 'w', source: 'M001', primary_owner: 'S01',
    supporting_slices: '', validation: 'v', notes: '', full_content: '',
    superseded_by: null,
  });
  insertRequirement({
    id: 'R003', class: 'functional', status: 'deferred',
    description: 'req C', why: 'w', source: 'M001', primary_owner: 'S01',
    supporting_slices: '', validation: 'v', notes: '', full_content: '',
    superseded_by: null,
  });

  const active = queryRequirements({ status: 'active' });
  assertEq(active.length, 1, 'status filter active returns 1');
  assertEq(active[0]?.id, 'R001', 'active returns R001');

  const validated = queryRequirements({ status: 'validated' });
  assertEq(validated.length, 1, 'status filter validated returns 1');
  assertEq(validated[0]?.id, 'R002', 'validated returns R002');

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// context-store: format decisions
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== context-store: formatDecisionsForPrompt ===');
{
  const empty = formatDecisionsForPrompt([]);
  assertEq(empty, '', 'empty input returns empty string');

  const result = formatDecisionsForPrompt([
    {
      seq: 1, id: 'D001', when_context: 'M001/S01', scope: 'architecture',
      decision: 'use SQLite', choice: 'node:sqlite', rationale: 'built-in',
      revisable: 'yes', superseded_by: null,
    },
    {
      seq: 2, id: 'D002', when_context: 'M001/S02', scope: 'performance',
      decision: 'use WAL', choice: 'WAL', rationale: 'concurrent',
      revisable: 'no', superseded_by: null,
    },
  ]);

  // Should be a markdown table
  assertMatch(result, /^\| # \| When \| Scope/, 'has table header');
  assertMatch(result, /\|---\|/, 'has separator row');
  assertMatch(result, /\| D001 \|/, 'has D001 row');
  assertMatch(result, /\| D002 \|/, 'has D002 row');
  const lines = result.split('\n');
  assertEq(lines.length, 4, 'table has 4 lines (header + separator + 2 rows)');
}

// ═══════════════════════════════════════════════════════════════════════════
// context-store: format requirements
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== context-store: formatRequirementsForPrompt ===');
{
  const empty = formatRequirementsForPrompt([]);
  assertEq(empty, '', 'empty input returns empty string');

  const result = formatRequirementsForPrompt([
    {
      id: 'R001', class: 'functional', status: 'active',
      description: 'System must persist decisions', why: 'agent memory',
      source: 'M001', primary_owner: 'S01', supporting_slices: 'S02',
      validation: 'roundtrip test', notes: 'high priority',
      full_content: '', superseded_by: null,
    },
    {
      id: 'R002', class: 'non-functional', status: 'active',
      description: 'Sub-5ms query latency', why: 'prompt injection speed',
      source: 'M001', primary_owner: 'S01', supporting_slices: '',
      validation: 'timing test', notes: '',
      full_content: '', superseded_by: null,
    },
  ]);

  assertMatch(result, /### R001: System must persist decisions/, 'has R001 section header');
  assertMatch(result, /### R002: Sub-5ms query latency/, 'has R002 section header');
  assertMatch(result, /\*\*Class:\*\* functional/, 'has class field');
  assertMatch(result, /\*\*Status:\*\* active/, 'has status field');
  assertMatch(result, /\*\*Supporting Slices:\*\* S02/, 'has supporting slices when present');
  // R002 has no supporting_slices — should not have that line
  // R002 has no notes — should not have notes line
  const r002Section = result.split('### R002')[1] || '';
  assertTrue(!r002Section.includes('**Supporting Slices:**'), 'no supporting slices line when empty');
  assertTrue(!r002Section.includes('**Notes:**'), 'no notes line when empty');
}

// ═══════════════════════════════════════════════════════════════════════════
// context-store: sub-5ms timing assertion
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== context-store: sub-5ms query timing ===');
{
  openDatabase(':memory:');

  // Insert 50 decisions
  for (let i = 1; i <= 50; i++) {
    const id = `D${String(i).padStart(3, '0')}`;
    insertDecision({
      id,
      when_context: `M00${(i % 3) + 1}/S0${(i % 5) + 1}`,
      scope: i % 2 === 0 ? 'architecture' : 'performance',
      decision: `decision ${i}`,
      choice: `choice ${i}`,
      rationale: `rationale ${i}`,
      revisable: i % 3 === 0 ? 'no' : 'yes',
      superseded_by: null,
    });
  }

  // Insert 50 requirements
  for (let i = 1; i <= 50; i++) {
    const id = `R${String(i).padStart(3, '0')}`;
    insertRequirement({
      id,
      class: i % 2 === 0 ? 'functional' : 'non-functional',
      status: i % 4 === 0 ? 'validated' : 'active',
      description: `requirement ${i}`,
      why: `why ${i}`,
      source: 'M001',
      primary_owner: `S0${(i % 5) + 1}`,
      supporting_slices: i % 3 === 0 ? 'S01, S02' : '',
      validation: `validation ${i}`,
      notes: '',
      full_content: '',
      superseded_by: null,
    });
  }

  // Time the queries — warm up first
  queryDecisions();
  queryRequirements();

  const start = performance.now();
  const decisions = queryDecisions();
  const requirements = queryRequirements();
  const elapsed = performance.now() - start;

  assertTrue(decisions.length === 50, `got ${decisions.length} decisions (expected 50)`);
  assertTrue(requirements.length === 50, `got ${requirements.length} requirements (expected 50)`);
  assertTrue(elapsed < 5, `query latency ${elapsed.toFixed(2)}ms should be < 5ms`);
  console.log(`  timing: ${elapsed.toFixed(2)}ms for 50+50 row queries`);

  closeDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// context-store: queryArtifact
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== context-store: queryArtifact returns content for existing path ===');
{
  openDatabase(':memory:');

  insertArtifact({
    path: 'PROJECT.md',
    artifact_type: 'project',
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: '# My Project\n\nProject description here.',
  });
  insertArtifact({
    path: '.gsd/milestones/M001/M001-PLAN.md',
    artifact_type: 'milestone_plan',
    milestone_id: 'M001',
    slice_id: null,
    task_id: null,
    full_content: '# M001 Plan\n\nMilestone content.',
  });

  const project = queryArtifact('PROJECT.md');
  assertEq(project, '# My Project\n\nProject description here.', 'queryArtifact returns full_content for PROJECT.md');

  const plan = queryArtifact('.gsd/milestones/M001/M001-PLAN.md');
  assertEq(plan, '# M001 Plan\n\nMilestone content.', 'queryArtifact returns full_content for milestone plan');

  closeDatabase();
}

console.log('\n=== context-store: queryArtifact returns null for missing path ===');
{
  openDatabase(':memory:');

  const missing = queryArtifact('nonexistent.md');
  assertEq(missing, null, 'queryArtifact returns null for path not in DB');

  closeDatabase();
}

console.log('\n=== context-store: queryArtifact returns null when DB unavailable ===');
{
  closeDatabase();
  assertTrue(!isDbAvailable(), 'DB should not be available');

  const result = queryArtifact('PROJECT.md');
  assertEq(result, null, 'queryArtifact returns null when DB closed');
}

// ═══════════════════════════════════════════════════════════════════════════
// context-store: queryProject
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== context-store: queryProject returns PROJECT.md content ===');
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
  assertEq(content, '# Test Project\n\nThis is the project description.', 'queryProject returns PROJECT.md content');

  closeDatabase();
}

console.log('\n=== context-store: queryProject returns null when no PROJECT.md ===');
{
  openDatabase(':memory:');

  const content = queryProject();
  assertEq(content, null, 'queryProject returns null when PROJECT.md not imported');

  closeDatabase();
}

console.log('\n=== context-store: queryProject returns null when DB unavailable ===');
{
  closeDatabase();
  assertTrue(!isDbAvailable(), 'DB should not be available');

  const content = queryProject();
  assertEq(content, null, 'queryProject returns null when DB closed');
}

// ─── Final Report ──────────────────────────────────────────────────────────
report();
