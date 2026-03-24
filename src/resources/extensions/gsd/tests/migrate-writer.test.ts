// Migration writer format round-trip test suite
// Tests that format functions produce output that parses back correctly
// through parseRoadmap(), parsePlan(), parseSummary(), and parseRequirementCounts().
// Pure in-memory tests — no filesystem needed.

import {
  formatRoadmap,
  formatPlan,
  formatSliceSummary,
  formatTaskSummary,
  formatTaskPlan,
  formatRequirements,
  formatProject,
  formatDecisions,
  formatContext,
  formatState,
} from '../migrate/writer.ts';
import {
  parseRoadmap,
  parsePlan,
} from '../parsers-legacy.ts';
import {
  parseSummary,
  parseRequirementCounts,
} from '../files.ts';
import type {
  GSDMilestone,
  GSDSlice,
  GSDTask,
  GSDRequirement,
  GSDSliceSummaryData,
  GSDTaskSummaryData,
} from '../migrate/types.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Test Data Builders ────────────────────────────────────────────────────

function makeTask(overrides: Partial<GSDTask> = {}): GSDTask {
  return {
    id: 'T01',
    title: 'Setup Auth',
    description: 'Implement authentication',
    done: false,
    estimate: '30m',
    files: ['src/auth.ts'],
    mustHaves: ['JWT support'],
    summary: null,
    ...overrides,
  };
}

function makeSlice(overrides: Partial<GSDSlice> = {}): GSDSlice {
  return {
    id: 'S01',
    title: 'Auth System',
    risk: 'medium' as const,
    depends: [],
    done: false,
    demo: 'Login flow works end-to-end',
    goal: 'Working authentication',
    tasks: [makeTask()],
    research: null,
    summary: null,
    ...overrides,
  };
}

function makeMilestone(overrides: Partial<GSDMilestone> = {}): GSDMilestone {
  return {
    id: 'M001',
    title: 'Core Platform',
    vision: 'Build the core platform',
    successCriteria: ['All tests pass', 'Deploy to staging'],
    slices: [makeSlice()],
    research: null,
    boundaryMap: [],
    ...overrides,
  };
}

function makeSliceSummary(overrides: Partial<GSDSliceSummaryData> = {}): GSDSliceSummaryData {
  return {
    completedAt: '2026-03-10',
    provides: ['auth-flow', 'jwt-tokens'],
    keyFiles: ['src/auth.ts', 'src/middleware.ts'],
    keyDecisions: ['Use JWT over sessions'],
    patternsEstablished: ['Middleware pattern'],
    duration: '2h',
    whatHappened: 'Implemented full auth system with JWT.',
    ...overrides,
  };
}

function makeTaskSummary(overrides: Partial<GSDTaskSummaryData> = {}): GSDTaskSummaryData {
  return {
    completedAt: '2026-03-09',
    provides: ['auth-endpoint'],
    keyFiles: ['src/auth.ts'],
    duration: '45m',
    whatHappened: 'Built the auth endpoint.',
    ...overrides,
  };
}

