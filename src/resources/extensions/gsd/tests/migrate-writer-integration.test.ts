// Migration writer integration test
// Writes a complete .gsd tree to a temp dir, verifies file existence,
// parses key files, and asserts deriveState() returns coherent state.
// Also tests generatePreview() for correct counts.

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeGSDDirectory } from '../migrate/writer.ts';
import { generatePreview } from '../migrate/preview.ts';
import { parseRoadmap, parsePlan, parseSummary } from '../files.ts';
import { deriveState } from '../state.ts';
import { invalidateAllCaches } from '../cache.ts';
import type {
  GSDProject,
  GSDMilestone,
  GSDSlice,
  GSDTask,
  GSDRequirement,
} from '../migrate/types.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();
// ─── Fixture Builders ──────────────────────────────────────────────────────

function makeTask(id: string, title: string, done: boolean, hasSummary: boolean): GSDTask {
  return {
    id,
    title,
    description: `Description for ${title}`,
    done,
    estimate: done ? '1h' : '',
    files: [`src/${id.toLowerCase()}.ts`],
    mustHaves: [`${title} works correctly`],
    summary: hasSummary ? {
      completedAt: '2026-01-15',
      provides: [`${id.toLowerCase()}-feature`],
      keyFiles: [`src/${id.toLowerCase()}.ts`],
      duration: '1h',
      whatHappened: `Implemented ${title} successfully.`,
    } : null,
  };
}

function makeSlice(
  id: string, title: string, done: boolean,
  tasks: GSDTask[], depends: string[],
  hasSummary: boolean,
): GSDSlice {
  return {
    id,
    title,
    risk: 'medium' as const,
    depends,
    done,
    demo: `Demo for ${title}`,
    goal: `Goal for ${title}`,
    tasks,
    research: null,
    summary: hasSummary ? {
      completedAt: '2026-01-15',
      provides: [`${id.toLowerCase()}-capability`],
      keyFiles: tasks.map(t => `src/${t.id.toLowerCase()}.ts`),
      keyDecisions: ['Used standard patterns'],
      patternsEstablished: ['Integration pattern'],
      duration: '2h',
      whatHappened: `Completed ${title} with all tasks done.`,
    } : null,
  };
}

function buildIncompleteProject(): GSDProject {
  const t01 = makeTask('T01', 'Setup Database', true, true);
  const t02 = makeTask('T02', 'Add Auth Middleware', true, true);
  const s01 = makeSlice('S01', 'Auth Foundation', true, [t01, t02], [], true);

  const t03 = makeTask('T03', 'Build Dashboard UI', false, false);
  const s02 = makeSlice('S02', 'Dashboard', false, [t03], ['S01'], false);

  const milestone: GSDMilestone = {
    id: 'M001',
    title: 'MVP Launch',
    vision: 'Ship the minimum viable product',
    successCriteria: ['Users can log in', 'Dashboard renders data'],
    slices: [s01, s02],
    research: '# Research\n\nMarket analysis for MVP features.\n',
    boundaryMap: [],
  };

  const requirements: GSDRequirement[] = [
    { id: 'R001', title: 'User Authentication', class: 'core-capability', status: 'validated', description: 'Users must authenticate.', source: 'stakeholder', primarySlice: 'S01' },
    { id: 'R002', title: 'Dashboard View', class: 'core-capability', status: 'active', description: 'Dashboard shows data.', source: 'stakeholder', primarySlice: 'S02' },
    { id: 'R003', title: 'Export to PDF', class: 'nice-to-have', status: 'deferred', description: 'PDF export.', source: 'inferred', primarySlice: 'none yet' },
    { id: 'R004', title: 'Legacy Reports', class: 'deprecated', status: 'out-of-scope', description: 'Old reporting.', source: 'inferred', primarySlice: 'none yet' },
  ];

  return {
    milestones: [milestone],
    projectContent: '# My Project\n\nA test project for migration.\n',
    requirements,
    decisionsContent: '',
  };
}

