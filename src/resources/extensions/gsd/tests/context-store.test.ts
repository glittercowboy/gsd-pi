import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
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
  formatRoadmapExcerpt,
  queryKnowledge,
} from '../context-store.ts';

// ═══════════════════════════════════════════════════════════════════════════
// context-store: fallback when DB not open
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: fallback when DB not open", () => {
  test("returns empty when DB not open", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), 'DB should not be available');

    const d = queryDecisions();
    assert.deepStrictEqual(d, [], 'queryDecisions returns [] when DB closed');

    const r = queryRequirements();
    assert.deepStrictEqual(r, [], 'queryRequirements returns [] when DB closed');

    const df = queryDecisions({ milestoneId: 'M001' });
    assert.deepStrictEqual(df, [], 'queryDecisions with opts returns [] when DB closed');

    const rf = queryRequirements({ sliceId: 'S01' });
    assert.deepStrictEqual(rf, [], 'queryRequirements with opts returns [] when DB closed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// context-store: query decisions
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: query decisions", () => {
  afterEach(() => closeDatabase());

  test("query all active decisions", () => {
    openDatabase(':memory:');

    insertDecision({
      id: 'D001', when_context: 'M001/S01', scope: 'architecture',
      decision: 'use SQLite', choice: 'node:sqlite', rationale: 'built-in',
      revisable: 'yes', made_by: 'agent', superseded_by: 'D003', // superseded!
    });
    insertDecision({
      id: 'D002', when_context: 'M001/S01', scope: 'architecture',
      decision: 'use WAL mode', choice: 'WAL', rationale: 'concurrent reads',
      revisable: 'no', made_by: 'agent', superseded_by: null,
    });
    insertDecision({
      id: 'D003', when_context: 'M002/S01', scope: 'performance',
      decision: 'use better-sqlite3', choice: 'better-sqlite3', rationale: 'faster',
      revisable: 'yes', made_by: 'agent', superseded_by: null,
    });

    const all = queryDecisions();
    assert.strictEqual(all.length, 2, 'query all active decisions returns 2 (superseded excluded)');
    const ids = all.map(d => d.id);
    assert.ok(ids.includes('D002'), 'D002 should be in active results');
    assert.ok(ids.includes('D003'), 'D003 should be in active results');
    assert.ok(!ids.includes('D001'), 'D001 (superseded) should NOT be in active results');
  });

  test("query decisions by milestone", () => {
    openDatabase(':memory:');

    insertDecision({
      id: 'D001', when_context: 'M001/S01', scope: 'architecture',
      decision: 'decision A', choice: 'A', rationale: 'r', revisable: 'yes',
      made_by: 'agent',
      superseded_by: null,
    });
    insertDecision({
      id: 'D002', when_context: 'M002/S02', scope: 'architecture',
      decision: 'decision B', choice: 'B', rationale: 'r', revisable: 'yes',
      made_by: 'agent',
      superseded_by: null,
    });

    const m1 = queryDecisions({ milestoneId: 'M001' });
    assert.strictEqual(m1.length, 1, 'milestone filter M001 returns 1');
    assert.strictEqual(m1[0]?.id, 'D001', 'milestone filter returns D001');

    const m2 = queryDecisions({ milestoneId: 'M002' });
    assert.strictEqual(m2.length, 1, 'milestone filter M002 returns 1');
    assert.strictEqual(m2[0]?.id, 'D002', 'milestone filter returns D002');
  });

  test("query decisions by scope", () => {
    openDatabase(':memory:');

    insertDecision({
      id: 'D001', when_context: 'M001/S01', scope: 'architecture',
      decision: 'decision A', choice: 'A', rationale: 'r', revisable: 'yes',
      made_by: 'agent',
      superseded_by: null,
    });
    insertDecision({
      id: 'D002', when_context: 'M001/S01', scope: 'performance',
      decision: 'decision B', choice: 'B', rationale: 'r', revisable: 'yes',
      made_by: 'agent',
      superseded_by: null,
    });

    const arch = queryDecisions({ scope: 'architecture' });
    assert.strictEqual(arch.length, 1, 'scope filter architecture returns 1');
    assert.strictEqual(arch[0]?.id, 'D001', 'scope filter returns D001');

    const perf = queryDecisions({ scope: 'performance' });
    assert.strictEqual(perf.length, 1, 'scope filter performance returns 1');
    assert.strictEqual(perf[0]?.id, 'D002', 'scope filter returns D002');

    const none = queryDecisions({ scope: 'nonexistent' });
    assert.strictEqual(none.length, 0, 'scope filter nonexistent returns 0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// context-store: query requirements
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: query requirements", () => {
  afterEach(() => closeDatabase());

  test("query all active requirements", () => {
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
    assert.strictEqual(all.length, 2, 'query all active requirements returns 2 (superseded excluded)');
    const ids = all.map(r => r.id);
    assert.ok(ids.includes('R002'), 'R002 should be active');
    assert.ok(ids.includes('R003'), 'R003 should be active');
    assert.ok(!ids.includes('R001'), 'R001 (superseded) should NOT be active');
  });

  test("query requirements by slice", () => {
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
    assert.strictEqual(s01.length, 2, 'slice filter S01 returns 2 (primary + supporting)');
    const s01ids = s01.map(r => r.id).sort();
    assert.deepStrictEqual(s01ids, ['R001', 'R002'], 'S01 owns R001 and supports R002');

    const s03 = queryRequirements({ sliceId: 'S03' });
    assert.strictEqual(s03.length, 1, 'slice filter S03 returns 1');
    assert.strictEqual(s03[0]?.id, 'R003', 'S03 owns R003');
  });

  test("query requirements by status", () => {
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
    assert.strictEqual(active.length, 1, 'status filter active returns 1');
    assert.strictEqual(active[0]?.id, 'R001', 'active returns R001');

    const validated = queryRequirements({ status: 'validated' });
    assert.strictEqual(validated.length, 1, 'status filter validated returns 1');
    assert.strictEqual(validated[0]?.id, 'R002', 'validated returns R002');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// context-store: format decisions
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: formatDecisionsForPrompt", () => {
  test("empty input returns empty string", () => {
    const empty = formatDecisionsForPrompt([]);
    assert.strictEqual(empty, '', 'empty input returns empty string');
  });

  test("formats decisions as markdown table", () => {
    const result = formatDecisionsForPrompt([
      {
        seq: 1, id: 'D001', when_context: 'M001/S01', scope: 'architecture',
        decision: 'use SQLite', choice: 'node:sqlite', rationale: 'built-in',
        revisable: 'yes', made_by: 'agent', superseded_by: null,
      },
      {
        seq: 2, id: 'D002', when_context: 'M001/S02', scope: 'performance',
        decision: 'use WAL', choice: 'WAL', rationale: 'concurrent',
        revisable: 'no', made_by: 'human', superseded_by: null,
      },
    ]);

    // Should be a markdown table
    assert.match(result, /^\| # \| When \| Scope/, 'has table header');
    assert.match(result, /\|---\|/, 'has separator row');
    assert.match(result, /\| D001 \|/, 'has D001 row');
    assert.match(result, /\| D002 \|/, 'has D002 row');
    const lines = result.split('\n');
    assert.strictEqual(lines.length, 4, 'table has 4 lines (header + separator + 2 rows)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// context-store: format requirements
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: formatRequirementsForPrompt", () => {
  test("empty input returns empty string", () => {
    const empty = formatRequirementsForPrompt([]);
    assert.strictEqual(empty, '', 'empty input returns empty string');
  });

  test("formats requirements as markdown sections", () => {
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

    assert.match(result, /### R001: System must persist decisions/, 'has R001 section header');
    assert.match(result, /### R002: Sub-5ms query latency/, 'has R002 section header');
    assert.match(result, /\*\*Class:\*\* functional/, 'has class field');
    assert.match(result, /\*\*Status:\*\* active/, 'has status field');
    assert.match(result, /\*\*Supporting Slices:\*\* S02/, 'has supporting slices when present');
    // R002 has no supporting_slices — should not have that line
    // R002 has no notes — should not have notes line
    const r002Section = result.split('### R002')[1] || '';
    assert.ok(!r002Section.includes('**Supporting Slices:**'), 'no supporting slices line when empty');
    assert.ok(!r002Section.includes('**Notes:**'), 'no notes line when empty');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// context-store: sub-5ms timing assertion
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: sub-5ms query timing", () => {
  afterEach(() => closeDatabase());

  test("queries complete under 5ms for 50+50 rows", () => {
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
        made_by: 'agent',
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

    assert.strictEqual(decisions.length, 50, `got ${decisions.length} decisions (expected 50)`);
    assert.strictEqual(requirements.length, 50, `got ${requirements.length} requirements (expected 50)`);
    assert.ok(elapsed < 5, `query latency ${elapsed.toFixed(2)}ms should be < 5ms`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// context-store: queryArtifact
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: queryArtifact", () => {
  afterEach(() => closeDatabase());

  test("returns content for existing path", () => {
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
    assert.strictEqual(project, '# My Project\n\nProject description here.', 'queryArtifact returns full_content for PROJECT.md');

    const plan = queryArtifact('.gsd/milestones/M001/M001-PLAN.md');
    assert.strictEqual(plan, '# M001 Plan\n\nMilestone content.', 'queryArtifact returns full_content for milestone plan');
  });

  test("returns null for missing path", () => {
    openDatabase(':memory:');

    const missing = queryArtifact('nonexistent.md');
    assert.strictEqual(missing, null, 'queryArtifact returns null for path not in DB');
  });

  test("returns null when DB unavailable", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), 'DB should not be available');

    const result = queryArtifact('PROJECT.md');
    assert.strictEqual(result, null, 'queryArtifact returns null when DB closed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// context-store: queryProject
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: queryProject", () => {
  afterEach(() => closeDatabase());

  test("returns PROJECT.md content", () => {
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
    assert.strictEqual(content, '# Test Project\n\nThis is the project description.', 'queryProject returns PROJECT.md content');
  });

  test("returns null when no PROJECT.md", () => {
    openDatabase(':memory:');

    const content = queryProject();
    assert.strictEqual(content, null, 'queryProject returns null when PROJECT.md not imported');
  });

  test("returns null when DB unavailable", () => {
    closeDatabase();
    assert.ok(!isDbAvailable(), 'DB should not be available');

    const content = queryProject();
    assert.strictEqual(content, null, 'queryProject returns null when DB closed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// context-store: formatRoadmapExcerpt
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: formatRoadmapExcerpt", () => {
  // Sample roadmap content matching actual M005-ROADMAP.md format
  const sampleRoadmap = `# M005: Tiered Context Injection

## Vision
Refactor prompt builders to inject relevance-scoped context.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Scope existing queries | low | — | ✅ | planSlice prompt scoped. |
| S02 | KNOWLEDGE scoping | medium | S01 | ⬜ | KNOWLEDGE sections filtered. |
| S03 | Measurement test | low | S02 | ⬜ | 40% reduction confirmed. |
`;

  test("S02 with S01 predecessor includes both rows", () => {
    const result = formatRoadmapExcerpt(sampleRoadmap, 'S02', '.gsd/milestones/M005/M005-ROADMAP.md');

    // Should have header
    assert.match(result, /\| ID \| Slice \| Risk \| Depends \| Done \| After this \|/, 'has header row');
    // Should have separator
    assert.match(result, /\|----\|/, 'has separator row');
    // Should have S01 predecessor
    assert.match(result, /\| S01 \|/, 'has predecessor S01 row');
    // Should have S02 target
    assert.match(result, /\| S02 \|/, 'has target S02 row');
    // Should have reference directive
    assert.match(result, /See full roadmap:.*M005-ROADMAP\.md/, 'has reference directive');
    // Should NOT have S03 (not relevant)
    assert.ok(!result.includes('| S03 |'), 'does not include unrelated S03');
  });

  test("S01 with no predecessor includes only target row", () => {
    const result = formatRoadmapExcerpt(sampleRoadmap, 'S01');

    // Should have header + separator + S01 only
    assert.match(result, /\| ID \| Slice \|/, 'has header row');
    assert.match(result, /\| S01 \|/, 'has target S01 row');
    // Should NOT have S02 or S03
    assert.ok(!result.includes('| S02 |'), 'does not include S02');
    assert.ok(!result.includes('| S03 |'), 'does not include S03');
    // Should have reference
    assert.match(result, /See full roadmap:/, 'has reference directive');

    // Count rows: header + separator + S01 + blank + directive = 5 lines
    const lines = result.split('\n');
    assert.strictEqual(lines.length, 5, 'correct number of lines (no predecessor)');
  });

  test("missing slice returns empty string", () => {
    const result = formatRoadmapExcerpt(sampleRoadmap, 'S99');

    assert.strictEqual(result, '', 'missing slice returns empty string');
  });

  test("empty input returns empty string", () => {
    assert.strictEqual(formatRoadmapExcerpt('', 'S01'), '', 'empty content returns empty');
    assert.strictEqual(formatRoadmapExcerpt(sampleRoadmap, ''), '', 'empty sliceId returns empty');
  });

  test("handles table with various column formats", () => {
    // Table with different spacing and content
    const variantRoadmap = `# Milestone

| ID | Slice | Risk | Depends | Done | After this |
|:---|:------|:-----|:--------|:-----|:-----------|
| S01 | First slice title | low | — | ✅ | First complete. |
| S02 | Second longer slice title here | medium | S01 | ⬜ | Second working. |
`;

    const result = formatRoadmapExcerpt(variantRoadmap, 'S02');

    assert.match(result, /\| S01 \|/, 'has predecessor with different spacing');
    assert.match(result, /\| S02 \|/, 'has target with different spacing');
    assert.match(result, /Second longer slice title/, 'preserves full slice title');
  });

  test("handles multiple dependencies by using first one", () => {
    const multiDepRoadmap = `| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | First | low | — | ✅ | Done. |
| S02 | Second | low | — | ✅ | Done. |
| S03 | Third | medium | S01, S02 | ⬜ | Working. |
`;

    const result = formatRoadmapExcerpt(multiDepRoadmap, 'S03');

    // Should include S01 (first dependency) and S03
    assert.match(result, /\| S01 \|/, 'has first dependency S01');
    assert.match(result, /\| S03 \|/, 'has target S03');
    // S02 is also a dependency but we only include the first one
    // (This is intentional to keep excerpts minimal)
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// context-store: queryKnowledge
// ═══════════════════════════════════════════════════════════════════════════

describe("context-store: queryKnowledge", () => {
  // Sample KNOWLEDGE.md content
  const sampleKnowledge = `# Project Knowledge

## Database Patterns
SQLite is used with WAL mode for concurrent reads.
Always use prepared statements.

More database details here.

## API Design
REST endpoints follow OpenAPI spec.
Use versioned paths like /v1/resource.

## Testing Guidelines
Unit tests use node:test.
Integration tests mock external services.
`;

  test("single keyword matches header", async () => {
    const result = await queryKnowledge(sampleKnowledge, ['database']);

    assert.match(result, /## Database Patterns/, 'includes matching section header');
    assert.match(result, /SQLite is used with WAL mode/, 'includes section content');
    // Should NOT include other sections
    assert.ok(!result.includes('## API Design'), 'does not include non-matching API section');
    assert.ok(!result.includes('## Testing Guidelines'), 'does not include non-matching Testing section');
  });

  test("multiple keywords match multiple sections", async () => {
    const result = await queryKnowledge(sampleKnowledge, ['database', 'testing']);

    assert.match(result, /## Database Patterns/, 'includes Database section');
    assert.match(result, /## Testing Guidelines/, 'includes Testing section');
    assert.ok(!result.includes('## API Design'), 'does not include API section');
  });

  test("no matches returns empty string", async () => {
    const result = await queryKnowledge(sampleKnowledge, ['nonexistent']);

    assert.strictEqual(result, '', 'no matches returns empty string per D020');
  });

  test("keyword in first paragraph matches", async () => {
    const result = await queryKnowledge(sampleKnowledge, ['sqlite']);

    // 'sqlite' appears in first paragraph of Database Patterns
    assert.match(result, /## Database Patterns/, 'matches keyword in first paragraph');
    assert.match(result, /SQLite is used/, 'includes the section with matching paragraph');
  });

  test("case-insensitive matching", async () => {
    const result = await queryKnowledge(sampleKnowledge, ['DATABASE', 'API']);

    assert.match(result, /## Database Patterns/, 'case-insensitive header match');
    assert.match(result, /## API Design/, 'case-insensitive header match for API');
  });

  test("empty keywords returns empty string", async () => {
    const result = await queryKnowledge(sampleKnowledge, []);

    assert.strictEqual(result, '', 'empty keywords returns empty string');
  });

  test("empty content returns empty string", async () => {
    const result = await queryKnowledge('', ['database']);

    assert.strictEqual(result, '', 'empty content returns empty string');
  });
});