test('Scenario A: Roadmap round-trip with 2 slices (1 done, 1 not)', () => {
  const milestone = makeMilestone({
    slices: [
      makeSlice({
        id: 'S01',
        title: 'Auth System',
        risk: 'high',
        depends: [],
        done: true,
        demo: 'Login flow works',
      }),
      makeSlice({
        id: 'S02',
        title: 'Dashboard',
        risk: 'low',
        depends: ['S01'],
        done: false,
        demo: 'Dashboard renders data',
      }),
    ],
  });

  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);

  assert.deepStrictEqual(parsed.title, 'M001: Core Platform', 'roadmap: title');
  assert.deepStrictEqual(parsed.vision, 'Build the core platform', 'roadmap: vision');
  assert.deepStrictEqual(parsed.successCriteria.length, 2, 'roadmap: successCriteria count');
  assert.deepStrictEqual(parsed.successCriteria[0], 'All tests pass', 'roadmap: successCriteria[0]');
  assert.deepStrictEqual(parsed.successCriteria[1], 'Deploy to staging', 'roadmap: successCriteria[1]');
  assert.deepStrictEqual(parsed.slices.length, 2, 'roadmap: slices count');

  assert.deepStrictEqual(parsed.slices[0].id, 'S01', 'roadmap: S01 id');
  assert.deepStrictEqual(parsed.slices[0].title, 'Auth System', 'roadmap: S01 title');
  assert.deepStrictEqual(parsed.slices[0].done, true, 'roadmap: S01 done');
  assert.deepStrictEqual(parsed.slices[0].risk, 'high', 'roadmap: S01 risk');
  assert.deepStrictEqual(parsed.slices[0].depends.length, 0, 'roadmap: S01 depends empty');
  assert.deepStrictEqual(parsed.slices[0].demo, 'Login flow works', 'roadmap: S01 demo');

  assert.deepStrictEqual(parsed.slices[1].id, 'S02', 'roadmap: S02 id');
  assert.deepStrictEqual(parsed.slices[1].title, 'Dashboard', 'roadmap: S02 title');
  assert.deepStrictEqual(parsed.slices[1].done, false, 'roadmap: S02 done');
  assert.deepStrictEqual(parsed.slices[1].risk, 'low', 'roadmap: S02 risk');
  assert.deepStrictEqual(parsed.slices[1].depends, ['S01'], 'roadmap: S02 depends');
  assert.deepStrictEqual(parsed.slices[1].demo, 'Dashboard renders data', 'roadmap: S02 demo');

  assert.deepStrictEqual(parsed.boundaryMap.length, 0, 'roadmap: boundaryMap empty');
});

test('Scenario B: Plan round-trip with 3 tasks (mixed done)', () => {
  const slice = makeSlice({
    id: 'S01',
    title: 'Auth System',
    goal: 'Working authentication system',
    demo: 'Login works with valid credentials',
    tasks: [
      makeTask({ id: 'T01', title: 'Setup Models', done: true, estimate: '15m', description: 'Define user model' }),
      makeTask({ id: 'T02', title: 'Build Endpoints', done: false, estimate: '30m', description: 'REST API endpoints' }),
      makeTask({ id: 'T03', title: 'Write Tests', done: true, estimate: '20m', description: 'Unit and integration tests' }),
    ],
  });

  const output = formatPlan(slice);
  const parsed = parsePlan(output);

  assert.deepStrictEqual(parsed.id, 'S01', 'plan: id');
  assert.deepStrictEqual(parsed.title, 'Auth System', 'plan: title');
  assert.deepStrictEqual(parsed.goal, 'Working authentication system', 'plan: goal');
  assert.deepStrictEqual(parsed.demo, 'Login works with valid credentials', 'plan: demo');
  assert.deepStrictEqual(parsed.tasks.length, 3, 'plan: tasks count');

  assert.deepStrictEqual(parsed.tasks[0].id, 'T01', 'plan: T01 id');
  assert.deepStrictEqual(parsed.tasks[0].title, 'Setup Models', 'plan: T01 title');
  assert.deepStrictEqual(parsed.tasks[0].done, true, 'plan: T01 done');
  assert.deepStrictEqual(parsed.tasks[0].estimate, '15m', 'plan: T01 estimate');

  assert.deepStrictEqual(parsed.tasks[1].id, 'T02', 'plan: T02 id');
  assert.deepStrictEqual(parsed.tasks[1].done, false, 'plan: T02 done');
  assert.deepStrictEqual(parsed.tasks[1].estimate, '30m', 'plan: T02 estimate');

  assert.deepStrictEqual(parsed.tasks[2].id, 'T03', 'plan: T03 id');
  assert.deepStrictEqual(parsed.tasks[2].done, true, 'plan: T03 done');
  assert.deepStrictEqual(parsed.tasks[2].estimate, '20m', 'plan: T03 estimate');
});

