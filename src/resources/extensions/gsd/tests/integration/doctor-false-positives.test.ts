import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runGSDDoctor } from "../../doctor.js";
import { parsePlan } from "../../parsers-legacy.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBase(): { base: string; gsd: string; mDir: string } {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-fp-"));
  const gsd = join(base, ".gsd");
  const mDir = join(gsd, "milestones", "M001");
  mkdirSync(join(mDir, "slices"), { recursive: true });
  return { base, gsd, mDir };
}

function writeRoadmap(mDir: string, content: string): void {
  writeFileSync(join(mDir, "M001-ROADMAP.md"), content);
}

function writeSlice(mDir: string, sliceId: string, planContent: string): string {
  const sDir = join(mDir, "slices", sliceId);
  const tDir = join(sDir, "tasks");
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(sDir, `${sliceId}-PLAN.md`), planContent);
  return sDir;
}

describe('doctor false-positives (#3105)', async () => {

  // ═══════════════════════════════════════════════════════════════════════════
  // Bug 1: Orphaned worktree directory recreated by appendDoctorHistory
  // ═══════════════════════════════════════════════════════════════════════════

  test('Bug 1: orphaned worktree check ignores dirs containing only .gsd/doctor-history.jsonl', async () => {
    // Simulate: a worktree dir that only contains .gsd/doctor-history.jsonl
    // (created by appendDoctorHistory writing to the worktree-scoped path).
    // The orphan check should NOT warn about this directory.
    const { base, gsd } = makeBase();
    writeRoadmap(join(gsd, "milestones", "M001"), `# M001: Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeSlice(join(gsd, "milestones", "M001"), "S01", "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n  Pending.\n");

    // Create a worktree directory that only has .gsd/doctor-history.jsonl
    const wtDir = join(gsd, "worktrees", "M042");
    const wtGsdDir = join(wtDir, ".gsd");
    mkdirSync(wtGsdDir, { recursive: true });
    writeFileSync(join(wtGsdDir, "doctor-history.jsonl"), '{"ts":"2026-01-01","ok":true}\n');

    const result = await runGSDDoctor(base, { fix: false });

    // Should NOT produce worktree_directory_orphaned for a dir that only has doctor history
    const orphanIssues = result.issues.filter(
      i => i.code === "worktree_directory_orphaned" && i.unitId === "M042"
    );
    assert.equal(orphanIssues.length, 0,
      "should not warn about worktree dir that only contains .gsd/doctor-history.jsonl");

    rmSync(base, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Bug 2: blocker_discovered + all tasks done = unfixable deadlock
  // ═══════════════════════════════════════════════════════════════════════════

  test('Bug 2: blocker_discovered with all tasks done should not warn (implicitly resolved)', async () => {
    // Scenario: blocker was discovered and resolved within the same task.
    // blocker_discovered: true, no REPLAN, but all tasks are done.
    // Neither blocker_discovered_no_replan nor stale_replan_file should fire.
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Blocker Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    const sDir = writeSlice(mDir, "S01",
      "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [x] **T01: Task** `est:10m`\n  Done.\n");
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
provides: []
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 10m
verification_result: passed
completed_at: 2026-01-01T00:00:00Z
blocker_discovered: true
---

# T01: Task

**Done**

## What Happened
Found a blocker, resolved it in-task.

## Diagnostics
- log
`);

    const result = await runGSDDoctor(base, { fix: false });

    // Should NOT produce blocker_discovered_no_replan when all tasks are done
    const blockerIssues = result.issues.filter(i => i.code === "blocker_discovered_no_replan");
    assert.equal(blockerIssues.length, 0,
      "should not warn about blocker_discovered when all tasks are done (blocker was implicitly resolved)");

    // Also should NOT produce stale_replan_file (no REPLAN exists, so this shouldn't fire anyway)
    const staleReplanIssues = result.issues.filter(i => i.code === "stale_replan_file");
    assert.equal(staleReplanIssues.length, 0,
      "should not produce stale_replan_file when no REPLAN exists");

    rmSync(base, { recursive: true, force: true });
  });

  test('Bug 2: blocker_discovered with incomplete tasks should still warn', async () => {
    // Sanity check: when there IS an incomplete task and blocker_discovered, warn as before.
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Blocker Warn Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    const sDir = writeSlice(mDir, "S01",
      "# S01: Slice\n\n**Goal:** G\n**Demo:** D\n\n## Tasks\n- [x] **T01: Task A** `est:10m`\n  Done.\n- [ ] **T02: Task B** `est:10m`\n  Pending.\n");
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
provides: []
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 10m
verification_result: passed
completed_at: 2026-01-01T00:00:00Z
blocker_discovered: true
---

# T01: Task A

**Done**

## What Happened
Found blocker, but T02 is still pending.

## Diagnostics
- log
`);

    const result = await runGSDDoctor(base, { fix: false });

    const blockerIssues = result.issues.filter(i => i.code === "blocker_discovered_no_replan");
    assert.ok(blockerIssues.length > 0,
      "should still warn about blocker_discovered when some tasks are not done");

    rmSync(base, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Bug 3: Multi-task plan — T02+ outside ## Tasks section
  // ═══════════════════════════════════════════════════════════════════════════

  test('Bug 3: parsePlan finds all tasks even when interleaved with detail sections', () => {
    // Multi-task plan where T02 checkbox appears after T01's ## Steps heading,
    // which ends the ## Tasks section for extractSection().
    const planContent = `# S01: Demo Slice

**Goal:** Build the demo
**Demo:** Run it

## Must-Haves
- Feature A

## Tasks
- [x] **T01: First task** \`est:30m\`
  Implement the first thing.
## Steps
1. Step one
2. Step two
## Must-Haves
- Requirement A
- [x] **T02: Second task** \`est:1h\`
  Implement the second thing.
## Steps
1. Step one
2. Step two
`;

    const plan = parsePlan(planContent);
    const taskIds = plan.tasks.map(t => t.id);

    assert.ok(taskIds.includes("T01"), "should find T01");
    assert.ok(taskIds.includes("T02"), "should find T02 even when after T01 detail headings");
    assert.equal(plan.tasks.length, 2, "should find exactly 2 tasks");
  });

  test('Bug 3: task_file_not_in_plan should not fire for T02 in multi-task plan', async () => {
    const { base, mDir } = makeBase();
    writeRoadmap(mDir, `# M001: Multi-Task Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);

    // Plan with interleaved headings (the problematic format)
    const sDir = writeSlice(mDir, "S01", `# S01: Demo Slice

**Goal:** Build the demo
**Demo:** Run it

## Must-Haves
- Feature A

## Tasks
- [x] **T01: First task** \`est:30m\`
  Implement the first thing.
## Steps
1. Step one
## Must-Haves
- Req A
- [x] **T02: Second task** \`est:1h\`
  Implement the second thing.
## Steps
1. Step one
`);

    // Both tasks have summaries on disk
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), "---\nstatus: done\ncompleted_at: 2026-01-01T00:00:00Z\n---\n# T01\nDone.\n");
    writeFileSync(join(sDir, "tasks", "T02-SUMMARY.md"), "---\nstatus: done\ncompleted_at: 2026-01-01T00:00:00Z\n---\n# T02\nDone.\n");

    const result = await runGSDDoctor(base, { fix: false });

    // T02 should NOT be flagged as "not in plan"
    const notInPlan = result.issues.filter(
      i => i.code === "task_file_not_in_plan" && i.message.includes("T02")
    );
    assert.equal(notInPlan.length, 0,
      "should not report T02 as 'not in plan' when it exists in the interleaved plan format");

    rmSync(base, { recursive: true, force: true });
  });
});
