// Regression test for https://github.com/gsd-build/gsd-2/issues/3191
// Verifies that a milestone with a stub ROADMAP file and zero DB slices but an
// existing CONTEXT-DRAFT returns 'needs-discussion', not 'pre-planning'.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deriveState } from '../state.js';

let passed = 0;
let failed = 0;

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-draft-roadmap-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeContextDraft(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT-DRAFT.md`), content);
}

function writeContext(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), content);
}

function writeRoadmap(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Groups
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {

  // ─── Test A: ROADMAP + CONTEXT-DRAFT + zero DB slices → needs-discussion ──
  // (#3191) The hasRoadmap branch was ignoring activeMilestoneHasDraft.
  console.log('\n=== Test A: ROADMAP + CONTEXT-DRAFT + zero slices → needs-discussion ===');
  {
    const base = createFixtureBase();
    try {
      // Stub ROADMAP file with no slices listed
      writeRoadmap(base, 'M001', '# M001: Stub Roadmap\n\n**Vision:** TBD.\n\n## Slices\n\n(none yet)\n');
      // CONTEXT-DRAFT present — user still needs to discuss context
      writeContextDraft(base, 'M001', '# Draft Context\n\nSeed discussion material.');

      const state = await deriveState(base);

      assertEq(state.phase, 'needs-discussion', 'Test A: phase should be needs-discussion (#3191)');
      assertEq(state.activeMilestone?.id, 'M001', 'Test A: activeMilestone id is M001');
      assertEq(state.activeSlice, null, 'Test A: activeSlice is null');
      assertEq(state.activeTask, null, 'Test A: activeTask is null');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test B: ROADMAP + no CONTEXT-DRAFT + zero DB slices → pre-planning ──
  // The existing behaviour for stub roadmaps without a draft must not regress.
  console.log('\n=== Test B: ROADMAP + no CONTEXT-DRAFT + zero slices → pre-planning ===');
  {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', '# M001: Stub Roadmap\n\n**Vision:** TBD.\n\n## Slices\n\n(none yet)\n');
      // No CONTEXT-DRAFT — should remain pre-planning

      const state = await deriveState(base);

      assertEq(state.phase, 'pre-planning', 'Test B: phase should be pre-planning when no draft');
      assertEq(state.activeMilestone?.id, 'M001', 'Test B: activeMilestone id is M001');
    } finally {
      cleanup(base);
    }
  }

  // ─── Test C: ROADMAP + CONTEXT (not draft) + zero slices → pre-planning ──
  // A finalised CONTEXT.md alongside a stub ROADMAP should not trigger needs-discussion.
  console.log('\n=== Test C: ROADMAP + CONTEXT (not draft) + zero slices → pre-planning ===');
  {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, 'M001', '# M001: Stub Roadmap\n\n**Vision:** TBD.\n\n## Slices\n\n(none yet)\n');
      // CONTEXT.md present (finalised) — suppresses draft flag even if CONTEXT-DRAFT also existed
      writeContext(base, 'M001', '---\ntitle: Full Context\n---\n\n# M001\n\nReady for planning.');

      const state = await deriveState(base);

      assertEq(state.phase, 'pre-planning', 'Test C: phase should be pre-planning when CONTEXT.md exists');
      assertEq(state.activeMilestone?.id, 'M001', 'Test C: activeMilestone id is M001');
    } finally {
      cleanup(base);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`stub-roadmap draft-phase routing: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
