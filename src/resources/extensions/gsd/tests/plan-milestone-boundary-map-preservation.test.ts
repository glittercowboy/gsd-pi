import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase } from '../gsd-db.ts';
import { handlePlanMilestone } from '../tools/plan-milestone.ts';

const boundaryMap = [
  '| From | To | Produces | Consumes |',
  '|------|----|----------|----------|',
  '| S01 | S02 | roadmap | plan |',
  '| S02 | S03 | plan | tasks |',
  '',
  '### S01 → S02',
  '',
  '- Produces: roadmap',
  '- Consumes: plan',
  '',
  '### S02 → S03',
  '',
  '- Produces: plan',
  '- Consumes: tasks',
].join('\n');

function planParams() {
  return {
    milestoneId: 'M001',
    title: 'Preserve Boundary Map',
    vision: 'Roadmap survives projection hook.',
    successCriteria: ['Boundary Map section survives post-mutation hook'],
    keyRisks: [
      { risk: 'Projection clobber', whyItMatters: 'Authoritative roadmap would be overwritten.' },
    ],
    proofStrategy: [
      { riskOrUnknown: 'Roadmap overwrite', retireIn: 'S01', whatWillBeProven: 'ROADMAP.md still contains ## Boundary Map after plan-milestone.' },
    ],
    verificationContract: 'Contract check',
    verificationIntegration: 'Integration check',
    verificationOperational: 'Operational check',
    verificationUat: 'UAT check',
    definitionOfDone: ['Regression test green'],
    requirementCoverage: 'Covers #4402.',
    boundaryMapMarkdown: boundaryMap,
    slices: [
      {
        sliceId: 'S01',
        title: 'First',
        risk: 'low',
        depends: [] as string[],
        demo: 'demo 1',
        goal: 'goal 1',
        successCriteria: 'sc 1',
        proofLevel: 'unit',
        integrationClosure: 'ic 1',
        observabilityImpact: 'oi 1',
      },
      {
        sliceId: 'S02',
        title: 'Second',
        risk: 'low',
        depends: ['S01'],
        demo: 'demo 2',
        goal: 'goal 2',
        successCriteria: 'sc 2',
        proofLevel: 'unit',
        integrationClosure: 'ic 2',
        observabilityImpact: 'oi 2',
      },
      {
        sliceId: 'S03',
        title: 'Third',
        risk: 'low',
        depends: ['S02'],
        demo: 'demo 3',
        goal: 'goal 3',
        successCriteria: 'sc 3',
        proofLevel: 'unit',
        integrationClosure: 'ic 3',
        observabilityImpact: 'oi 3',
      },
    ],
  };
}

test('#4402 plan-milestone preserves ## Boundary Map after post-mutation projections', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-4402-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
  openDatabase(join(base, '.gsd', 'gsd.db'));

  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  const result = await handlePlanMilestone(planParams(), base);
  assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

  const roadmapPath = join(base, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
  assert.ok(existsSync(roadmapPath), 'ROADMAP.md must exist on disk');

  const roadmap = readFileSync(roadmapPath, 'utf-8');

  assert.match(
    roadmap,
    /^## Boundary Map$/m,
    'final on-disk ROADMAP.md must still contain the Boundary Map heading after projection hook',
  );
  assert.match(roadmap, /\| S01 \| S02 \| roadmap \| plan \|/, 'boundary map row S01→S02 must survive');
  assert.match(roadmap, /\| S02 \| S03 \| plan \| tasks \|/, 'boundary map row S02→S03 must survive');
  assert.match(roadmap, /^### S01 → S02$/m, 'boundary map edge subsection S01→S02 must survive');
  assert.match(roadmap, /^### S02 → S03$/m, 'boundary map edge subsection S02→S03 must survive');
});