function buildCompleteProject(): GSDProject {
  const t01 = makeTask('T01', 'Only Task', true, true);
  const s01 = makeSlice('S01', 'Only Slice', true, [t01], [], true);

  const milestone: GSDMilestone = {
    id: 'M001',
    title: 'Complete Milestone',
    vision: 'Everything done',
    successCriteria: ['All done'],
    slices: [s01],
    research: null,
    boundaryMap: [],
  };

  return {
    milestones: [milestone],
    projectContent: '# Done Project\n',
    requirements: [],
    decisionsContent: '# Decisions\n\n| ID | Decision | Rationale | Date |\n',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {

  // ─── Scenario 1: Incomplete project ────────────────────────────────────
  console.log('\n=== Scenario 1: Incomplete project — write, parse, deriveState ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-writer-int-'));
    try {
      const project = buildIncompleteProject();
      const result = await writeGSDDirectory(project, base);

      // (a) Key files exist
      console.log('  --- file existence ---');
      const gsd = join(base, '.gsd');
      const m = join(gsd, 'milestones', 'M001');

      assertTrue(existsSync(join(m, 'M001-ROADMAP.md')), 'incomplete: M001-ROADMAP.md exists');
      assertTrue(existsSync(join(m, 'M001-CONTEXT.md')), 'incomplete: M001-CONTEXT.md exists');
      assertTrue(existsSync(join(m, 'M001-RESEARCH.md')), 'incomplete: M001-RESEARCH.md exists');
      assertTrue(existsSync(join(m, 'slices', 'S01', 'S01-PLAN.md')), 'incomplete: S01-PLAN.md exists');
      assertTrue(existsSync(join(m, 'slices', 'S02', 'S02-PLAN.md')), 'incomplete: S02-PLAN.md exists');
      assertTrue(existsSync(join(m, 'slices', 'S01', 'S01-SUMMARY.md')), 'incomplete: S01-SUMMARY.md exists');
      assertTrue(!existsSync(join(m, 'slices', 'S02', 'S02-SUMMARY.md')), 'incomplete: S02-SUMMARY.md NOT written (null)');
      assertTrue(existsSync(join(gsd, 'REQUIREMENTS.md')), 'incomplete: REQUIREMENTS.md exists');
      assertTrue(existsSync(join(gsd, 'PROJECT.md')), 'incomplete: PROJECT.md exists');
      assertTrue(existsSync(join(gsd, 'DECISIONS.md')), 'incomplete: DECISIONS.md exists');
      assertTrue(existsSync(join(gsd, 'STATE.md')), 'incomplete: STATE.md exists');

      // Task files
      assertTrue(existsSync(join(m, 'slices', 'S01', 'tasks', 'T01-PLAN.md')), 'incomplete: T01-PLAN.md exists');
      assertTrue(existsSync(join(m, 'slices', 'S01', 'tasks', 'T01-SUMMARY.md')), 'incomplete: T01-SUMMARY.md exists');
      assertTrue(existsSync(join(m, 'slices', 'S01', 'tasks', 'T02-PLAN.md')), 'incomplete: T02-PLAN.md exists (auth task)');
      assertTrue(existsSync(join(m, 'slices', 'S01', 'tasks', 'T02-SUMMARY.md')), 'incomplete: T02-SUMMARY.md exists (auth task)');
      assertTrue(existsSync(join(m, 'slices', 'S02', 'tasks', 'T03-PLAN.md')), 'incomplete: T03-PLAN.md exists');
      assertTrue(!existsSync(join(m, 'slices', 'S02', 'tasks', 'T03-SUMMARY.md')), 'incomplete: T03-SUMMARY.md NOT written (null)');

      // WrittenFiles counts
      console.log('  --- WrittenFiles counts ---');
      assertEq(result.counts.roadmaps, 1, 'incomplete: WrittenFiles roadmaps count');
      assertEq(result.counts.plans, 2, 'incomplete: WrittenFiles plans count');
      assertEq(result.counts.taskPlans, 3, 'incomplete: WrittenFiles taskPlans count');
      assertEq(result.counts.taskSummaries, 2, 'incomplete: WrittenFiles taskSummaries count');
      assertEq(result.counts.sliceSummaries, 1, 'incomplete: WrittenFiles sliceSummaries count');
      assertEq(result.counts.research, 1, 'incomplete: WrittenFiles research count');
      assertEq(result.counts.requirements, 1, 'incomplete: WrittenFiles requirements count');
      assertEq(result.counts.contexts, 1, 'incomplete: WrittenFiles contexts count');

      // (b) parseRoadmap on written roadmap
      console.log('  --- parseRoadmap ---');
      const roadmapContent = readFileSync(join(m, 'M001-ROADMAP.md'), 'utf-8');
      const roadmap = parseRoadmap(roadmapContent);
      assertEq(roadmap.slices.length, 2, 'incomplete: roadmap has 2 slices');
      assertTrue(roadmap.slices[0].done === true, 'incomplete: roadmap S01 is done');
      assertTrue(roadmap.slices[1].done === false, 'incomplete: roadmap S02 is not done');
      assertEq(roadmap.slices[0].id, 'S01', 'incomplete: roadmap slice 0 id');
      assertEq(roadmap.slices[1].id, 'S02', 'incomplete: roadmap slice 1 id');

      // (c) parsePlan on S01 plan
      console.log('  --- parsePlan S01 ---');
      const s01PlanContent = readFileSync(join(m, 'slices', 'S01', 'S01-PLAN.md'), 'utf-8');
      const s01Plan = parsePlan(s01PlanContent);
      assertEq(s01Plan.tasks.length, 2, 'incomplete: S01 plan has 2 tasks');
      assertTrue(s01Plan.tasks[0].done === true, 'incomplete: S01 T01 is done');
      assertTrue(s01Plan.tasks[1].done === true, 'incomplete: S01 T02 is done');

      // (d) parseSummary on S01 summary
      console.log('  --- parseSummary S01 ---');
      const s01SummaryContent = readFileSync(join(m, 'slices', 'S01', 'S01-SUMMARY.md'), 'utf-8');
      const s01Summary = parseSummary(s01SummaryContent);
      assertTrue(
        (s01Summary.frontmatter.key_files as string[]).length > 0,
        'incomplete: S01 summary has key_files',
      );
      assertTrue(
        (s01Summary.frontmatter.provides as string[]).length > 0,
        'incomplete: S01 summary has provides',
      );

      // (e) deriveState
      console.log('  --- deriveState ---');
      invalidateAllCaches();
      const state = await deriveState(base);
      assertEq(state.phase, 'executing', 'incomplete: deriveState phase is executing');
      assertTrue(state.activeMilestone !== null, 'incomplete: deriveState has activeMilestone');
      assertEq(state.activeMilestone!.id, 'M001', 'incomplete: deriveState activeMilestone is M001');
      assertTrue(state.activeSlice !== null, 'incomplete: deriveState has activeSlice');
      assertEq(state.activeSlice!.id, 'S02', 'incomplete: deriveState activeSlice is S02');
      assertTrue(state.activeTask !== null, 'incomplete: deriveState has activeTask');
      assertEq(state.activeTask!.id, 'T03', 'incomplete: deriveState activeTask is T03');
      assertTrue(state.progress!.slices !== undefined, 'incomplete: deriveState has slices progress');
      assertEq(state.progress!.slices!.done, 1, 'incomplete: deriveState slices done count');
      assertEq(state.progress!.slices!.total, 2, 'incomplete: deriveState slices total count');
      assertTrue(state.progress!.tasks !== undefined, 'incomplete: deriveState has tasks progress');
      // S02 has 1 task, 0 done (only active slice tasks counted)
      assertEq(state.progress!.tasks!.done, 0, 'incomplete: deriveState tasks done (in active slice)');
      assertEq(state.progress!.tasks!.total, 1, 'incomplete: deriveState tasks total (in active slice)');
      // Requirements
      assertEq(state.requirements!.active, 1, 'incomplete: deriveState requirements active');
      assertEq(state.requirements!.validated, 1, 'incomplete: deriveState requirements validated');
      assertEq(state.requirements!.deferred, 1, 'incomplete: deriveState requirements deferred');
      assertEq(state.requirements!.outOfScope, 1, 'incomplete: deriveState requirements outOfScope');

      // (f) generatePreview
      console.log('  --- generatePreview ---');
      const preview = generatePreview(project);
      assertEq(preview.milestoneCount, 1, 'incomplete: preview milestoneCount');
      assertEq(preview.totalSlices, 2, 'incomplete: preview totalSlices');
      assertEq(preview.totalTasks, 3, 'incomplete: preview totalTasks');
      assertEq(preview.doneSlices, 1, 'incomplete: preview doneSlices');
      assertEq(preview.doneTasks, 2, 'incomplete: preview doneTasks');
      assertEq(preview.sliceCompletionPct, 50, 'incomplete: preview sliceCompletionPct');
      assertEq(preview.taskCompletionPct, 67, 'incomplete: preview taskCompletionPct');
      assertEq(preview.requirements.active, 1, 'incomplete: preview requirements active');
      assertEq(preview.requirements.validated, 1, 'incomplete: preview requirements validated');
      assertEq(preview.requirements.deferred, 1, 'incomplete: preview requirements deferred');
      assertEq(preview.requirements.outOfScope, 1, 'incomplete: preview requirements outOfScope');
      assertEq(preview.requirements.total, 4, 'incomplete: preview requirements total');

    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── Scenario 2: Fully complete project ────────────────────────────────
  console.log('\n=== Scenario 2: Fully complete project — deriveState phase ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-writer-int-complete-'));
    try {
      const project = buildCompleteProject();
      await writeGSDDirectory(project, base);

      // Null research should NOT produce a file
      const m = join(base, '.gsd', 'milestones', 'M001');
      assertTrue(!existsSync(join(m, 'M001-RESEARCH.md')), 'complete: M001-RESEARCH.md NOT written (null)');
      // No REQUIREMENTS.md since empty requirements
      assertTrue(!existsSync(join(base, '.gsd', 'REQUIREMENTS.md')), 'complete: REQUIREMENTS.md NOT written (empty)');
      // Completed milestone should have VALIDATION and SUMMARY from migration (#819)
      assertTrue(existsSync(join(m, 'M001-VALIDATION.md')), 'complete: M001-VALIDATION.md written for completed milestone');
      assertTrue(existsSync(join(m, 'M001-SUMMARY.md')), 'complete: M001-SUMMARY.md written for completed milestone');

      // deriveState: all slices done, all tasks done — migration now writes
      // VALIDATION.md and SUMMARY.md for completed milestones (#819),
      // so the milestone should be fully complete.
      invalidateAllCaches();
      const state = await deriveState(base);
      assertEq(state.phase, 'complete', 'complete: deriveState phase is complete (validation + summary written by migration)');
      // When all milestones are complete, activeMilestone points to the last entry (for display)
      assertTrue(state.activeMilestone !== null, 'complete: deriveState has activeMilestone (last entry)');
      assertEq(state.activeMilestone!.id, 'M001', 'complete: deriveState activeMilestone is M001');

      // generatePreview for complete project
      const preview = generatePreview(project);
      assertEq(preview.milestoneCount, 1, 'complete: preview milestoneCount');
      assertEq(preview.totalSlices, 1, 'complete: preview totalSlices');
      assertEq(preview.doneSlices, 1, 'complete: preview doneSlices');
      assertEq(preview.totalTasks, 1, 'complete: preview totalTasks');
      assertEq(preview.doneTasks, 1, 'complete: preview doneTasks');
      assertEq(preview.sliceCompletionPct, 100, 'complete: preview sliceCompletionPct');
      assertEq(preview.taskCompletionPct, 100, 'complete: preview taskCompletionPct');
      assertEq(preview.requirements.total, 0, 'complete: preview requirements total');

    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  report();
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
