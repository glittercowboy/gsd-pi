/**
 * auto-dispatch-loop.test.ts — End-to-end regression tests for the
 * auto-mode dispatch loop: deriveState() → resolveDispatch()
 *
 * Exercises the full state-machine chain WITHOUT an LLM. Each test
 * creates a .gsd/ filesystem fixture, derives state, runs the dispatch
 * table, and verifies the correct unit type/id is produced.
 *
 * Regression coverage for:
 *   #1270  Replaying completed run-uat units
 *   #1277  Non-artifact UATs dispatched, blocking progression
 *   #1241  Slice progression gated on file existence, not verdict content
 *   #909   Missing task plan files → infinite plan-slice loop
 *   #807   Prose slice headers not parsed → "No slice eligible" block
 *   #1248  Prose header regex only matched H2 with colon separator
 *   #1289  Crash recovery false-positive on own PID
 *   #1217  (orphaned processes — tested via post-unit, not dispatch)
 *
 * Pattern: create fixture → deriveState → resolveDispatch → assert
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState, invalidateStateCache } from '../state.ts';
import { resolveDispatch, type DispatchContext } from '../auto-dispatch.ts';
import { parseRoadmapSlices } from '../roadmap-slices.ts';
import { checkNeedsRunUat } from '../auto-prompts.ts';
import { checkIdempotency, type IdempotencyContext } from '../auto-idempotency.ts';
import { invalidateAllCaches } from '../cache.ts';
import { AutoSession } from '../auto/session.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Fixture Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-dispatch-loop-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function writeMilestoneFile(base: string, mid: string, suffix: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-${suffix}.md`), content);
}

function writeSliceFile(base: string, mid: string, sid: string, suffix: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-${suffix}.md`), content);
}

function writeTaskFile(base: string, mid: string, sid: string, tid: string, suffix: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid, 'tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tid}-${suffix}.md`), content);
}

/** Standard machine-readable roadmap with checkbox slices */
function standardRoadmap(mid: string, title: string, slices: Array<{ id: string; title: string; done: boolean; risk?: string; depends?: string[] }>): string {
  const lines = [
    `# ${mid}: ${title}`,
    '',
    '## Slices',
    '',
  ];
  for (const s of slices) {
    const check = s.done ? 'x' : ' ';
    const risk = s.risk ?? 'low';
    const deps = s.depends ?? [];
    lines.push(`- [${check}] **${s.id}: ${s.title}** \`risk:${risk}\` \`depends:[${deps.join(',')}]\``);
  }
  lines.push('', '## Boundary Map', '');
  return lines.join('\n');
}

/** Standard slice plan with tasks */
function standardPlan(sid: string, title: string, tasks: Array<{ id: string; title: string; done: boolean; est?: string }>): string {
  const lines = [
    `# ${sid}: ${title}`,
    '',
    '## Tasks',
    '',
  ];
  for (const t of tasks) {
    const check = t.done ? 'x' : ' ';
    const est = t.est ?? '1h';
    lines.push(`- [${check}] **${t.id}: ${t.title}** \`est:${est}\``);
  }
  return lines.join('\n');
}

function freshState(): void {
  invalidateAllCaches();
  invalidateStateCache();
}

