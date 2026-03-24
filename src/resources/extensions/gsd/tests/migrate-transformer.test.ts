// Migration transformer test suite
// Tests for transforming parsed PlanningProject into GSDProject structures.
// Uses synthetic in-memory fixtures — no filesystem needed.
// Transformer is pure: PlanningProject → GSDProject.

import { transformToGSD } from '../migrate/transformer.ts';
import type {
  PlanningProject,
  PlanningPhase,
  PlanningPlan,
  PlanningSummary,
  PlanningRoadmap,
  PlanningRoadmapEntry,
  PlanningRoadmapMilestone,
  PlanningRequirement,
  PlanningResearch,
  GSDProject,
  GSDMilestone,
  GSDSlice,
  GSDTask,
} from '../migrate/types.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function emptyProject(overrides: Partial<PlanningProject> = {}): PlanningProject {
  return {
    path: '/fake/.planning',
    project: null,
    roadmap: null,
    requirements: [],
    state: null,
    config: null,
    phases: {},
    quickTasks: [],
    milestones: [],
    research: [],
    validation: { valid: true, issues: [] },
    ...overrides,
  };
}

function flatRoadmap(entries: PlanningRoadmapEntry[]): PlanningRoadmap {
  return {
    raw: entries.map((e) => `- [${e.done ? 'x' : ' '}] Phase ${e.number}: ${e.title}`).join('\n'),
    milestones: [],
    phases: entries,
  };
}

function milestoneRoadmap(milestones: PlanningRoadmapMilestone[]): PlanningRoadmap {
  return {
    raw: milestones.map((m) => `## ${m.id}: ${m.title}`).join('\n'),
    milestones,
    phases: [],
  };
}

function roadmapEntry(number: number, title: string, done = false): PlanningRoadmapEntry {
  return { number, title, done, raw: `- [${done ? 'x' : ' '}] Phase ${number}: ${title}` };
}

function makePhase(dirName: string, number: number, slug: string, overrides: Partial<PlanningPhase> = {}): PlanningPhase {
  return {
    dirName,
    number,
    slug,
    plans: {},
    summaries: {},
    research: [],
    verifications: [],
    extraFiles: [],
    ...overrides,
  };
}

function makePlan(planNumber: string, overrides: Partial<PlanningPlan> = {}): PlanningPlan {
  return {
    fileName: `00-${planNumber}-PLAN.md`,
    planNumber,
    frontmatter: {
      phase: '00',
      plan: planNumber,
      type: 'implementation',
      wave: null,
      depends_on: [],
      files_modified: [],
      autonomous: false,
      must_haves: null,
    },
    objective: `Objective for plan ${planNumber}`,
    tasks: [`Task 1 for plan ${planNumber}`],
    context: '',
    verification: '',
    successCriteria: '',
    raw: '',
    ...overrides,
  };
}

function makeSummary(planNumber: string, overrides: Partial<PlanningSummary> = {}): PlanningSummary {
  return {
    fileName: `00-${planNumber}-SUMMARY.md`,
    planNumber,
    frontmatter: {
      phase: '00',
      plan: planNumber,
      subsystem: 'core',
      tags: [],
      requires: [],
      provides: [`feature-${planNumber}`],
      affects: [],
      'tech-stack': [],
      'key-files': [`file-${planNumber}.ts`],
      'key-decisions': [`decision-${planNumber}`],
      'patterns-established': [],
      duration: '2h',
      completed: '2026-01-15',
    },
    body: `Summary body for plan ${planNumber}`,
    raw: '',
    ...overrides,
  };
}

function makeRequirement(id: string, title: string, status = 'active'): PlanningRequirement {
  return { id, title, status, description: `Description for ${id}`, raw: '' };
}

function makeResearch(fileName: string, content: string): PlanningResearch {
  return { fileName, content };
}

// ─── Scenario 1: Flat Single-Milestone (3 phases → M001 with S01/S02/S03) ──

