/**
 * Regression test for #1808: Completion-transition doctor fix deferral
 * creates fragile handoff window.
 *
 * Only slice summary should be deferred (needs LLM content).
 * Roadmap checkbox and UAT stub are mechanical bookkeeping and must be
 * fixed immediately at task fixLevel to prevent inconsistent state if the
 * session stops between last task and complete-slice.
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runGSDDoctor } from "../doctor.ts";
import { COMPLETION_TRANSITION_CODES } from "../doctor-types.ts";

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `doctor-deferral-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a minimal .gsd structure: milestone with one slice, one task
 * marked done with a summary — but no slice summary, no UAT, and
 * roadmap unchecked. This is the state after the last task completes.
 */
function buildScaffold(base: string) {
  const gsd = join(base, ".gsd");
  const m = join(gsd, "milestones", "M001");
  const s = join(m, "slices", "S01", "tasks");
  mkdirSync(s, { recursive: true });

  writeFileSync(join(m, "M001-ROADMAP.md"), `# M001: Test

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > Demo text
`);

  writeFileSync(join(m, "slices", "S01", "S01-PLAN.md"), `# S01: Test Slice

**Goal:** test

## Tasks

- [x] **T01: Do stuff** \`est:5m\`
`);

  writeFileSync(join(s, "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
duration: 5m
verification_result: passed
completed_at: 2026-01-01
---

# T01: Do stuff

Done.
`);
}

test("COMPLETION_TRANSITION_CODES only contains slice summary code", () => {
  assert.ok(
    COMPLETION_TRANSITION_CODES.has("all_tasks_done_missing_slice_summary"),
    "summary code should still be deferred"
  );
  assert.ok(
    !COMPLETION_TRANSITION_CODES.has("all_tasks_done_missing_slice_uat"),
    "UAT code should NOT be deferred"
  );
  assert.ok(
    !COMPLETION_TRANSITION_CODES.has("all_tasks_done_roadmap_not_checked"),
    "roadmap code should NOT be deferred"
  );
});

test("fixLevel:task — fixes UAT stub immediately, defers summary and roadmap checkbox (#1808, #1910)", async () => {
  const tmp = makeTmp("partial-deferral");
  try {
    buildScaffold(tmp);

    const report = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

    // Should detect all three issues
    const codes = report.issues.map(i => i.code);
    assert.ok(codes.includes("all_tasks_done_missing_slice_summary"), "should detect missing summary");
    assert.ok(codes.includes("all_tasks_done_missing_slice_uat"), "should detect missing UAT");
    assert.ok(codes.includes("all_tasks_done_roadmap_not_checked"), "should detect unchecked roadmap");

    // Summary should NOT be created (still deferred — needs LLM content)
    const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    assert.ok(!existsSync(sliceSummaryPath), "should NOT have created summary stub (deferred)");

    // UAT stub SHOULD be created (mechanical bookkeeping, no longer deferred)
    const sliceUatPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-UAT.md");
    assert.ok(existsSync(sliceUatPath), "should have created UAT stub immediately");

    // Roadmap checkbox must NOT be checked without summary on disk (#1910).
    // Checking it without the summary causes deriveState() to skip complete-slice.
    const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
    assert.ok(roadmapContent.includes("- [ ] **S01"), "roadmap must NOT be checked without summary on disk (#1910)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fixLevel:task — session crash after last task leaves UAT consistent, roadmap deferred with summary (#1808, #1910)", async () => {
  const tmp = makeTmp("crash-consistency");
  try {
    buildScaffold(tmp);

    // Simulate: doctor runs at task level (as auto-mode does after last task)
    await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

    // Now simulate a session crash — no complete-slice ever runs.
    // A new session starts and runs doctor again at task level.
    const report2 = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

    const remainingCodes = report2.issues.map(i => i.code);
    assert.ok(
      !remainingCodes.includes("all_tasks_done_missing_slice_uat"),
      "UAT should already be fixed from first doctor run"
    );
    // Summary is still missing (deferred), that is expected
    assert.ok(
      remainingCodes.includes("all_tasks_done_missing_slice_summary"),
      "summary should still be detected as missing (deferred)"
    );
    // Roadmap should still be unchecked because summary doesn't exist (#1910)
    assert.ok(
      remainingCodes.includes("all_tasks_done_roadmap_not_checked"),
      "roadmap should still be unchecked — summary does not exist on disk (#1910)"
    );
    // Must NOT produce the cascade error from checking roadmap without summary
    assert.ok(
      !remainingCodes.includes("slice_checked_missing_summary"),
      "must not produce slice_checked_missing_summary (#1910)"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
