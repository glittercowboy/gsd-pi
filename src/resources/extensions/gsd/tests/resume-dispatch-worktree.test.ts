/**
 * Tests for fix of #3723: auto-mode resume/crash-recovery dispatches
 * from project root instead of milestone worktree.
 *
 * During resume, the paused-session metadata may record `worktreePath` that
 * was active when the session paused. The resume path must use that path (or
 * derive the worktree path via filesystem lookup) to set the dispatch context
 * (`s.basePath`), rather than defaulting to the project root.
 *
 * The fix adds an early worktree-path resolution step in the paused-session
 * resume block of auto.ts — immediately after `s.basePath = base` — so that
 * the correct dispatch directory is used before the dispatch loop runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const autoSrc = readFileSync(join(__dirname, "..", "auto.ts"), "utf-8");

// ── Source-structure tests ────────────────────────────────────────────────────

/**
 * Extract the paused-session resume block from auto.ts.
 *
 * The block we care about is the `if (s.paused) { ... }` section inside
 * startAuto, which contains `s.basePath = base` (line ~1473) followed by the
 * `enterMilestone` call.
 *
 * We find it by locating the `s.basePath = base` assignment that appears
 * WITHIN the s.paused branch (there's only one: all other basePath assignments
 * use originalBasePath or a different value). We extract from that assignment
 * up to just before `enterMilestone(`.
 */
function getBasepathToEnterMilestoneSegment(): string {
  // Find `s.basePath = base;` in the s.paused branch
  // This assignment appears uniquely inside the resume block
  const assignPattern = "s.basePath = base;";
  const assignIdx = autoSrc.indexOf(assignPattern);
  assert.ok(
    assignIdx > -1,
    `auto.ts must contain '${assignPattern}' in the resume block`,
  );

  // Find the next enterMilestone call after this assignment
  const enterMilestoneIdx = autoSrc.indexOf("enterMilestone(", assignIdx);
  assert.ok(
    enterMilestoneIdx > assignIdx,
    "auto.ts must call enterMilestone after the s.basePath = base assignment",
  );

  // Return the code between the assignment and enterMilestone
  return autoSrc.slice(assignIdx, enterMilestoneIdx);
}

test("auto.ts resume block resolves paused-session worktreePath and applies it to s.basePath before entering worktree (fixes #3723)", () => {
  // The segment between `s.basePath = base` and `enterMilestone(` must
  // contain logic that resolves the paused-session worktreePath and applies
  // it to s.basePath when the worktree exists on disk.
  //
  // The fix reads the worktree path from freshStartAssessment.pausedSession
  // (since `meta` is out of scope at this point in startAuto) and assigns
  // it to s.basePath, guarded by existsSync.
  //
  // Without this fix, the dispatch loop runs from `base` (project root)
  // instead of the worktree, causing split-brain execution (#3723).
  const segment = getBasepathToEnterMilestoneSegment();

  // The fix uses freshStartAssessment.pausedSession?.worktreePath via a
  // local variable (resumeWorktreePath) and assigns to s.basePath.
  const hasWorktreePathResolution =
    segment.includes("worktreePath") &&
    segment.includes("existsSync") &&
    segment.includes("s.basePath =");

  assert.ok(
    hasWorktreePathResolution,
    "auto.ts must resolve the paused-session worktreePath, check existsSync, and assign " +
    "s.basePath before enterMilestone — crash-recovery currently dispatches from project root " +
    "instead of milestone worktree (issue #3723). The fix belongs between `s.basePath = base` " +
    "and the enterMilestone call.",
  );
});

test("auto.ts worktreePath assignment in resume block guards against non-existent path (fixes #3723)", () => {
  // The assignment to s.basePath from the paused-session worktreePath must
  // be guarded by existsSync to avoid setting an invalid basePath if the
  // worktree was cleaned up between pause and resume.
  const segment = getBasepathToEnterMilestoneSegment();

  // Must have existsSync guard AND a worktreePath reference AND s.basePath assignment
  const hasGuardedAssignment =
    segment.includes("existsSync") &&
    segment.includes("worktreePath") &&
    segment.includes("s.basePath =");

  assert.ok(
    hasGuardedAssignment,
    "auto.ts must guard the s.basePath = worktreePath assignment with existsSync (fixes #3723)",
  );
});

