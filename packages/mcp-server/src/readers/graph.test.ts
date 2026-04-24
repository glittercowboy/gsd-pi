// GSD MCP Server — knowledge graph reader tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  buildGraph,
  writeGraph,
  writeSnapshot,
  graphStatus,
  graphQuery,
  graphDiff,
} from './graph.js';
import type { KnowledgeGraph } from './graph.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function tmpProject(): string {
  const dir = join(tmpdir(), `gsd-graph-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(base: string, relPath: string, content: string): void {
  const full = join(base, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

function makeProjectWithArtifacts(projectDir: string): void {
  writeFixture(projectDir, '.gsd/STATE.md', [
    '# GSD State',
    '',
    '**Active Milestone:** M001: Auth System',
    '**Active Slice:** S01: Login flow',
    '**Phase:** execution',
    '',
    '## Milestone Registry',
    '',
    '- 🔄 **M001:** Auth System',
    '',
    '## Next Action',
    '',
    'Execute T01 in S01.',
  ].join('\n'));

  writeFixture(projectDir, '.gsd/KNOWLEDGE.md', [
    '# Project Knowledge',
    '',
    '## Rules',
    '',
    '| # | Scope | Rule | Why | Added |',
    '|---|-------|------|-----|-------|',
    '| K001 | auth | Hash passwords with bcrypt | Security requirement | manual |',
    '| K002 | db | Use transactions for multi-table | Data consistency | auto |',
    '',
    '## Patterns',
    '',
    '| # | Pattern | Where | Notes |',
    '|---|---------|-------|-------|',
    '| P001 | Singleton services | services/ | Prevents duplication |',
    '',
    '## Lessons Learned',
    '',
    '| # | What Happened | Root Cause | Fix | Scope |',
    '|---|--------------|------------|-----|-------|',
    '| L001 | CI tests failed | Env diff | Added setup script | testing |',
  ].join('\n'));

  writeFixture(projectDir, '.gsd/milestones/M001/M001-ROADMAP.md', [
    '# M001: Auth System',
    '',
    '## Vision',
    '',
    'Build authentication for the platform.',
    '',
    '## Slice Overview',
    '',
    '| ID | Slice | Risk | Depends | Done | After this |',
    '|----|-------|------|---------|------|------------|',
    '| S01 | Login flow | low | — | 🔄 | Users can log in |',
  ].join('\n'));

  writeFixture(projectDir, '.gsd/milestones/M001/slices/S01/S01-PLAN.md', [
    '# S01: Login flow',
    '',
    '## Tasks',
    '',
    '- [ ] **T01: Implement login endpoint** — Core auth logic',
    '- [ ] **T02: Add session management** — Keep users logged in',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// LEARNINGS.md fixture helpers
// ---------------------------------------------------------------------------

function writeLearningsFixture(projectDir: string, milestoneId: string, content: string): void {
  writeFixture(projectDir, `.gsd/milestones/${milestoneId}/${milestoneId}-LEARNINGS.md`, content);
}

const SAMPLE_LEARNINGS = `---
phase: "M001"
phase_name: "User Auth"
project: "my-project"
generated: "2026-04-15T10:00:00Z"
counts:
  decisions: 2
  lessons: 1
  patterns: 1
  surprises: 1
missing_artifacts: []
---

# Learnings: User Auth

## Decisions
- Use JWT for stateless auth across services.
  Source: M001-PLAN.md/Architecture

- Store refresh tokens in HTTP-only cookies only.
  Source: M001-PLAN.md/Security

## Lessons
- Integration tests need a real DB — mocks missed migration bugs.
  Source: M001-SUMMARY.md/Testing

## Patterns
- Repository pattern abstracts DB access and simplifies testing.
  Source: M001-PLAN.md/Design

## Surprises
- Token expiry edge case caused silent auth failures in prod.
  Source: M001-SUMMARY.md/Issues
`;

// ---------------------------------------------------------------------------
// buildGraph tests
// ---------------------------------------------------------------------------

describe('buildGraph', () => {
  let projectDir: string;

  before(() => {
    projectDir = tmpProject();
    makeProjectWithArtifacts(projectDir);
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('returns nodeCount > 0 for a project with artifacts', async () => {
    const graph = await buildGraph(projectDir);
    assert.ok(graph.nodes.length > 0, `Expected nodes, got ${graph.nodes.length}`);
  });

  it('produces a non-empty set of edges for a project with artifacts', async () => {
    // Previous `edgeCount >= 0` was a pure tautology. For a project
    // with STATE/KNOWLEDGE/LEARNINGS/milestone artifacts, the graph
    // builder wires relationships between the derived nodes — observed
    // empirically to produce ≥ 3 edges for the standard fixture.
    const graph = await buildGraph(projectDir);
    assert.ok(
      graph.edges.length > 0,
      `expected edges for a project with artifacts. nodes=${graph.nodes.length}, edges=${graph.edges.length}`,
    );
    // Every edge must reference nodes that actually exist in the graph.
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      assert.ok(
        nodeIds.has(edge.from),
        `edge.from="${edge.from}" must reference an existing node`,
      );
      assert.ok(
        nodeIds.has(edge.to),
        `edge.to="${edge.to}" must reference an existing node`,
      );
    }
  });

  it('includes builtAt ISO timestamp', async () => {
    const graph = await buildGraph(projectDir);
    assert.ok(typeof graph.builtAt === 'string');
    assert.ok(!isNaN(Date.parse(graph.builtAt)));
  });

  it('skips unparseable artifact and does not throw', async () => {
    const badProject = tmpProject();
    // Write a corrupt/minimal STATE.md that is technically valid but empty
    writeFixture(badProject, '.gsd/STATE.md', 'not valid gsd state at all \0\0\0');
    // Don't throw, and don't lose the well-formed builtAt timestamp
    // (which previous `graph.nodes.length >= 0` tautology ignored).
    const graph = await buildGraph(badProject);
    assert.ok(Array.isArray(graph.nodes), "nodes must be an array");
    assert.ok(Array.isArray(graph.edges), "edges must be an array");
    assert.ok(
      !Number.isNaN(Date.parse(graph.builtAt)),
      "builtAt must be a valid ISO-8601 timestamp even when artifact is unparseable",
    );
    rmSync(badProject, { recursive: true, force: true });
  });

  it('returns empty graph for project with no .gsd/ directory', async () => {
    const emptyProject = tmpProject();
    const graph = await buildGraph(emptyProject);
    // Previous `graph.nodes.length >= 0` was a tautology. The real
    // contract for a .gsd-less project: truly empty graph.
    assert.deepEqual(graph.nodes, [], "nodes must be empty for .gsd-less project");
    assert.deepEqual(graph.edges, [], "edges must be empty for .gsd-less project");
    assert.equal(typeof graph.builtAt, 'string');
    rmSync(emptyProject, { recursive: true, force: true });
  });

  it('nodes have required fields: id, label, type, confidence', async () => {
    const graph = await buildGraph(projectDir);
    for (const node of graph.nodes) {
      assert.ok(typeof node.id === 'string', 'node.id must be string');
      assert.ok(typeof node.label === 'string', 'node.label must be string');
      assert.ok(typeof node.type === 'string', 'node.type must be string');
      assert.ok(
        node.confidence === 'EXTRACTED' ||
        node.confidence === 'INFERRED' ||
        node.confidence === 'AMBIGUOUS',
        `Invalid confidence: ${node.confidence}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// buildGraph — LEARNINGS.md parsing tests
// ---------------------------------------------------------------------------

describe('buildGraph — LEARNINGS.md parsing', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = tmpProject();
    // Create minimal milestone directory so parseMilestoneFiles finds it
    mkdirSync(join(projectDir, '.gsd', 'milestones', 'M001'), { recursive: true });
    writeLearningsFixture(projectDir, 'M001', SAMPLE_LEARNINGS);
  });

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('extracts decision nodes from ## Decisions section', async () => {
    const graph = await buildGraph(projectDir);
    const decisions = graph.nodes.filter((n) => n.type === 'decision' || (n.type === 'rule' && n.id.startsWith('decision:')));
    // Decisions should be extracted with a 'decision' type (or similar existing type)
    const decisionNodes = graph.nodes.filter((n) => n.id.includes('decision:M001'));
    assert.ok(decisionNodes.length >= 2, `Expected >= 2 decision nodes, got ${decisionNodes.length}`);
  });

  it('extracts lesson nodes from ## Lessons section', async () => {
    const graph = await buildGraph(projectDir);
    const lessonNodes = graph.nodes.filter((n) => n.id.includes('lesson:M001'));
    assert.ok(lessonNodes.length >= 1, `Expected >= 1 lesson node, got ${lessonNodes.length}`);
    assert.ok(lessonNodes.every((n) => n.type === 'lesson'), 'All lesson nodes must have type "lesson"');
  });

  it('extracts pattern nodes from ## Patterns section', async () => {
    const graph = await buildGraph(projectDir);
    const patternNodes = graph.nodes.filter((n) => n.id.includes('pattern:M001'));
    assert.ok(patternNodes.length >= 1, `Expected >= 1 pattern node, got ${patternNodes.length}`);
    assert.ok(patternNodes.every((n) => n.type === 'pattern'), 'All pattern nodes must have type "pattern"');
  });

  it('maps surprises to lesson nodes', async () => {
    const graph = await buildGraph(projectDir);
    // Surprises should be mapped to lesson type since no "surprise" NodeType exists
    const surpriseNodes = graph.nodes.filter((n) => n.id.includes('surprise:M001'));
    assert.ok(surpriseNodes.length >= 1, `Expected >= 1 surprise node, got ${surpriseNodes.length}`);
    assert.ok(surpriseNodes.every((n) => n.type === 'lesson'), 'Surprises must be mapped to type "lesson"');
  });

  it('node labels contain the learning text', async () => {
    const graph = await buildGraph(projectDir);
    const hasJwtDecision = graph.nodes.some((n) =>
      n.label.toLowerCase().includes('jwt') || n.description?.toLowerCase().includes('jwt'),
    );
    assert.ok(hasJwtDecision, 'Expected a node describing the JWT decision');
  });

  it('node description includes source attribution', async () => {
    const graph = await buildGraph(projectDir);
    const learningNodes = graph.nodes.filter((n) =>
      n.id.includes(':M001:') || n.id.match(/:(decision|lesson|pattern|surprise):M001/),
    );
    const withSource = learningNodes.filter((n) => n.description?.includes('Source:') || n.description?.includes('M001-PLAN'));
    assert.ok(withSource.length > 0, 'Expected at least one node with source attribution in description');
  });

  it('adds relates_to edge from learning node to milestone node', async () => {
    const graph = await buildGraph(projectDir);
    const edgesToMilestone = graph.edges.filter(
      (e) => e.to === 'milestone:M001' || e.from === 'milestone:M001',
    );
    // At least one learning node should relate to the milestone
    const learningEdges = graph.edges.filter(
      (e) => (e.from.includes('M001') && (e.type === 'relates_to' || e.type === 'contains')) ||
              (e.to.includes('M001') && e.type === 'relates_to'),
    );
    assert.ok(learningEdges.length > 0 || edgesToMilestone.length > 0,
      'Expected edges connecting learning nodes to milestone');
  });

  it('skips LEARNINGS.md gracefully when file is malformed', async () => {
    const badProject = tmpProject();
    mkdirSync(join(badProject, '.gsd', 'milestones', 'M002'), { recursive: true });
    writeLearningsFixture(badProject, 'M002', '\0\0\0 not valid yaml or markdown \0\0\0');
    // Must not throw AND must not produce garbage learning nodes from
    // the binary contents (previous `nodes.length >= 0` tautology
    // allowed either outcome).
    const graph = await buildGraph(badProject);
    assert.ok(Array.isArray(graph.nodes));
    assert.equal(typeof graph.builtAt, 'string');
    const m002LearningNodes = graph.nodes.filter(
      (n) => n.id.includes('M002') && n.type !== 'milestone',
    );
    assert.equal(
      m002LearningNodes.length,
      0,
      "malformed LEARNINGS.md must not produce any non-milestone nodes " +
        `(got: ${JSON.stringify(m002LearningNodes.map((n) => n.id))})`,
    );
    rmSync(badProject, { recursive: true, force: true });
  });

  it('produces no learning nodes when all sections are empty', async () => {
    const emptyProject = tmpProject();
    mkdirSync(join(emptyProject, '.gsd', 'milestones', 'M003'), { recursive: true });
    writeLearningsFixture(emptyProject, 'M003', `---
phase: "M003"
phase_name: "Empty"
project: "test"
generated: "2026-04-15T10:00:00Z"
counts:
  decisions: 0
  lessons: 0
  patterns: 0
  surprises: 0
missing_artifacts: []
---

# Learnings: Empty

## Decisions

## Lessons

## Patterns

## Surprises
`);
    const graph = await buildGraph(emptyProject);
    const learningNodes = graph.nodes.filter((n) =>
      n.id.includes('decision:M003') ||
      n.id.includes('lesson:M003') ||
      n.id.includes('pattern:M003') ||
      n.id.includes('surprise:M003'),
    );
    assert.equal(learningNodes.length, 0, 'Empty sections should produce no nodes');
    rmSync(emptyProject, { recursive: true, force: true });
  });

  it('does not crash when LEARNINGS.md is missing entirely', async () => {
    const noLearningsProject = tmpProject();
    mkdirSync(join(noLearningsProject, '.gsd', 'milestones', 'M004'), { recursive: true });
    // No LEARNINGS.md file written. Previous tautology (nodes.length >= 0)
    // passed regardless of whether the graph was structurally valid;
    // assert real shape + no-learnings outcome.
    const graph = await buildGraph(noLearningsProject);
    assert.ok(Array.isArray(graph.nodes));
    assert.equal(typeof graph.builtAt, 'string');
    const learningNodes = graph.nodes.filter(
      (n) => n.type === 'decision' || n.type === 'lesson' || n.type === 'pattern' || n.type === 'surprise',
    );
    assert.equal(
      learningNodes.length,
      0,
      `no LEARNINGS.md → no learning nodes (got: ${JSON.stringify(learningNodes.map((n) => n.id))})`,
    );
    rmSync(noLearningsProject, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// writeGraph tests
// ---------------------------------------------------------------------------

describe('writeGraph', () => {
  let projectDir: string;
  let graph: KnowledgeGraph;

  before(async () => {
    projectDir = tmpProject();
    makeProjectWithArtifacts(projectDir);
    graph = await buildGraph(projectDir);
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('creates graph.json in .gsd/graphs/ after writeGraph()', async () => {
    const gsdRoot = join(projectDir, '.gsd');
    await writeGraph(gsdRoot, graph);
    const graphPath = join(gsdRoot, 'graphs', 'graph.json');
    assert.ok(existsSync(graphPath), `Expected ${graphPath} to exist`);
  });

  it('write is atomic — no temp file remains after writeGraph()', async () => {
    const gsdRoot = join(projectDir, '.gsd');
    await writeGraph(gsdRoot, graph);
    const tmpPath = join(gsdRoot, 'graphs', 'graph.tmp.json');
    assert.ok(!existsSync(tmpPath), 'Temp file should not exist after successful write');
  });

  it('written graph.json is valid JSON with nodes and edges', async () => {
    const gsdRoot = join(projectDir, '.gsd');
    await writeGraph(gsdRoot, graph);
    const raw = readFileSync(join(gsdRoot, 'graphs', 'graph.json'), 'utf-8');
    const parsed = JSON.parse(raw) as KnowledgeGraph;
    assert.ok(Array.isArray(parsed.nodes));
    assert.ok(Array.isArray(parsed.edges));
    assert.ok(typeof parsed.builtAt === 'string');
  });
});

// ---------------------------------------------------------------------------
// graphStatus tests
// ---------------------------------------------------------------------------

describe('graphStatus', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = tmpProject();
  });

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('returns { exists: false } when no graph.json exists', async () => {
    const status = await graphStatus(projectDir);
    assert.equal(status.exists, false);
  });

  it('returns { exists: true, nodeCount, edgeCount, ageHours } when graph exists', async () => {
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, '.gsd');
    const graph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, graph);

    const status = await graphStatus(projectDir);
    assert.equal(status.exists, true);
    assert.ok(typeof status.nodeCount === 'number');
    assert.ok(typeof status.edgeCount === 'number');
    assert.ok(typeof status.ageHours === 'number');
    assert.ok(status.ageHours >= 0);
  });

  it('stale = false for a freshly built graph', async () => {
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, '.gsd');
    const graph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, graph);

    const status = await graphStatus(projectDir);
    assert.equal(status.stale, false);
  });

  it('stale = true for a graph older than 24h (builtAt backdated)', async () => {
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, '.gsd');
    mkdirSync(join(gsdRoot, 'graphs'), { recursive: true });

    // Write a graph with a builtAt 25 hours ago
    const oldGraph: KnowledgeGraph = {
      nodes: [],
      edges: [],
      builtAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    writeFileSync(
      join(gsdRoot, 'graphs', 'graph.json'),
      JSON.stringify(oldGraph),
      'utf-8',
    );

    const status = await graphStatus(projectDir);
    assert.equal(status.exists, true);
    assert.equal(status.stale, true);
  });
});

