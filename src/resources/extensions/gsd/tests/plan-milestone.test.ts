import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase, getMilestone, getMilestoneSlices, getSlice, updateSliceStatus, deleteSlice, insertMilestone } from '../gsd-db.ts';
import { handlePlanMilestone } from '../tools/plan-milestone.ts';
import { parseRoadmap } from '../parsers-legacy.ts';

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-plan-milestone-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function validParams() {
  return {
    milestoneId: 'M001',
    title: 'DB-backed planning',
    vision: 'Make planning write through the database.',
    successCriteria: ['Planning persists', 'Roadmap renders from DB'],
    keyRisks: [
      { risk: 'Renderer mismatch', whyItMatters: 'Rendered roadmap may stop round-tripping.' },
    ],
    proofStrategy: [
      { riskOrUnknown: 'Render correctness', retireIn: 'S01', whatWillBeProven: 'ROADMAP output matches DB state.' },
    ],
    verificationContract: 'Contract verification text',
    verificationIntegration: 'Integration verification text',
    verificationOperational: 'Operational verification text',
    verificationUat: 'UAT verification text',
    definitionOfDone: ['Tests pass', 'Tool reruns cleanly'],
    requirementCoverage: 'Covers R015.',
    boundaryMapMarkdown: '| From | To | Produces | Consumes |\n|------|----|----------|----------|\n| S01 | terminal | roadmap | nothing |',
    slices: [
      {
        sliceId: 'S01',
        title: 'Tool wiring',
        risk: 'medium',
        depends: [],
        demo: 'The tool writes roadmap state.',
        goal: 'Wire the handler.',
        successCriteria: 'Handler persists state and renders markdown.',
        proofLevel: 'integration',
        integrationClosure: 'Downstream callers read rendered roadmap output.',
        observabilityImpact: 'Tests expose render and validation failures.',
      },
      {
        sliceId: 'S02',
        title: 'Prompt migration',
        risk: 'low',
        depends: ['S01'],
        demo: 'Prompts call the tool.',
        goal: 'Migrate prompts to DB-backed path.',
        successCriteria: 'Prompt contracts reference the new tool.',
        proofLevel: 'integration',
        integrationClosure: 'Prompt tests cover the new planning route.',
        observabilityImpact: 'Prompt and rogue-write failures become explicit.',
      },
    ],
  };
}