test('Scenario 1: Flat single-milestone', () => {

  const project = emptyProject({
    project: '# My Project\nA cool project.',
    roadmap: flatRoadmap([
      roadmapEntry(1, 'setup'),
      roadmapEntry(2, 'core-logic'),
      roadmapEntry(3, 'polish'),
    ]),
    phases: {
      '1-setup': makePhase('1-setup', 1, 'setup', {
        plans: { '01': makePlan('01') },
      }),
      '2-core-logic': makePhase('2-core-logic', 2, 'core-logic', {
        plans: { '01': makePlan('01'), '02': makePlan('02') },
      }),
      '3-polish': makePhase('3-polish', 3, 'polish', {
        plans: { '01': makePlan('01') },
      }),
    },
  });

  const result = transformToGSD(project);

  assert.deepStrictEqual(result.milestones.length, 1, 'flat: produces 1 milestone');
  assert.ok(result.milestones[0]?.id === 'M001', 'flat: milestone ID is M001');
  assert.deepStrictEqual(result.milestones[0]?.slices.length, 3, 'flat: 3 slices');
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.id, 'S01', 'flat: first slice is S01');
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.id, 'S02', 'flat: second slice is S02');
  assert.deepStrictEqual(result.milestones[0]?.slices[2]?.id, 'S03', 'flat: third slice is S03');
  assert.ok(result.milestones[0]?.slices[0]?.title.length > 0, 'flat: slice title not empty');
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.tasks.length, 1, 'flat: S01 has 1 task');
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.tasks.length, 2, 'flat: S02 has 2 tasks');
  assert.deepStrictEqual(result.milestones[0]?.slices[2]?.tasks.length, 1, 'flat: S03 has 1 task');
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.tasks[0]?.id, 'T01', 'flat: first task is T01');
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.tasks[1]?.id, 'T02', 'flat: second task in S02 is T02');
  assert.ok(result.projectContent.includes('My Project'), 'flat: projectContent preserved');
  assert.deepStrictEqual(result.milestones[0]?.boundaryMap, [], 'flat: boundaryMap defaults to empty');
});

// ─── Scenario 2: Multi-Milestone (2 milestones with independent numbering) ──

test('Scenario 2: Multi-milestone', () => {

  const project = emptyProject({
    roadmap: milestoneRoadmap([
      {
        id: 'v1',
        title: 'Version One',
        collapsed: false,
        phases: [roadmapEntry(1, 'alpha'), roadmapEntry(2, 'beta')],
      },
      {
        id: 'v2',
        title: 'Version Two',
        collapsed: false,
        phases: [roadmapEntry(1, 'gamma'), roadmapEntry(2, 'delta'), roadmapEntry(3, 'epsilon')],
      },
    ]),
    phases: {
      '1-alpha': makePhase('1-alpha', 1, 'alpha', { plans: { '01': makePlan('01') } }),
      '2-beta': makePhase('2-beta', 2, 'beta', { plans: { '01': makePlan('01') } }),
      '1-gamma': makePhase('1-gamma', 1, 'gamma', { plans: { '01': makePlan('01') } }),
      '2-delta': makePhase('2-delta', 2, 'delta', { plans: { '01': makePlan('01') } }),
      '3-epsilon': makePhase('3-epsilon', 3, 'epsilon', { plans: { '01': makePlan('01') } }),
    },
  });

  const result = transformToGSD(project);

  assert.deepStrictEqual(result.milestones.length, 2, 'multi: 2 milestones');
  assert.deepStrictEqual(result.milestones[0]?.id, 'M001', 'multi: first milestone M001');
  assert.deepStrictEqual(result.milestones[1]?.id, 'M002', 'multi: second milestone M002');
  assert.deepStrictEqual(result.milestones[0]?.slices.length, 2, 'multi: M001 has 2 slices');
  assert.deepStrictEqual(result.milestones[1]?.slices.length, 3, 'multi: M002 has 3 slices');
  // Independent numbering: both start at S01
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.id, 'S01', 'multi: M001 starts at S01');
  assert.deepStrictEqual(result.milestones[1]?.slices[0]?.id, 'S01', 'multi: M002 starts at S01');
  assert.deepStrictEqual(result.milestones[1]?.slices[2]?.id, 'S03', 'multi: M002 third slice is S03');
  assert.ok(result.milestones[0]?.title.length > 0, 'multi: M001 has title');
  assert.ok(result.milestones[1]?.title.length > 0, 'multi: M002 has title');
});

// ─── Scenario 3: Decimal Phase Ordering (1, 2, 2.1, 2.2, 3 → S01–S05) ──

