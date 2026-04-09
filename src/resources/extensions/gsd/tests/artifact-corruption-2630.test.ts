// GSD — regression tests for issue #2630
// Milestone/slice artifact rendering must not corrupt existing markdown.
// Three bugs: (A) milestone title double-prefix, (B) full_uat_md demo fallback,
// (C) STATE.md title double-prefix.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderPlanContent,
  renderRoadmapContent,
  renderStateContent,
} from '../workflow-projections.ts';
import type { SliceRow, TaskRow, MilestoneRow } from '../gsd-db.ts';
import type { GSDState } from '../types.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeSliceRow(overrides?: Partial<SliceRow>): SliceRow {
  return {
    milestone_id: 'M001',
    id: 'S04',
    title: 'Dependency-driven scene pipeline and state truth',
    status: 'complete',
    risk: 'high',
    depends: ['S03'],
    demo: '',
    created_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-15T00:00:00Z',
    full_summary_md: '',
    full_uat_md: `# S04: Dependency-driven scene pipeline and state truth — UAT

**Milestone:** M001
**Written:** 2026-01-15

## UAT Type: Functional

### Scenario 1: Pipeline processes dependencies
**Given** a scene with dependencies
**When** the pipeline runs
**Then** dependencies are resolved in order`,
    goal: 'Build dependency-driven scene pipeline',
    success_criteria: '',
    proof_level: '',
    integration_closure: '',
    observability_impact: '',
    sequence: 4,
    replan_triggered_at: null,
    ...overrides,
  };
}

function makeTaskRow(overrides?: Partial<TaskRow>): TaskRow {
  return {
    milestone_id: 'M001',
    slice_id: 'S04',
    id: 'T01',
    title: 'Test Task',
    status: 'done',
    one_liner: '',
    narrative: '',
    verification_result: '',
    duration: '',
    completed_at: null,
    blocker_discovered: false,
    deviations: '',
    known_issues: '',
    key_files: [],
    key_decisions: [],
    full_summary_md: '',
    full_plan_md: '',
    description: 'Test description',
    estimate: '30m',
    files: [],
    verify: 'npm test',
    inputs: [],
    expected_output: [],
    observability_impact: '',
    sequence: 0,
    ...overrides,
  };
}

function makeMilestoneRow(overrides?: Partial<MilestoneRow>): MilestoneRow {
  return {
    id: 'M001',
    title: 'Topic-to-pipeline foundation',
    status: 'active',
    depends_on: [],
    created_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    vision: 'Build the topic-to-pipeline foundation',
    success_criteria: [],
    key_risks: [],
    proof_strategy: [],
    verification_contract: '',
    verification_integration: '',
    verification_operational: '',
    verification_uat: '',
    definition_of_done: [],
    requirement_coverage: '',
    boundary_map_markdown: '',
    ...overrides,
  };
}

function makeGSDState(overrides?: Partial<GSDState>): GSDState {
  return {
    activeMilestone: { id: 'M001', title: 'Topic-to-pipeline foundation' },
    activeSlice: { id: 'S01', title: 'Auth Layer' },
    activeTask: null,
    phase: 'executing',
    recentDecisions: [],
    blockers: [],
    nextAction: 'Continue execution',
    registry: [],
    requirements: undefined,
    ...overrides,
  };
}

// ─── Bug A: milestone title double-prefix ────────────────────────────────
// When params.title already contains "M001: ", the H1 should NOT become
// "# M001: M001: Topic-to-pipeline foundation"

test('#2630 renderRoadmapContent: milestone title with pre-existing ID prefix renders without duplication', () => {
  const milestone = makeMilestoneRow({ title: 'M001: Topic-to-pipeline foundation' });
  const content = renderRoadmapContent(milestone, []);

  // The H1 must be exactly "# M001: Topic-to-pipeline foundation", not "# M001: M001: ..."
  assert.ok(
    content.includes('# M001: Topic-to-pipeline foundation'),
    `expected single prefix in H1, got: ${content.split('\n')[0]}`,
  );
  assert.ok(
    !content.includes('M001: M001:'),
    `found double prefix in roadmap H1: ${content.split('\n')[0]}`,
  );
});

test('#2630 renderStateContent: active milestone title with pre-existing ID prefix renders without duplication', () => {
  const state = makeGSDState({
    activeMilestone: { id: 'M001', title: 'M001: Topic-to-pipeline foundation' },
  });
  const content = renderStateContent(state);

  assert.ok(
    !content.includes('M001: M001:'),
    `found double prefix in STATE.md: ${content}`,
  );
  assert.ok(
    content.includes('**Active Milestone:** M001: Topic-to-pipeline foundation'),
    `expected single prefix, got: ${content}`,
  );
});