test('handlePlanMilestone writes milestone and slice planning state and renders roadmap', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const result = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const milestone = getMilestone('M001');
    assert.ok(milestone, 'milestone should exist');
    assert.equal(milestone?.vision, 'Make planning write through the database.');
    assert.deepEqual(milestone?.success_criteria, ['Planning persists', 'Roadmap renders from DB']);
    assert.equal(milestone?.verification_contract, 'Contract verification text');

    const slices = getMilestoneSlices('M001');
    assert.equal(slices.length, 2);
    assert.equal(slices[0]?.id, 'S01');
    assert.equal(slices[0]?.goal, 'Wire the handler.');
    assert.equal(slices[1]?.depends[0], 'S01');

    const roadmapPath = join(base, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
    assert.ok(existsSync(roadmapPath), 'roadmap should be rendered to disk');
    const roadmap = readFileSync(roadmapPath, 'utf-8');
    assert.match(roadmap, /# M001: DB-backed planning/);
    assert.match(roadmap, /## Vision/);
    assert.match(roadmap, /Make planning write through the database\./);
    assert.match(roadmap, /## Slice Overview/);
    assert.match(roadmap, /\| S01 \| Tool wiring \| medium \|/);
    assert.match(roadmap, /\| S02 \| Prompt migration \| low \| S01 \|/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone rejects invalid payloads', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const params = validParams();
    const result = await handlePlanMilestone({ ...params, slices: [] }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: slices must be a non-empty array/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone surfaces render failures and does not clear parse-visible state on failure', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const fallbackRoadmapPath = join(base, '.gsd', 'milestones', 'MISSING', 'MISSING-ROADMAP.md');
    mkdirSync(fallbackRoadmapPath, { recursive: true });

    const result = await handlePlanMilestone({ ...validParams(), milestoneId: 'MISSING' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /render failed:/);

    const existingRoadmapPath = join(base, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
    writeFileSync(existingRoadmapPath, '# M001: Cached roadmap\n\n**Vision:** old value\n\n## Slices\n\n', 'utf-8');
    const cachedAfter = parseRoadmap(readFileSync(existingRoadmapPath, 'utf-8'));
    assert.equal(cachedAfter.vision, 'old value');
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone clears parse-visible roadmap state after successful render', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const roadmapPath = join(base, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
    writeFileSync(roadmapPath, '# M001: Cached roadmap\n\n**Vision:** old value\n\n## Slices\n\n', 'utf-8');

    const cachedBefore = parseRoadmap(readFileSync(roadmapPath, 'utf-8'));
    assert.equal(cachedBefore.vision, 'old value');

    const result = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in result));

    const contentAfter = readFileSync(roadmapPath, 'utf-8');
    assert.match(contentAfter, /Make planning write through the database\./);
    assert.match(contentAfter, /S01/);
    assert.match(contentAfter, /S02/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone reruns idempotently and updates existing planning state', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    const first = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in first));

    const second = await handlePlanMilestone({
      ...validParams(),
      vision: 'Updated vision',
      slices: [
        {
          ...validParams().slices[0],
          goal: 'Updated goal',
          observabilityImpact: 'Updated observability',
        },
        validParams().slices[1],
      ],
    }, base);
    assert.ok(!('error' in second));

    const milestone = getMilestone('M001');
    assert.equal(milestone?.vision, 'Updated vision');

    const slices = getMilestoneSlices('M001');
    assert.equal(slices.length, 2);
    assert.equal(slices[0]?.goal, 'Updated goal');
    assert.equal(slices[0]?.observability_impact, 'Updated observability');
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone preserves completed slice status on re-plan (#2558)', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    // Initial plan — both slices start as "pending"
    const first = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in first), `unexpected error: ${'error' in first ? first.error : ''}`);

    // Mark S01 as complete (simulates work done in a worktree)
    updateSliceStatus('M001', 'S01', 'complete', new Date().toISOString());

    const s01Before = getSlice('M001', 'S01');
    assert.equal(s01Before?.status, 'complete', 'S01 should be complete before re-plan');

    // Re-plan the same milestone — S01 must stay "complete", S02 stays "pending"
    const second = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in second), `unexpected error: ${'error' in second ? second.error : ''}`);

    const s01After = getSlice('M001', 'S01');
    assert.equal(s01After?.status, 'complete', 'S01 status must be preserved as complete after re-plan');

    const s02After = getSlice('M001', 'S02');
    assert.equal(s02After?.status, 'pending', 'S02 should remain pending');
  } finally {
    cleanup(base);
  }
});

test('plan-milestone re-plan preserves completed status and updates slice fields (#2558)', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    // Initial plan — both slices start as "pending"
    const first = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in first), `unexpected error: ${'error' in first ? first.error : ''}`);

    // Mark S01 as complete (simulates work done in worktree, then reconciled)
    updateSliceStatus('M001', 'S01', 'complete', new Date().toISOString());
    assert.equal(getSlice('M001', 'S01')?.status, 'complete');

    // Re-plan with updated title for S01.
    // The handler must:
    //   1. NOT downgrade S01 from "complete" to "pending"
    //   2. Update S01's non-status fields (title, risk, depends, demo)
    //   3. Keep S02 as "pending"
    const updatedParams = {
      ...validParams(),
      slices: [
        { ...validParams().slices[0], title: 'Updated S01 title', risk: 'high' },
        validParams().slices[1],
      ],
    };
    const second = await handlePlanMilestone(updatedParams, base);
    assert.ok(!('error' in second), `unexpected error: ${'error' in second ? second.error : ''}`);

    const s01After = getSlice('M001', 'S01');
    assert.equal(s01After?.status, 'complete', 'completed slice status must survive re-plan');
    assert.equal(s01After?.title, 'Updated S01 title', 'title should update on re-plan');
    assert.equal(s01After?.risk, 'high', 'risk should update on re-plan');

    const s02After = getSlice('M001', 'S02');
    assert.equal(s02After?.status, 'pending', 'pending slice stays pending');
  } finally {
    cleanup(base);
  }
});

test('handlePlanMilestone promotes pre-existing queued milestone to active (#3022)', async () => {
  const base = makeTmpBase();
  const dbPath = join(base, '.gsd', 'gsd.db');
  openDatabase(dbPath);

  try {
    // Simulate ensureMilestoneDbRow: pre-create row with status "queued"
    // (this is what gsd_milestone_generate_id does)
    insertMilestone({ id: 'M001', status: 'queued' });

    const before = getMilestone('M001');
    assert.equal(before?.status, 'queued', 'pre-condition: milestone should start as queued');

    // Now plan the milestone — status should be promoted to "active"
    const result = await handlePlanMilestone(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const after = getMilestone('M001');
    assert.equal(after?.status, 'active', 'milestone status should be promoted from queued to active');
    assert.equal(after?.title, 'DB-backed planning', 'milestone title should be set');
  } finally {
    cleanup(base);
  }
});
