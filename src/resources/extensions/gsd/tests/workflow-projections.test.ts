// GSD Extension — workflow-projections unit tests
// Tests the pure rendering functions (no DB required).

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPlanContent } from '../workflow-projections.ts';
import type { SliceRow, TaskRow } from '../gsd-db.ts';

// ─── Test fixtures ────────────────────────────────────────────────────────

function makeSlice(overrides: Partial<SliceRow> = {}): SliceRow {
  return {
    id: 'S01',
    milestone_id: 'M001',
    title: 'Auth Layer',
    status: 'active',
    risk: 'high',
    depends: [],
    demo: 'Login flow works end-to-end',
    goal: 'Implement JWT authentication',
    full_summary_md: '',
    full_uat_md: '',
    success_criteria: '',
    proof_level: '',
    integration_closure: '',
    observability_impact: '',
    created_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    sequence: 1,
    replan_triggered_at: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'T01',
    slice_id: 'S01',
    milestone_id: 'M001',
    title: 'Create JWT middleware',
    status: 'pending',
    description: 'Implement JWT validation middleware',
    estimate: '2h',
    files: ['src/middleware/auth.ts'],
    verify: 'npm test src/middleware/auth.test.ts',
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
    inputs: [],
    expected_output: [],
    observability_impact: '',
    sequence: 1,
    ...overrides,
  };
}

// ─── renderPlanContent: structure ────────────────────────────────────────

test('workflow-projections: renderPlanContent starts with H1 containing slice id and title', () => {
  const content = renderPlanContent(makeSlice(), []);
  assert.ok(content.startsWith('# S01: Auth Layer'), `expected H1, got: ${content.slice(0, 60)}`);
});

test('workflow-projections: renderPlanContent includes Goal line', () => {
  const content = renderPlanContent(makeSlice(), []);
  assert.ok(content.includes('**Goal:** Implement JWT authentication'));
});

test('workflow-projections: renderPlanContent includes Demo line', () => {
  const content = renderPlanContent(makeSlice(), []);
  assert.ok(content.includes('**Demo:** After this: Login flow works end-to-end'));
});

test('workflow-projections: renderPlanContent falls back to TBD when goal and full_summary_md are empty', () => {
  const slice = makeSlice({ goal: '', full_summary_md: '' });
  const content = renderPlanContent(slice, []);
  assert.ok(content.includes('**Goal:** TBD'));
});

test('workflow-projections: renderPlanContent falls back to TBD when goal is empty (full_summary_md ignored #2945)', () => {
  const slice = makeSlice({ goal: '', full_summary_md: 'Fallback goal text' });
  const content = renderPlanContent(slice, []);
  // #2945: full_summary_md is no longer used as a fallback — it contains
  // multi-line rendered markdown that corrupts single-line fields.
  assert.ok(content.includes('**Goal:** TBD'), `expected TBD fallback, got: ${content}`);
});

test('workflow-projections: renderPlanContent includes ## Tasks section', () => {
  const content = renderPlanContent(makeSlice(), []);
  assert.ok(content.includes('## Tasks'));
});

// ─── renderPlanContent: task checkboxes ──────────────────────────────────

test('workflow-projections: pending task renders with [ ] checkbox', () => {
  const task = makeTask({ status: 'pending' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('- [ ] **T01:'), `expected unchecked, got: ${content}`);
});

test('workflow-projections: done task renders with [x] checkbox', () => {
  const task = makeTask({ status: 'done' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('- [x] **T01:'), `expected checked, got: ${content}`);
});

test('workflow-projections: complete status renders with [x] checkbox', () => {
  const task = makeTask({ status: 'complete' }); // 'complete' and 'done' both → checked
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('- [x] **T01:'));
});

// ─── renderPlanContent: task sublines ────────────────────────────────────

test('workflow-projections: task with estimate renders Estimate subline', () => {
  const task = makeTask({ estimate: '2h' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('  - Estimate: 2h'));
});

test('workflow-projections: task with empty estimate omits Estimate subline', () => {
  const task = makeTask({ estimate: '' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(!content.includes('  - Estimate:'));
});

test('workflow-projections: task with files renders Files subline', () => {
  const task = makeTask({ files: ['src/auth.ts', 'src/auth.test.ts'] });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('  - Files: src/auth.ts, src/auth.test.ts'));
});

test('workflow-projections: task with empty files array omits Files subline', () => {
  const task = makeTask({ files: [] });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(!content.includes('  - Files:'));
});

test('workflow-projections: task with verify renders Verify subline', () => {
  const task = makeTask({ verify: 'npm test' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('  - Verify: npm test'));
});

test('workflow-projections: task with no verify omits Verify subline', () => {
  const task = makeTask({ verify: '' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(!content.includes('  - Verify:'));
});

test('workflow-projections: task with duration renders Duration subline', () => {
  const task = makeTask({ duration: '45m' });
  const content = renderPlanContent(makeSlice(), [task]);
  assert.ok(content.includes('  - Duration: 45m'));
});

test('workflow-projections: multiple tasks rendered in order', () => {
  const t1 = makeTask({ id: 'T01', title: 'First task', sequence: 1 });
  const t2 = makeTask({ id: 'T02', title: 'Second task', sequence: 2 });
  const content = renderPlanContent(makeSlice(), [t1, t2]);
  const idxT1 = content.indexOf('**T01:');
  const idxT2 = content.indexOf('**T02:');
  assert.ok(idxT1 < idxT2, 'T01 should appear before T02');
});