test('#2630 renderStateContent: registry entry with pre-existing ID prefix renders without duplication', () => {
  const state = makeGSDState({
    registry: [
      { id: 'M001', title: 'M001: Topic-to-pipeline foundation', status: 'active' },
    ],
  });
  const content = renderStateContent(state);

  assert.ok(
    !content.includes('M001: M001:'),
    `found double prefix in registry: ${content}`,
  );
});

// ─── Bug D: PLAN.md slice title double-prefix ──────────────────────────────
// When sliceRow.title already contains "S04: ", the H1 should NOT become
// "# S04: S04: Dependency-driven scene pipeline and state truth"

test('#2630 renderPlanContent: slice title with pre-existing ID prefix renders without duplication', () => {
  const slice = makeSliceRow({ title: 'S04: Dependency-driven scene pipeline and state truth' });
  const content = renderPlanContent(slice, []);

  // The H1 must be exactly "# S04: Dependency-driven scene pipeline and state truth"
  assert.ok(
    content.includes('# S04: Dependency-driven scene pipeline and state truth'),
    `expected single prefix in H1, got: ${content.split('\n')[0]}`,
  );
  assert.ok(
    !content.includes('S04: S04:'),
    `found double prefix in PLAN.md H1: ${content.split('\n')[0]}`,
  );
});

test('#2630 renderPlanContent: slice title without prefix still renders correctly', () => {
  const slice = makeSliceRow({ title: 'Dependency-driven scene pipeline and state truth' });
  const content = renderPlanContent(slice, []);

  assert.ok(
    content.startsWith('# S04: Dependency-driven scene pipeline and state truth'),
    `expected prefixed H1, got: ${content.split('\n')[0]}`,
  );
});

// ─── Bug B: full_uat_md as demo fallback ─────────────────────────────────
// When slice.demo is empty and full_uat_md is a multi-line UAT document,
// the renderers must NOT inject the entire UAT body.

test('#2630 renderPlanContent: empty demo must not inject full_uat_md body into plan', () => {
  const slice = makeSliceRow({ demo: '' });
  const content = renderPlanContent(slice, []);

  // The **Demo:** line must be a single line, not multi-line UAT content
  const demoLine = content.split('\n').find(l => l.startsWith('**Demo:**'));
  assert.ok(demoLine, 'should have a Demo line');

  // Must not contain UAT headings or body
  assert.ok(
    !content.includes('## UAT Type'),
    `plan contains UAT body content: ${content}`,
  );
  assert.ok(
    !content.includes('**Milestone:** M001'),
    `plan contains UAT metadata: ${content}`,
  );

  // The Demo line must not contain newlines (single line only)
  assert.ok(
    !demoLine!.includes('\n'),
    `Demo line must be single line, got: ${demoLine}`,
  );
});

test('#2630 renderPlanContent: null demo must not inject full_uat_md body into plan', () => {
  const slice = makeSliceRow({ demo: null as unknown as string });
  const content = renderPlanContent(slice, []);

  assert.ok(
    !content.includes('## UAT Type'),
    `plan contains UAT body content when demo is null`,
  );
});

test('#2630 renderRoadmapContent: empty demo must not inject full_uat_md into roadmap table', () => {
  const milestone = makeMilestoneRow();
  const slices = [makeSliceRow({ demo: '' })];

  const content = renderRoadmapContent(milestone, slices);

  // Roadmap table cell for "After this" must be single-line
  assert.ok(
    !content.includes('## UAT Type'),
    `roadmap contains UAT body content: ${content}`,
  );
  assert.ok(
    !content.includes('**Milestone:** M001'),
    `roadmap contains UAT metadata: ${content}`,
  );

  // The table row containing S04 must be a single line
  const s04Line = content.split('\n').find(l => l.includes('| S04 |'));
  assert.ok(s04Line, 'should have S04 table row');
  assert.ok(
    !s04Line!.includes('# S04:'),
    `roadmap table cell contains UAT heading: ${s04Line}`,
  );
});

test('#2630 renderRoadmapContent: null demo must not inject full_uat_md into roadmap table', () => {
  const milestone = makeMilestoneRow();
  const slices = [makeSliceRow({ demo: null as unknown as string })];

  const content = renderRoadmapContent(milestone, slices);

  assert.ok(
    !content.includes('## UAT Type'),
    `roadmap contains UAT body content when demo is null`,
  );
});

test('#2630 renderPlanContent: with valid demo string does not use full_uat_md', () => {
  const slice = makeSliceRow({ demo: 'Login flow works end-to-end' });
  const content = renderPlanContent(slice, []);

  assert.ok(
    content.includes('**Demo:** After this: Login flow works end-to-end'),
    `expected demo text, got: ${content}`,
  );
  assert.ok(
    !content.includes('UAT'),
    `should not contain UAT when demo is provided`,
  );
});
