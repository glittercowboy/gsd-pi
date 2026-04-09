// GSD — projection renderer regression tests
// Verifies that "done" vs "complete" status mismatch doesn't recur.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPlanContent, renderRoadmapContent } from '../workflow-projections.ts';
import type { SliceRow, TaskRow } from '../gsd-db.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeSliceRow(overrides?: Partial<SliceRow>): SliceRow {
  return {
    milestone_id: 'M001',
    id: 'S01',
    title: 'Test Slice',
    status: 'pending',
    risk: 'medium',
    depends: [],
    demo: 'Demo.',
    created_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    full_summary_md: '',
    full_uat_md: '',
    goal: 'Test goal',
    success_criteria: '',
    proof_level: '',
    integration_closure: '',
    observability_impact: '',
    sequence: 0,
    replan_triggered_at: null,
    ...overrides,
  };
}

function makeTaskRow(overrides?: Partial<TaskRow>): TaskRow {
  return {
    milestone_id: 'M001',
    slice_id: 'S01',
    id: 'T01',
    title: 'Test Task',
    status: 'pending',
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
    files: ['src/test.ts'],
    verify: 'npm test',
    inputs: [],
    expected_output: [],
    observability_impact: '',
    sequence: 0,
    ...overrides,
  };
}

function makeMilestoneRow() {
  return {
    id: 'M001',
    title: 'Test Milestone',
    status: 'active',
    depends_on: [],
    created_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    vision: 'Test vision',
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
  };
}

// ─── renderPlanContent: checkbox regression ──────────────────────────────

test('renderPlanContent: task with status "complete" renders [x] checkbox', () => {
  const slice = makeSliceRow();
  const tasks = [makeTaskRow({ id: 'T01', status: 'complete', title: 'Completed Task' })];

  const content = renderPlanContent(slice, tasks);

  assert.match(content, /\[x\]\s+\*\*T01:/, 'complete task should have [x] checkbox');
});

test('renderPlanContent: task with status "done" renders [x] checkbox', () => {
  const slice = makeSliceRow();
  const tasks = [makeTaskRow({ id: 'T01', status: 'done', title: 'Done Task' })];

  const content = renderPlanContent(slice, tasks);

  assert.match(content, /\[x\]\s+\*\*T01:/, 'done task should have [x] checkbox');
});

test('renderPlanContent: task with status "pending" renders [ ] checkbox', () => {
  const slice = makeSliceRow();
  const tasks = [makeTaskRow({ id: 'T01', status: 'pending', title: 'Pending Task' })];

  const content = renderPlanContent(slice, tasks);

  assert.match(content, /\[ \]\s+\*\*T01:/, 'pending task should have [ ] checkbox');
});

test('renderPlanContent: mixed statuses render correct checkboxes', () => {
  const slice = makeSliceRow();
  const tasks = [
    makeTaskRow({ id: 'T01', status: 'complete', title: 'Done One' }),
    makeTaskRow({ id: 'T02', status: 'pending', title: 'Pending One' }),
    makeTaskRow({ id: 'T03', status: 'done', title: 'Done Two' }),
  ];

  const content = renderPlanContent(slice, tasks);

  assert.match(content, /\[x\]\s+\*\*T01:/, 'T01 (complete) should be checked');
  assert.match(content, /\[ \]\s+\*\*T02:/, 'T02 (pending) should be unchecked');
  assert.match(content, /\[x\]\s+\*\*T03:/, 'T03 (done) should be checked');
});

// ─── renderPlanContent: format regression (parsePlan compatibility) ──────

test('renderPlanContent: format matches parsePlan regex **ID: title**', () => {
  const slice = makeSliceRow();
  const tasks = [makeTaskRow({ id: 'T01', status: 'pending', title: 'My Task' })];

  const content = renderPlanContent(slice, tasks);

  // parsePlan expects: **T01: My Task** (both ID and title inside bold)
  // NOT: **T01:** My Task (only ID in bold)
  assert.match(content, /\*\*T01: My Task\*\*/, 'ID and title should both be inside bold markers');
});

// ─── renderRoadmapContent: status regression ─────────────────────────────

test('renderRoadmapContent: slice with status "complete" shows ✅', () => {
  const milestone = makeMilestoneRow();
  const slices = [makeSliceRow({ id: 'S01', status: 'complete' })];

  const content = renderRoadmapContent(milestone, slices);

  assert.ok(content.includes('✅'), 'complete slice should show ✅');
});

test('renderRoadmapContent: slice with status "done" shows ✅', () => {
  const milestone = makeMilestoneRow();
  const slices = [makeSliceRow({ id: 'S01', status: 'done' })];

  const content = renderRoadmapContent(milestone, slices);

  assert.ok(content.includes('✅'), 'done slice should show ✅');
});

test('renderRoadmapContent: slice with status "pending" shows ⬜', () => {
  const milestone = makeMilestoneRow();
  const slices = [makeSliceRow({ id: 'S01', status: 'pending' })];

  const content = renderRoadmapContent(milestone, slices);

  assert.ok(content.includes('⬜'), 'pending slice should show ⬜');
});