test('Scenario C: Slice summary round-trip with full data', () => {
  const slice = makeSlice({
    id: 'S01',
    title: 'Auth System',
    done: true,
    summary: makeSliceSummary(),
  });

  const output = formatSliceSummary(slice, 'M001');
  const parsed = parseSummary(output);

  assert.deepStrictEqual(parsed.frontmatter.id, 'S01', 'sliceSummary: id');
  assert.deepStrictEqual(parsed.frontmatter.parent, 'M001', 'sliceSummary: parent');
  assert.deepStrictEqual(parsed.frontmatter.milestone, 'M001', 'sliceSummary: milestone');
  assert.deepStrictEqual(parsed.frontmatter.provides, ['auth-flow', 'jwt-tokens'], 'sliceSummary: provides');
  assert.deepStrictEqual(parsed.frontmatter.requires.length, 0, 'sliceSummary: requires empty');
  assert.deepStrictEqual(parsed.frontmatter.affects.length, 0, 'sliceSummary: affects empty');
  assert.deepStrictEqual(parsed.frontmatter.key_files, ['src/auth.ts', 'src/middleware.ts'], 'sliceSummary: key_files');
  assert.deepStrictEqual(parsed.frontmatter.key_decisions, ['Use JWT over sessions'], 'sliceSummary: key_decisions');
  assert.deepStrictEqual(parsed.frontmatter.patterns_established, ['Middleware pattern'], 'sliceSummary: patterns_established');
  assert.deepStrictEqual(parsed.frontmatter.duration, '2h', 'sliceSummary: duration');
  assert.deepStrictEqual(parsed.frontmatter.completed_at, '2026-03-10', 'sliceSummary: completed_at');
  assert.deepStrictEqual(parsed.frontmatter.verification_result, 'passed', 'sliceSummary: verification_result');
  assert.deepStrictEqual(parsed.frontmatter.blocker_discovered, false, 'sliceSummary: blocker_discovered');
  assert.ok(parsed.whatHappened.includes('Implemented full auth system'), 'sliceSummary: whatHappened content');
  assert.deepStrictEqual(parsed.title, 'S01: Auth System', 'sliceSummary: title');
});

test('Scenario D: Task summary round-trip', () => {
  const task = makeTask({
    id: 'T01',
    title: 'Setup Auth',
    done: true,
    summary: makeTaskSummary(),
  });

  const output = formatTaskSummary(task, 'S01', 'M001');
  const parsed = parseSummary(output);

  assert.deepStrictEqual(parsed.frontmatter.id, 'T01', 'taskSummary: id');
  assert.deepStrictEqual(parsed.frontmatter.parent, 'S01', 'taskSummary: parent');
  assert.deepStrictEqual(parsed.frontmatter.milestone, 'M001', 'taskSummary: milestone');
  assert.deepStrictEqual(parsed.frontmatter.provides, ['auth-endpoint'], 'taskSummary: provides');
  assert.deepStrictEqual(parsed.frontmatter.key_files, ['src/auth.ts'], 'taskSummary: key_files');
  assert.deepStrictEqual(parsed.frontmatter.duration, '45m', 'taskSummary: duration');
  assert.deepStrictEqual(parsed.frontmatter.completed_at, '2026-03-09', 'taskSummary: completed_at');
  assert.ok(parsed.whatHappened.includes('Built the auth endpoint'), 'taskSummary: whatHappened content');
  assert.deepStrictEqual(parsed.title, 'T01: Setup Auth', 'taskSummary: title');
});

test('Scenario E: Requirements round-trip with mixed statuses', () => {
  const requirements: GSDRequirement[] = [
    { id: 'R001', title: 'Auth Required', class: 'core-capability', status: 'active', description: 'Must have auth', source: 'spec', primarySlice: 'S01' },
    { id: 'R002', title: 'Logging', class: 'observability', status: 'active', description: 'Must log', source: 'spec', primarySlice: 'S02' },
    { id: 'R003', title: 'OAuth Support', class: 'core-capability', status: 'validated', description: 'OAuth working', source: 'testing', primarySlice: 'S01' },
    { id: 'R004', title: 'Dark Mode', class: 'ui', status: 'deferred', description: 'Nice to have', source: 'feedback', primarySlice: 'none' },
    { id: 'R005', title: 'Legacy API', class: 'compat', status: 'out-of-scope', description: 'Dropped', source: 'decision', primarySlice: 'none' },
  ];

  const output = formatRequirements(requirements);
  const counts = parseRequirementCounts(output);

  assert.deepStrictEqual(counts.active, 2, 'requirements: active count');
  assert.deepStrictEqual(counts.validated, 1, 'requirements: validated count');
  assert.deepStrictEqual(counts.deferred, 1, 'requirements: deferred count');
  assert.deepStrictEqual(counts.outOfScope, 1, 'requirements: outOfScope count');
  assert.deepStrictEqual(counts.total, 5, 'requirements: total count');
});