test('Scenario 3: Decimal phase ordering', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([
      roadmapEntry(1, 'foundation'),
      roadmapEntry(2, 'main-feature'),
      roadmapEntry(2.1, 'sub-feature-a'),
      roadmapEntry(2.2, 'sub-feature-b'),
      roadmapEntry(3, 'finalize'),
    ]),
    phases: {
      '1-foundation': makePhase('1-foundation', 1, 'foundation'),
      '2-main-feature': makePhase('2-main-feature', 2, 'main-feature'),
      '2.1-sub-feature-a': makePhase('2.1-sub-feature-a', 2.1, 'sub-feature-a'),
      '2.2-sub-feature-b': makePhase('2.2-sub-feature-b', 2.2, 'sub-feature-b'),
      '3-finalize': makePhase('3-finalize', 3, 'finalize'),
    },
  });

  const result = transformToGSD(project);

  assert.deepStrictEqual(result.milestones[0]?.slices.length, 5, 'decimal: 5 slices total');
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.id, 'S01', 'decimal: first is S01');
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.id, 'S02', 'decimal: second is S02');
  assert.deepStrictEqual(result.milestones[0]?.slices[2]?.id, 'S03', 'decimal: third is S03');
  assert.deepStrictEqual(result.milestones[0]?.slices[3]?.id, 'S04', 'decimal: fourth is S04');
  assert.deepStrictEqual(result.milestones[0]?.slices[4]?.id, 'S05', 'decimal: fifth is S05');
  // Order must be by float value: 1, 2, 2.1, 2.2, 3
  assert.ok(
    result.milestones[0]?.slices[0]?.title.toLowerCase().includes('foundation'),
    'decimal: S01 is foundation (phase 1)',
  );
  assert.ok(
    result.milestones[0]?.slices[4]?.title.toLowerCase().includes('finalize'),
    'decimal: S05 is finalize (phase 3)',
  );
});

// ─── Scenario 4: Completion State ──────────────────────────────────────────

test('Scenario 4: Completion state mapping', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([
      roadmapEntry(1, 'done-phase', true),
      roadmapEntry(2, 'active-phase', false),
    ]),
    phases: {
      '1-done-phase': makePhase('1-done-phase', 1, 'done-phase', {
        plans: { '01': makePlan('01'), '02': makePlan('02') },
        summaries: {
          '01': makeSummary('01'),
          // plan 02 has no summary → task not done
        },
      }),
      '2-active-phase': makePhase('2-active-phase', 2, 'active-phase', {
        plans: { '01': makePlan('01') },
      }),
    },
  });

  const result = transformToGSD(project);
  const doneSlice = result.milestones[0]?.slices[0];
  const activeSlice = result.milestones[0]?.slices[1];

  assert.ok(doneSlice?.done === true, 'completion: done phase → done slice');
  assert.ok(activeSlice?.done === false, 'completion: active phase → not-done slice');
  assert.ok(doneSlice?.tasks[0]?.done === true, 'completion: plan with summary → done task');
  assert.ok(doneSlice?.tasks[1]?.done === false, 'completion: plan without summary → not-done task');
  assert.ok(doneSlice?.tasks[0]?.summary !== null, 'completion: done task has summary data');
  assert.ok(doneSlice?.tasks[1]?.summary === null, 'completion: not-done task has null summary');
  assert.deepStrictEqual(doneSlice?.tasks[0]?.summary?.completedAt, '2026-01-15', 'completion: summary completedAt from frontmatter');
  assert.deepStrictEqual(doneSlice?.tasks[0]?.summary?.duration, '2h', 'completion: summary duration from frontmatter');
  assert.deepStrictEqual(doneSlice?.tasks[0]?.summary?.provides, ['feature-01'], 'completion: summary provides from frontmatter');
  assert.deepStrictEqual(doneSlice?.tasks[0]?.summary?.keyFiles, ['file-01.ts'], 'completion: summary keyFiles from frontmatter');
  assert.ok(doneSlice?.tasks[0]?.summary?.whatHappened?.includes('Summary body') ?? false, 'completion: summary whatHappened from body');
  assert.ok(doneSlice?.summary !== null, 'completion: done slice has slice summary');
  assert.ok(activeSlice?.summary === null, 'completion: active slice has null summary');
  assert.deepStrictEqual(doneSlice?.tasks[0]?.estimate, '2h', 'completion: task estimate from summary duration');
});