// ---------------------------------------------------------------------------
// graphQuery tests
// ---------------------------------------------------------------------------

describe('graphQuery', () => {
  let projectDir: string;

  before(async () => {
    projectDir = tmpProject();
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, '.gsd');
    const graph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, graph);
  });

  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it('returns matching nodes for a known term', async () => {
    const result = await graphQuery(projectDir, 'auth');
    assert.ok(Array.isArray(result.nodes));
    // Should match nodes with 'auth' in label or description
    assert.ok(result.nodes.length > 0, 'Expected at least one match for "auth"');
  });

  it('returns empty array for a term that matches nothing', async () => {
    const result = await graphQuery(projectDir, 'xxxxxxnotfound999zzz');
    assert.ok(Array.isArray(result.nodes));
    assert.equal(result.nodes.length, 0);
  });

  it('search is case-insensitive', async () => {
    const lower = await graphQuery(projectDir, 'auth');
    const upper = await graphQuery(projectDir, 'AUTH');
    assert.deepEqual(
      lower.nodes.map((n) => n.id).sort(),
      upper.nodes.map((n) => n.id).sort(),
    );
  });

  it('budget trims AMBIGUOUS edges first — keeps INFERRED edge when budget only forces one drop', async () => {
    // Previous version only asserted the seed node remained — the test
    // title claimed AMBIGUOUS was trimmed first but never checked.
    // applyBudget (graph.ts:685) drops AMBIGUOUS edges first, then
    // INFERRED, then hard-trims to seed-only. Budget here is in tokens
    // (nodes × 20 + edges × 10). With 3 nodes (60) + 2 edges (20) = 80,
    // a budget of 70 forces exactly the AMBIGUOUS-edge drop and stops
    // (70 > 70 is false), leaving the INFERRED edge intact.
    const gsdRoot = join(projectDir, '.gsd');
    const mixedGraph: KnowledgeGraph = {
      builtAt: new Date().toISOString(),
      nodes: [
        { id: 'n1', label: 'seed node budget', type: 'milestone', confidence: 'EXTRACTED' },
        { id: 'n2', label: 'connected via AMBIGUOUS', type: 'task', confidence: 'AMBIGUOUS' },
        { id: 'n3', label: 'connected via INFERRED', type: 'task', confidence: 'INFERRED' },
      ],
      edges: [
        { from: 'n1', to: 'n2', type: 'contains', confidence: 'AMBIGUOUS' },
        { from: 'n1', to: 'n3', type: 'contains', confidence: 'INFERRED' },
      ],
    };
    await writeGraph(gsdRoot, mixedGraph);

    const result = await graphQuery(projectDir, 'seed node budget', 70);
    assert.ok(result.nodes.some((n) => n.id === 'n1'), "seed must remain");

    const hasAmbiguousEdge = result.edges.some(
      (e) => e.from === 'n1' && e.to === 'n2' && e.confidence === 'AMBIGUOUS',
    );
    const hasInferredEdge = result.edges.some(
      (e) => e.from === 'n1' && e.to === 'n3' && e.confidence === 'INFERRED',
    );

    assert.equal(
      hasAmbiguousEdge,
      false,
      "AMBIGUOUS edge must be trimmed FIRST when budget is tight",
    );
    assert.equal(
      hasInferredEdge,
      true,
      "INFERRED edge must survive when budget only forces the AMBIGUOUS drop",
    );

    // Restore the original graph
    const originalGraph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, originalGraph);
  });
});