test('F1: Empty vision → fallback text', () => {
  const milestone = makeMilestone({ vision: '' });
  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);
  assert.deepStrictEqual(parsed.vision, '(migrated project)', 'edge: empty vision fallback');
});

test('F2: Empty successCriteria → empty array', () => {
  const milestone = makeMilestone({ successCriteria: [] });
  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);
  assert.deepStrictEqual(parsed.successCriteria.length, 0, 'edge: empty successCriteria');
});

test('F3: Empty tasks → empty array in parsed plan', () => {
  const slice = makeSlice({ tasks: [] });
  const output = formatPlan(slice);
  const parsed = parsePlan(output);
  assert.deepStrictEqual(parsed.tasks.length, 0, 'edge: empty tasks');
});

test('F4: Null summary → empty string from formatSliceSummary', () => {
  const slice = makeSlice({ summary: null });
  const output = formatSliceSummary(slice, 'M001');
  assert.deepStrictEqual(output, '', 'edge: null summary returns empty string');
});

test('F5: Done=true checkbox in roadmap', () => {
  const milestone = makeMilestone({
    slices: [makeSlice({ id: 'S01', done: true })],
  });
  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);
  assert.deepStrictEqual(parsed.slices[0].done, true, 'edge: done checkbox true');
});

test('F6: Done=false checkbox in roadmap', () => {
  const milestone = makeMilestone({
    slices: [makeSlice({ id: 'S01', done: false })],
  });
  const output = formatRoadmap(milestone);
  const parsed = parseRoadmap(output);
  assert.deepStrictEqual(parsed.slices[0].done, false, 'edge: done checkbox false');
});

test('F7: Null task summary → empty string from formatTaskSummary', () => {
  const task = makeTask({ summary: null });
  const output = formatTaskSummary(task, 'S01', 'M001');
  assert.deepStrictEqual(output, '', 'edge: null task summary returns empty string');
});

test('F8: Empty requirements → all zeros', () => {
  const output = formatRequirements([]);
  const counts = parseRequirementCounts(output);
  assert.deepStrictEqual(counts.total, 0, 'edge: empty requirements total 0');
});

test('F9: formatProject with empty content → produces valid stub', () => {
  const output = formatProject('');
  assert.ok(output.includes('# Project'), 'edge: empty project has heading');
  assert.ok(output.length > 10, 'edge: empty project not blank');
});

test('F10: formatProject with existing content → passes through', () => {
  const content = '# My Project\n\nDescription here.\n';
  const output = formatProject(content);
  assert.deepStrictEqual(output, content, 'edge: project passthrough');
});

test('F11: formatDecisions with empty content → produces valid stub', () => {
  const output = formatDecisions('');
  assert.ok(output.includes('# Decisions'), 'edge: empty decisions has heading');
});

test('F12: formatContext produces valid content', () => {
  const output = formatContext('M001');
  assert.ok(output.includes('M001'), 'edge: context mentions milestone');
});

test('F13: formatState produces valid content', () => {
  const milestones = [makeMilestone({
    slices: [
      makeSlice({ done: true }),
      makeSlice({ id: 'S02', done: false }),
    ],
  })];
  const output = formatState(milestones);
  assert.ok(output.includes('1/2'), 'edge: state shows slice progress');
});

test('F14: Task with no estimate → no est backtick in plan', () => {
  const slice = makeSlice({
    tasks: [makeTask({ id: 'T01', title: 'Quick Fix', estimate: '' })],
  });
  const output = formatPlan(slice);
  const parsed = parsePlan(output);
  assert.deepStrictEqual(parsed.tasks[0].id, 'T01', 'edge: task no estimate id');
  assert.deepStrictEqual(parsed.tasks[0].estimate, '', 'edge: task no estimate empty');
});

// ═══════════════════════════════════════════════════════════════════════════