// ─── Scenario 5: Research Consolidation ────────────────────────────────────

test('Scenario 5: Research consolidation', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, 'researched-phase')]),
    research: [
      makeResearch('SUMMARY.md', '# Project Summary\nOverview content.'),
      makeResearch('ARCHITECTURE.md', '# Architecture\nArch details.'),
      makeResearch('PITFALLS.md', '# Pitfalls\nThings to avoid.'),
    ],
    phases: {
      '1-researched-phase': makePhase('1-researched-phase', 1, 'researched-phase', {
        research: [
          makeResearch('FEATURES.md', '# Phase Features\nFeature list.'),
        ],
      }),
    },
  });

  const result = transformToGSD(project);

  // Project-level research → milestone research
  assert.ok(result.milestones[0]?.research !== null, 'research: milestone has consolidated research');
  assert.ok(result.milestones[0]?.research!.includes('Project Summary'), 'research: includes SUMMARY content');
  assert.ok(result.milestones[0]?.research!.includes('Architecture'), 'research: includes ARCHITECTURE content');
  assert.ok(result.milestones[0]?.research!.includes('Pitfalls'), 'research: includes PITFALLS content');

  // Fixed ordering: SUMMARY before ARCHITECTURE before PITFALLS
  const summaryIdx = result.milestones[0]?.research!.indexOf('Project Summary') ?? -1;
  const archIdx = result.milestones[0]?.research!.indexOf('Architecture') ?? -1;
  const pitfallIdx = result.milestones[0]?.research!.indexOf('Pitfalls') ?? -1;
  assert.ok(summaryIdx < archIdx, 'research: SUMMARY before ARCHITECTURE in consolidated');
  assert.ok(archIdx < pitfallIdx, 'research: ARCHITECTURE before PITFALLS in consolidated');

  // Phase-level research → slice research
  const slice = result.milestones[0]?.slices[0];
  assert.ok(slice?.research !== null, 'research: slice has phase research');
  assert.ok(slice?.research!.includes('Phase Features'), 'research: slice research includes phase content');
});

// ─── Scenario 6: Requirements Classification ──────────────────────────────

test('Scenario 6: Requirements classification', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, 'req-phase')]),
    requirements: [
      makeRequirement('R001', 'Core Feature', 'active'),
      makeRequirement('R002', 'Secondary Feature', 'validated'),
      makeRequirement('R003', 'Deferred Feature', 'deferred'),
    ],
    phases: {
      '1-req-phase': makePhase('1-req-phase', 1, 'req-phase'),
    },
  });

  const result = transformToGSD(project);

  assert.deepStrictEqual(result.requirements.length, 3, 'requirements: 3 requirements');
  assert.deepStrictEqual(result.requirements[0]?.id, 'R001', 'requirements: first is R001');
  assert.deepStrictEqual(result.requirements[0]?.status, 'active', 'requirements: R001 status active');
  assert.deepStrictEqual(result.requirements[1]?.status, 'validated', 'requirements: R002 status validated');
  assert.deepStrictEqual(result.requirements[2]?.status, 'deferred', 'requirements: R003 status deferred');
  assert.ok(result.requirements[0]?.title === 'Core Feature', 'requirements: R001 title preserved');
  assert.ok(result.requirements[0]?.description.includes('Description for R001'), 'requirements: R001 description preserved');
  assert.deepStrictEqual(result.requirements[0]?.class, 'core-capability', 'requirements: default class');
  assert.deepStrictEqual(result.requirements[0]?.source, 'inferred', 'requirements: default source');
  assert.deepStrictEqual(result.requirements[0]?.primarySlice, 'none yet', 'requirements: default primarySlice');
});

// ─── Scenario 7: Empty Phase (no plans → slice with 0 tasks) ───────────────