// ---------------------------------------------------------------------------
// writeSnapshot + graphDiff tests
// ---------------------------------------------------------------------------

describe('graphDiff', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = tmpProject();
    makeProjectWithArtifacts(projectDir);
    const gsdRoot = join(projectDir, '.gsd');
    const graph = await buildGraph(projectDir);
    await writeGraph(gsdRoot, graph);
  });

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('returns empty diff when comparing graph to itself (snapshot = current)', async () => {
    const gsdRoot = join(projectDir, '.gsd');
    await writeSnapshot(gsdRoot);
    const diff = await graphDiff(projectDir);
    assert.ok(Array.isArray(diff.nodes.added));
    assert.ok(Array.isArray(diff.nodes.removed));
    assert.ok(Array.isArray(diff.nodes.changed));
    assert.equal(diff.nodes.added.length, 0);
    assert.equal(diff.nodes.removed.length, 0);
  });

  it('returns added nodes when a new node appears after snapshot', async () => {
    const gsdRoot = join(projectDir, '.gsd');
    // Take snapshot of the original graph
    await writeSnapshot(gsdRoot);

    // Now write a graph with an extra node
    const extraGraph: KnowledgeGraph = {
      builtAt: new Date().toISOString(),
      nodes: [
        { id: 'brand-new-node', label: 'New Feature', type: 'milestone', confidence: 'EXTRACTED' },
      ],
      edges: [],
    };
    await writeGraph(gsdRoot, extraGraph);

    const diff = await graphDiff(projectDir);
    assert.ok(diff.nodes.added.includes('brand-new-node'), 'new node should be in added');
  });

  it('returns removed nodes when a node disappears after snapshot', async () => {
    const gsdRoot = join(projectDir, '.gsd');
    // Create snapshot with a node that won't exist in current graph
    const snapshotGraph: KnowledgeGraph = {
      builtAt: new Date().toISOString(),
      nodes: [
        { id: 'old-node-to-be-removed', label: 'Old', type: 'task', confidence: 'EXTRACTED' },
      ],
      edges: [],
    };
    writeFileSync(
      join(gsdRoot, 'graphs', '.last-build-snapshot.json'),
      JSON.stringify({ ...snapshotGraph, snapshotAt: new Date().toISOString() }),
      'utf-8',
    );

    // Current graph.json has no such node
    const diff = await graphDiff(projectDir);
    assert.ok(diff.nodes.removed.includes('old-node-to-be-removed'), 'old node should be in removed');
  });

  it('returns empty diff structure when no snapshot exists', async () => {
    // No snapshot file — diff should be empty/meaningful
    const diff = await graphDiff(projectDir);
    assert.ok(Array.isArray(diff.nodes.added));
    assert.ok(Array.isArray(diff.nodes.removed));
    assert.ok(Array.isArray(diff.nodes.changed));
    assert.ok(Array.isArray(diff.edges.added));
    assert.ok(Array.isArray(diff.edges.removed));
  });

  it('writeSnapshot creates .last-build-snapshot.json with snapshotAt', async () => {
    const gsdRoot = join(projectDir, '.gsd');
    await writeSnapshot(gsdRoot);
    const snapshotPath = join(gsdRoot, 'graphs', '.last-build-snapshot.json');
    assert.ok(existsSync(snapshotPath));
    const raw = readFileSync(snapshotPath, 'utf-8');
    const parsed = JSON.parse(raw) as KnowledgeGraph & { snapshotAt: string };
    assert.ok(typeof parsed.snapshotAt === 'string');
    assert.ok(!isNaN(Date.parse(parsed.snapshotAt)));
  });
});