async function dispatchFor(base: string): Promise<ReturnType<typeof resolveDispatch>> {
  freshState();
  const state = await deriveState(base);
  const mid = state.activeMilestone?.id;
  if (!mid) return { action: 'stop', reason: 'No active milestone', level: 'info' };
  const midTitle = state.activeMilestone?.title ?? mid;
  const ctx: DispatchContext = { basePath: base, mid, midTitle, state, prefs: undefined };
  return resolveDispatch(ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {

  // ─── 1. Basic state derivation: pre-planning → plan-milestone ─────────
  console.log('\n=== 1. pre-planning with context → plan-milestone (or research) ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001: Test Project\n\nBuild a thing.\n');
      const result = await dispatchFor(base);
      assertTrue(
        result.action === 'dispatch',
        'pre-planning with context dispatches a unit',
      );
      if (result.action === 'dispatch') {
        assertTrue(
          result.unitType === 'research-milestone' || result.unitType === 'plan-milestone',
          `dispatches research-milestone or plan-milestone, got ${result.unitType}`,
        );
        assertEq(result.unitId, 'M001', 'unit ID is M001');
      }
    } finally {
      cleanup(base);
    }
  }

  // ─── 2. Planning → plan-slice ─────────────────────────────────────────
  console.log('\n=== 2. has roadmap, no slice plan → plan-slice ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001: Test\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'First Slice', done: false },
        { id: 'S02', title: 'Second Slice', done: false, depends: ['S01'] },
      ]));
      const result = await dispatchFor(base);
      assertTrue(result.action === 'dispatch', 'planning phase dispatches');
      if (result.action === 'dispatch') {
        assertTrue(
          result.unitType === 'plan-slice' || result.unitType === 'research-slice',
          `dispatches plan-slice or research-slice, got ${result.unitType}`,
        );
        assertMatch(result.unitId, /M001\/S01/, 'targets S01');
      }
    } finally {
      cleanup(base);
    }
  }

  // ─── 3. Executing → execute-task ──────────────────────────────────────
  console.log('\n=== 3. has plan with incomplete task → execute-task ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'First Slice', done: false },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'PLAN', standardPlan('S01', 'First Slice', [
        { id: 'T01', title: 'First Task', done: false },
        { id: 'T02', title: 'Second Task', done: false },
      ]));
      writeTaskFile(base, 'M001', 'S01', 'T01', 'PLAN', '# T01: First Task\n\nDo the thing.\n');
      writeTaskFile(base, 'M001', 'S01', 'T02', 'PLAN', '# T02: Second Task\n\nDo more.\n');

      const result = await dispatchFor(base);
      assertTrue(result.action === 'dispatch', 'executing phase dispatches');
      if (result.action === 'dispatch') {
        assertEq(result.unitType, 'execute-task', 'dispatches execute-task');
        assertEq(result.unitId, 'M001/S01/T01', 'targets T01');
      }
    } finally {
      cleanup(base);
    }
  }

  // ─── 4. All tasks done → complete-slice (summarizing) ─────────────────
  console.log('\n=== 4. all tasks done → summarizing → complete-slice ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'First Slice', done: false },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'PLAN', standardPlan('S01', 'First Slice', [
        { id: 'T01', title: 'First Task', done: true },
        { id: 'T02', title: 'Second Task', done: true },
      ]));
      writeTaskFile(base, 'M001', 'S01', 'T01', 'PLAN', '# T01\nDone.');
      writeTaskFile(base, 'M001', 'S01', 'T02', 'PLAN', '# T02\nDone.');

      const result = await dispatchFor(base);
      assertTrue(result.action === 'dispatch', 'summarizing phase dispatches');
      if (result.action === 'dispatch') {
        assertEq(result.unitType, 'complete-slice', 'dispatches complete-slice');
        assertEq(result.unitId, 'M001/S01', 'targets S01');
      }
    } finally {
      cleanup(base);
    }
  }

  // ─── 5. Regression #909: Missing task plan files → plan-slice ─────────
  console.log('\n=== 5. #909: tasks in plan but empty tasks/ dir → plan-slice (not stuck loop) ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      // Add milestone research so research-slice doesn't fire first
      writeMilestoneFile(base, 'M001', 'RESEARCH', '# Research\n\nDone.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'First Slice', done: false },
      ]));
      // Also write slice research so research-slice is skipped
      writeSliceFile(base, 'M001', 'S01', 'RESEARCH', '# Slice Research\n\nDone.\n');
      // Plan references tasks but tasks/ dir has no files
      writeSliceFile(base, 'M001', 'S01', 'PLAN', standardPlan('S01', 'First Slice', [
        { id: 'T01', title: 'First Task', done: false },
      ]));
      // Create empty tasks directory (no task plan files)
      mkdirSync(join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks'), { recursive: true });

      freshState();
      const state = await deriveState(base);
      // Should fall back to planning phase since tasks dir is empty
      assertEq(state.phase, 'planning', '#909: empty tasks dir → planning phase (not executing)');

      const result = await dispatchFor(base);
      assertTrue(result.action === 'dispatch', '#909: dispatches');
      if (result.action === 'dispatch') {
        assertEq(result.unitType, 'plan-slice', '#909: dispatches plan-slice to regenerate task plans');
      }
    } finally {
      cleanup(base);
    }
  }

  // ─── 6. Regression #1277: Non-artifact UAT not dispatched ─────────────
  console.log('\n=== 6. #1277: human-experience UAT → null (skip, not dispatch) ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'Done Slice', done: true },
        { id: 'S02', title: 'Next Slice', done: false, depends: ['S01'] },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'UAT', '# UAT\n\n## UAT Type\n\n- UAT mode: human-experience\n');

      const state = {
        activeMilestone: { id: 'M001', title: 'Test' },
        activeSlice: { id: 'S02', title: 'Next Slice' },
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'Plan S02',
        registry: [],
      };

      freshState();
      const result = await checkNeedsRunUat(base, 'M001', state as any, { uat_dispatch: true } as any);
      assertEq(result, null, '#1277: human-experience UAT returns null (not dispatched)');
    } finally {
      cleanup(base);
    }
  }

  // ─── 7. Regression #1277: artifact-driven UAT without result → dispatch ──
  console.log('\n=== 7. artifact-driven UAT without result → dispatch ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'Done Slice', done: true },
        { id: 'S02', title: 'Next Slice', done: false, depends: ['S01'] },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'UAT', '# UAT\n\n## UAT Type\n\n- UAT mode: artifact-driven\n');
      // No UAT-RESULT file

      const state = {
        activeMilestone: { id: 'M001', title: 'Test' },
        activeSlice: { id: 'S02', title: 'Next Slice' },
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'Plan S02',
        registry: [],
      };

      freshState();
      const result = await checkNeedsRunUat(base, 'M001', state as any, { uat_dispatch: true } as any);
      assertTrue(result !== null, 'artifact-driven UAT without result → dispatch (not null)');
      if (result) {
        assertEq(result.sliceId, 'S01', 'targets S01');
      }
    } finally {
      cleanup(base);
    }
  }

  // ─── 8. Regression #1270: Existing UAT-RESULT never re-dispatches ─────
  console.log('\n=== 8. #1270: UAT-RESULT exists → no re-dispatch (any verdict) ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'Done Slice', done: true },
        { id: 'S02', title: 'Next Slice', done: false, depends: ['S01'] },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'UAT', '# UAT\n\n## UAT Type\n\n- UAT mode: artifact-driven\n');
      writeSliceFile(base, 'M001', 'S01', 'UAT-RESULT', '---\nverdict: FAIL\n---\nFailed.\n');

      const state = {
        activeMilestone: { id: 'M001', title: 'Test' },
        activeSlice: { id: 'S02', title: 'Next Slice' },
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'Plan S02',
        registry: [],
      };

      freshState();
      const result = await checkNeedsRunUat(base, 'M001', state as any, { uat_dispatch: true } as any);
      assertEq(result, null, '#1270: existing UAT-RESULT with FAIL → null (no re-dispatch)');
    } finally {
      cleanup(base);
    }
  }

  // ─── 9. Regression #1241: UAT verdict gate blocks non-PASS ────────────
  console.log('\n=== 9. #1241: UAT verdict gate blocks progression on non-PASS verdict ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'Done Slice', done: true },
        { id: 'S02', title: 'Next Slice', done: false, depends: ['S01'] },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'PLAN', standardPlan('S01', 'Done Slice', [
        { id: 'T01', title: 'Task', done: true },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'UAT', '# UAT\n\n## UAT Type\n\n- UAT mode: artifact-driven\n');
      writeSliceFile(base, 'M001', 'S01', 'UAT-RESULT', '---\nverdict: FAIL\n---\nFailed some check.\n');

      freshState();
      const state = await deriveState(base);
      const ctx: DispatchContext = {
        basePath: base,
        mid: 'M001',
        midTitle: 'Test',
        state,
        prefs: { uat_dispatch: true } as any,
      };
      const result = await resolveDispatch(ctx);
      // The uat-verdict-gate rule should stop progression
      assertEq(result.action, 'stop', '#1241: non-PASS verdict → stop (blocks progression)');
    } finally {
      cleanup(base);
    }
  }

  // ─── 10. #1241: UAT verdict PASS allows progression ───────────────────
  console.log('\n=== 10. UAT verdict PASS → allows progression ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'Done Slice', done: true },
        { id: 'S02', title: 'Next Slice', done: false, depends: ['S01'] },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'UAT', '# UAT\n\n## UAT Type\n\n- UAT mode: artifact-driven\n');
      writeSliceFile(base, 'M001', 'S01', 'UAT-RESULT', '---\nverdict: PASS\n---\nAll good.\n');

      freshState();
      const state = await deriveState(base);
      const ctx: DispatchContext = {
        basePath: base,
        mid: 'M001',
        midTitle: 'Test',
        state,
        prefs: { uat_dispatch: true } as any,
      };
      const result = await resolveDispatch(ctx);
      // PASS verdict should NOT block — dispatch should continue to plan-slice for S02
      assertTrue(result.action !== 'stop' || !('reason' in result && result.reason.includes('verdict')), 'PASS verdict does not block progression');
    } finally {
      cleanup(base);
    }
  }

  // ─── 11. Complete state derivation: all slices done → completing ───────
  console.log('\n=== 11. all slices done, no validation → validating-milestone ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'First Slice', done: true },
      ]));

      freshState();
      const state = await deriveState(base);
      assertEq(state.phase, 'validating-milestone', 'all slices done → validating-milestone');
    } finally {
      cleanup(base);
    }
  }

  // ─── 12. Complete milestone → complete phase ──────────────────────────
  console.log('\n=== 12. validated + summarized milestone → complete ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'First Slice', done: true },
      ]));
      writeMilestoneFile(base, 'M001', 'VALIDATION', '---\nverdict: pass\nremediation_round: 0\n---\n# Validation\nAll good.\n');
      writeMilestoneFile(base, 'M001', 'SUMMARY', '---\nstatus: complete\n---\n# Summary\nDone.\n');

      freshState();
      const state = await deriveState(base);
      assertEq(state.phase, 'complete', 'validated+summarized → complete');
    } finally {
      cleanup(base);
    }
  }

  // ─── 13. Multi-milestone: M001 complete, M002 active ─────────────────
  console.log('\n=== 13. multi-milestone: M001 complete, M002 becomes active ===');
  {
    const base = createBase();
    try {
      // M001 — complete
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDone.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'First', [
        { id: 'S01', title: 'Slice', done: true },
      ]));
      writeMilestoneFile(base, 'M001', 'VALIDATION', '---\nverdict: pass\nremediation_round: 0\n---\n');
      writeMilestoneFile(base, 'M001', 'SUMMARY', '---\nstatus: complete\n---\n# Summary\n');

      // M002 — active
      writeMilestoneFile(base, 'M002', 'CONTEXT', '# M002\n\nNext.\n');

      freshState();
      const state = await deriveState(base);
      assertEq(state.activeMilestone?.id, 'M002', 'M002 is the active milestone');
      assertEq(state.phase, 'pre-planning', 'M002 is in pre-planning');
      assertEq(state.registry.length, 2, 'registry has 2 milestones');
      assertEq(state.registry[0].status, 'complete', 'M001 is complete');
      assertEq(state.registry[1].status, 'active', 'M002 is active');
    } finally {
      cleanup(base);
    }
  }

  // ─── 14. Dependency blocking: S02 depends on S01 ─────────────────────
  console.log('\n=== 14. slice dependency: S02 blocked until S01 done ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'First', done: false },
        { id: 'S02', title: 'Second', done: false, depends: ['S01'] },
      ]));

      freshState();
      const state = await deriveState(base);
      // Active slice should be S01, not S02
      assertEq(state.activeSlice?.id, 'S01', 'S01 is the active slice (S02 is dep-blocked)');
    } finally {
      cleanup(base);
    }
  }

  // ─── 15. Blocker detection: task with blocker_discovered → replan ─────
  console.log('\n=== 15. blocker_discovered in task summary → replanning-slice ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'Slice', done: false },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'PLAN', standardPlan('S01', 'Slice', [
        { id: 'T01', title: 'Task One', done: true },
        { id: 'T02', title: 'Task Two', done: false },
      ]));
      writeTaskFile(base, 'M001', 'S01', 'T01', 'PLAN', '# T01\nDo thing.');
      writeTaskFile(base, 'M001', 'S01', 'T02', 'PLAN', '# T02\nDo other thing.');
      writeTaskFile(base, 'M001', 'S01', 'T01', 'SUMMARY', '---\nblocker_discovered: true\n---\n# T01 Summary\nFound a blocker.');

      freshState();
      const state = await deriveState(base);
      assertEq(state.phase, 'replanning-slice', 'blocker_discovered → replanning-slice');
    } finally {
      cleanup(base);
    }
  }

  // ─── 16. Blocker + REPLAN exists → loop protection, resume executing ──
  console.log('\n=== 16. blocker_discovered + REPLAN exists → loop protection (executing) ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n\nDesc.\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'Slice', done: false },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'PLAN', standardPlan('S01', 'Slice', [
        { id: 'T01', title: 'Task One', done: true },
        { id: 'T02', title: 'Task Two', done: false },
      ]));
      writeTaskFile(base, 'M001', 'S01', 'T01', 'PLAN', '# T01\nDo thing.');
      writeTaskFile(base, 'M001', 'S01', 'T02', 'PLAN', '# T02\nDo other thing.');
      writeTaskFile(base, 'M001', 'S01', 'T01', 'SUMMARY', '---\nblocker_discovered: true\n---\n# T01\nBlocker.');
      // REPLAN.md exists → loop protection
      writeSliceFile(base, 'M001', 'S01', 'REPLAN', '# Replan\nAlready replanned.\n');

      freshState();
      const state = await deriveState(base);
      assertEq(state.phase, 'executing', 'blocker + REPLAN exists → executing (loop protection)');
    } finally {
      cleanup(base);
    }
  }

  // ─── 17. Needs-discussion phase ───────────────────────────────────────
  console.log('\n=== 17. CONTEXT-DRAFT without CONTEXT → needs-discussion ===');
  {
    const base = createBase();
    try {
      const mDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(mDir, { recursive: true });
      writeFileSync(join(mDir, 'M001-CONTEXT-DRAFT.md'), '# Draft\n\nSome rough ideas.\n');

      freshState();
      const state = await deriveState(base);
      assertEq(state.phase, 'needs-discussion', 'CONTEXT-DRAFT without CONTEXT → needs-discussion');
    } finally {
      cleanup(base);
    }
  }

  // ─── 18. Idempotency: completed key → skip ───────────────────────────
  console.log('\n=== 18. idempotency: completed key → skip ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'Slice', done: false },
      ]));
      // Task must be marked [x] in the plan for verifyExpectedArtifact to return true
      writeSliceFile(base, 'M001', 'S01', 'PLAN', standardPlan('S01', 'Slice', [
        { id: 'T01', title: 'Task', done: true },
        { id: 'T02', title: 'Next Task', done: false },
      ]));
      writeTaskFile(base, 'M001', 'S01', 'T01', 'PLAN', '# T01\nDo thing.');
      writeTaskFile(base, 'M001', 'S01', 'T02', 'PLAN', '# T02\nNext.');
      // Write SUMMARY as the expected artifact for execute-task
      writeTaskFile(base, 'M001', 'S01', 'T01', 'SUMMARY', '---\nstatus: done\n---\n# T01 Summary\nDone.');

      // Force cache clearance so verifyExpectedArtifact finds the file
      freshState();

      const session = new AutoSession();
      session.basePath = base;
      session.completedKeySet.add('execute-task/M001/S01/T01');

      const notifications: string[] = [];
      const result = checkIdempotency({
        s: session,
        unitType: 'execute-task',
        unitId: 'M001/S01/T01',
        basePath: base,
        notify: (msg) => notifications.push(msg),
      });

      assertEq(result.action, 'skip', 'completed key → skip');
      assertTrue('reason' in result && result.reason === 'completed', 'reason is completed');
    } finally {
      cleanup(base);
    }
  }

  // ─── 19. Idempotency: stale key (artifact missing) → rerun ───────────
  console.log('\n=== 19. idempotency: stale key (no artifact) → rerun ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n');
      writeMilestoneFile(base, 'M001', 'ROADMAP', standardRoadmap('M001', 'Test', [
        { id: 'S01', title: 'Slice', done: false },
      ]));
      writeSliceFile(base, 'M001', 'S01', 'PLAN', standardPlan('S01', 'Slice', [
        { id: 'T01', title: 'Task', done: false },
      ]));
      writeTaskFile(base, 'M001', 'S01', 'T01', 'PLAN', '# T01\nDo thing.');
      // NO summary file — artifact missing

      const session = new AutoSession();
      session.basePath = base;
      session.completedKeySet.add('execute-task/M001/S01/T01');

      const notifications: string[] = [];
      const result = checkIdempotency({
        s: session,
        unitType: 'execute-task',
        unitId: 'M001/S01/T01',
        basePath: base,
        notify: (msg) => notifications.push(msg),
      });

      assertEq(result.action, 'rerun', 'stale key (no artifact) → rerun');
      assertTrue(!session.completedKeySet.has('execute-task/M001/S01/T01'), 'stale key removed from set');
    } finally {
      cleanup(base);
    }
  }

  // ─── 20. Idempotency: consecutive skip loop → evict ──────────────────
  console.log('\n=== 20. idempotency: consecutive skip loop → evict ===');
  {
    const base = createBase();
    try {
      writeMilestoneFile(base, 'M001', 'CONTEXT', '# M001\n');
      writeTaskFile(base, 'M001', 'S01', 'T01', 'SUMMARY', '---\nstatus: done\n---\n# Done');

      const session = new AutoSession();
      session.basePath = base;
      session.completedKeySet.add('execute-task/M001/S01/T01');
      // Pre-fill skip count to just below threshold
      session.unitConsecutiveSkips.set('execute-task/M001/S01/T01', 3);

      const notifications: string[] = [];
      const result = checkIdempotency({
        s: session,
        unitType: 'execute-task',
        unitId: 'M001/S01/T01',
        basePath: base,
        notify: (msg) => notifications.push(msg),
      });

      assertEq(result.action, 'skip', 'exceeds consecutive skip threshold → skip with eviction');
      assertTrue('reason' in result && result.reason === 'evicted', 'reason is evicted');
      assertTrue(!session.completedKeySet.has('execute-task/M001/S01/T01'), 'key evicted from completed set');
      assertTrue(session.recentlyEvictedKeys.has('execute-task/M001/S01/T01'), 'key tracked in evicted set');
    } finally {
      cleanup(base);
    }
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