test('Scenario 7: Empty phase', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([
      roadmapEntry(1, 'empty-phase'),
      roadmapEntry(2, 'non-empty-phase'),
    ]),
    phases: {
      '1-empty-phase': makePhase('1-empty-phase', 1, 'empty-phase'),
      '2-non-empty-phase': makePhase('2-non-empty-phase', 2, 'non-empty-phase', {
        plans: { '01': makePlan('01') },
      }),
    },
  });

  const result = transformToGSD(project);

  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.tasks.length, 0, 'empty: empty phase → 0 tasks');
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.tasks.length, 1, 'empty: non-empty phase → 1 task');
  assert.ok(result.milestones[0]?.slices[0]?.id === 'S01', 'empty: empty slice still gets ID');
});

// ─── Scenario 8: Demo Derivation from Plan Objective ───────────────────────

test('Scenario 8: Demo derivation', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, 'demo-phase')]),
    phases: {
      '1-demo-phase': makePhase('1-demo-phase', 1, 'demo-phase', {
        plans: {
          '01': makePlan('01', { objective: 'Build the authentication system with JWT tokens.' }),
        },
      }),
    },
  });

  const result = transformToGSD(project);

  assert.ok(result.milestones[0]?.slices[0]?.demo.length > 0, 'demo: slice demo is not empty');
  assert.ok(
    result.milestones[0]?.slices[0]?.demo.includes('authentication') ||
    result.milestones[0]?.slices[0]?.demo.includes('Build'),
    'demo: slice demo derived from first plan objective',
  );
  assert.ok(result.milestones[0]?.slices[0]?.goal.length > 0, 'demo: slice goal is not empty');
});

// ─── Scenario 9: Field Defaults and Type Safety ────────────────────────────

test('Scenario 9: Field defaults', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, 'defaults-phase')]),
    phases: {
      '1-defaults-phase': makePhase('1-defaults-phase', 1, 'defaults-phase', {
        plans: {
          '01': makePlan('01', {
            frontmatter: {
              phase: '01',
              plan: '01',
              type: 'implementation',
              wave: null,
              depends_on: [],
              files_modified: ['src/auth.ts', 'src/db.ts'],
              autonomous: false,
              must_haves: { truths: ['Auth works', 'DB connected'], artifacts: [], key_links: [] },
            },
          }),
        },
      }),
    },
  });

  const result = transformToGSD(project);
  const slice = result.milestones[0]?.slices[0];
  const task = slice?.tasks[0];

  assert.deepStrictEqual(slice?.risk, 'medium', 'defaults: slice risk defaults to medium');
  assert.deepStrictEqual(slice?.depends, [], 'defaults: S01 has no depends');
  assert.ok(task?.description.length > 0, 'defaults: task description not empty');
  assert.deepStrictEqual(task?.files, ['src/auth.ts', 'src/db.ts'], 'defaults: task files from frontmatter');
  assert.deepStrictEqual(task?.mustHaves, ['Auth works', 'DB connected'], 'defaults: task mustHaves from frontmatter');
  assert.deepStrictEqual(task?.done, false, 'defaults: task without summary is not done');
  assert.deepStrictEqual(task?.estimate, '', 'defaults: task without summary has empty estimate');
  assert.ok(task?.summary === null, 'defaults: task without summary has null summary');
});

// ─── Scenario 10: Sequential Depends ──────────────────────────────────────

test('Scenario 10: Sequential depends', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([
      roadmapEntry(1, 'first'),
      roadmapEntry(2, 'second'),
      roadmapEntry(3, 'third'),
    ]),
    phases: {
      '1-first': makePhase('1-first', 1, 'first'),
      '2-second': makePhase('2-second', 2, 'second'),
      '3-third': makePhase('3-third', 3, 'third'),
    },
  });

  const result = transformToGSD(project);
  const slices = result.milestones[0]?.slices;

  assert.deepStrictEqual(slices?.[0]?.depends, [], 'depends: S01 has empty depends');
  assert.deepStrictEqual(slices?.[1]?.depends, ['S01'], 'depends: S02 depends on S01');
  assert.deepStrictEqual(slices?.[2]?.depends, ['S02'], 'depends: S03 depends on S02');
});

// ─── Scenario 11: Requirements with unknown status and missing IDs ─────────