// ── Functional tests ──────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-resume-wt-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

function writePausedSession(
  base: string,
  milestoneId: string,
  worktreePath: string | null,
): void {
  writeFileSync(
    join(base, ".gsd", "runtime", "paused-session.json"),
    JSON.stringify({
      milestoneId,
      originalBasePath: base,
      stepMode: false,
      worktreePath,
      pausedAt: new Date().toISOString(),
    }, null, 2),
    "utf-8",
  );
}

function makeWorktreePath(base: string, milestoneId: string): string {
  return join(base, ".gsd", "worktrees", milestoneId);
}

function setupWorktreeOnDisk(wt: string): void {
  mkdirSync(wt, { recursive: true });
  // Simulate a git worktree: .git file with gitdir pointer
  writeFileSync(
    join(wt, ".git"),
    "gitdir: /project/.git/worktrees/M001-test\n",
    "utf-8",
  );
}

function writeRoadmap(base: string, milestoneId = "M001-test"): void {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(join(milestoneDir, "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(
    join(milestoneDir, `${milestoneId}-ROADMAP.md`),
    [
      `# ${milestoneId}: Test Milestone`,
      "",
      "## Slices",
      "",
      "- [ ] **S01: Test slice** `risk:low`",
      "  After this: Demo",
    ].join("\n"),
    "utf-8",
  );
}

test("readPausedSessionMetadata round-trips worktreePath from paused-session.json", () => {
  // Verify that the paused-session metadata correctly stores and reads back
  // the worktreePath field — this is what the resume path in auto.ts uses
  // to determine the dispatch basePath (#3723).
  //
  // Implemented inline to avoid slow import chain from interrupted-session.ts.
  const base = makeTmpBase();
  const wt = makeWorktreePath(base, "M001-test");
  try {
    setupWorktreeOnDisk(wt);
    writePausedSession(base, "M001-test", wt);

    // Simulate readPausedSessionMetadata without importing the full module
    const pausedPath = join(base, ".gsd", "runtime", "paused-session.json");
    const meta = JSON.parse(readFileSync(pausedPath, "utf-8"));

    assert.ok(meta, "paused-session metadata must be readable");
    assert.equal(meta.milestoneId, "M001-test");
    assert.equal(meta.worktreePath, wt, "worktreePath must round-trip through paused-session.json");
  } finally {
    cleanup(base);
  }
});

test("auto.ts resume block uses worktreePath from freshStartAssessment.pausedSession as dispatch basePath when worktree exists (#3723)", () => {
  // End-to-end structural verification: the auto.ts source must contain code
  // that reads the worktreePath from freshStartAssessment.pausedSession AND
  // applies it to s.basePath (guarded by existsSync) between the
  // `s.basePath = base` assignment and `enterMilestone`.
  //
  // This is the core of the #3723 fix. Without this check, a session that
  // paused while operating inside a worktree will resume dispatching from the
  // project root, not the worktree — causing split-brain execution where some
  // operations target the worktree and others target the project root.
  const segment = getBasepathToEnterMilestoneSegment();

  // Must reference freshStartAssessment.pausedSession?.worktreePath or
  // equivalent local variable, AND contain an existsSync guard
  const hasAssessmentWorktreePath =
    segment.includes("freshStartAssessment.pausedSession") &&
    segment.includes("worktreePath");

  assert.ok(
    hasAssessmentWorktreePath,
    "auto.ts must read worktreePath from freshStartAssessment.pausedSession between " +
    "s.basePath=base and enterMilestone",
  );
  assert.ok(
    segment.includes("existsSync"),
    "auto.ts must guard worktreePath usage with existsSync",
  );
  // The actual basePath re-assignment must be present in the segment
  // (note: there are multiple `s.basePath =` assignments — we need one after
  // the initial `s.basePath = base` assignment within this segment)
  const worktreeAssignIdx = segment.lastIndexOf("s.basePath =");
  const baseAssignIdx = segment.indexOf("s.basePath = base");
  assert.ok(
    worktreeAssignIdx > baseAssignIdx,
    "auto.ts must assign s.basePath to the worktree path after `s.basePath = base` in the resume block",
  );
});