test('Scenario 11: Requirements edge cases', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, 'req-edge')]),
    requirements: [
      makeRequirement('', 'No ID Feature', 'active'),
      makeRequirement('', 'Another No ID', 'validated'),
      makeRequirement('R005', 'Has ID', 'something-weird'),
      makeRequirement('R006', 'Deferred One', 'DEFERRED'),
    ],
    phases: {
      '1-req-edge': makePhase('1-req-edge', 1, 'req-edge'),
    },
  });

  const result = transformToGSD(project);

  assert.deepStrictEqual(result.requirements[0]?.id, 'R001', 'req-edge: empty id gets R001');
  assert.deepStrictEqual(result.requirements[1]?.id, 'R002', 'req-edge: second empty id gets R002');
  assert.deepStrictEqual(result.requirements[2]?.id, 'R005', 'req-edge: existing id preserved');
  assert.deepStrictEqual(result.requirements[2]?.status, 'active', 'req-edge: unknown status normalized to active');
  assert.deepStrictEqual(result.requirements[3]?.status, 'deferred', 'req-edge: uppercase DEFERRED normalized');
});

// ─── Scenario 12: Vision derivation ────────────────────────────────────────

test('Scenario 12: Vision derivation', () => {

  // Vision from project description
  const project1 = emptyProject({
    project: '# Cool Project\nA revolutionary tool for developers.',
    roadmap: flatRoadmap([roadmapEntry(1, 'vision-phase')]),
    phases: { '1-vision-phase': makePhase('1-vision-phase', 1, 'vision-phase') },
  });

  const result1 = transformToGSD(project1);
  assert.ok(result1.milestones[0]?.vision.includes('revolutionary'), 'vision: derived from project first line');

  // Vision fallback when no project
  const project2 = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, 'fallback')]),
    phases: { '1-fallback': makePhase('1-fallback', 1, 'fallback') },
  });

  const result2 = transformToGSD(project2);
  assert.ok(result2.milestones[0]?.vision.length > 0, 'vision: fallback is non-empty');
});

// ─── Scenario 13: Decisions content from summaries ─────────────────────────

test('Scenario 13: Decisions content', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, 'decision-phase', true)]),
    phases: {
      '1-decision-phase': makePhase('1-decision-phase', 1, 'decision-phase', {
        plans: { '01': makePlan('01') },
        summaries: { '01': makeSummary('01') },
      }),
    },
  });

  const result = transformToGSD(project);

  assert.ok(result.decisionsContent.includes('decision-01'), 'decisions: extracts key-decisions from summaries');
});

// ─── Scenario 14: No undefined values in output ───────────────────────────

test('Scenario 14: No undefined values', () => {

  const project = emptyProject({
    project: '# Test\nDescription.',
    roadmap: flatRoadmap([
      roadmapEntry(1, 'full-phase', true),
      roadmapEntry(2, 'empty-phase', false),
    ]),
    requirements: [makeRequirement('R001', 'Req', 'active')],
    research: [makeResearch('SUMMARY.md', 'Research content')],
    phases: {
      '1-full-phase': makePhase('1-full-phase', 1, 'full-phase', {
        plans: { '01': makePlan('01') },
        summaries: { '01': makeSummary('01') },
        research: [makeResearch('FEATURES.md', 'Features')],
      }),
      '2-empty-phase': makePhase('2-empty-phase', 2, 'empty-phase'),
    },
  });

  const result = transformToGSD(project);

  // Deep check for undefined values
  function checkNoUndefined(obj: unknown, path: string): void {
    if (obj === undefined) {
      assert.ok(false, `no-undefined: ${path} is undefined`);
      return;
    }
    if (obj === null) return; // null is allowed (e.g. research, summary)
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        checkNoUndefined(obj[i], `${path}[${i}]`);
      }
    } else if (typeof obj === 'object') {
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        checkNoUndefined(val, `${path}.${key}`);
      }
    }
  }

  checkNoUndefined(result, 'result');
  assert.ok(true, 'no-undefined: deep check completed without finding undefined values');
});

// ─── Scenario 15: Research with no files ───────────────────────────────────

test('Scenario 15: Empty research', () => {

  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, 'no-research')]),
    phases: { '1-no-research': makePhase('1-no-research', 1, 'no-research') },
  });

  const result = transformToGSD(project);
  assert.ok(result.milestones[0]?.research === null, 'empty-research: milestone research is null');
  assert.ok(result.milestones[0]?.slices[0]?.research === null, 'empty-research: slice research is null');
});

// ─── Results ───────────────────────────────────────────────────────────────

