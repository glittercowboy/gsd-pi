import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  writeLock,
  clearLock,
  readCrashLock,
  isLockProcessAlive,
  formatCrashInfo,
  type LockData,
} from "../crash-recovery.ts";
import {
  assessInterruptedSession,
  hasResumableDerivedState,
  isBootstrapCrashLock,
  readPausedSessionMetadata,
} from "../interrupted-session.ts";
import { gsdRoot } from "../paths.ts";
import type { GSDState } from "../types.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

function writeTestLock(
  base: string,
  unitType: string,
  unitId: string,
  sessionFile?: string,
): void {
  writeFileSync(
    join(gsdRoot(base), "auto.lock"),
    JSON.stringify({
      pid: 999999999,
      startedAt: new Date().toISOString(),
      unitType,
      unitId,
      unitStartedAt: new Date().toISOString(),
      sessionFile,
    }, null, 2),
    "utf-8",
  );
}

function writeRoadmap(base: string, checked = false): void {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(join(milestoneDir, "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Vision",
      "",
      "Test milestone.",
      "",
      "## Success Criteria",
      "",
      "- It works.",
      "",
      "## Slices",
      "",
      `- [${checked ? "x" : " "}] **S01: Test slice** \`risk:low\``,
      "  After this: Demo",
      "",
      "## Boundary Map",
      "",
      "- S01 → terminal",
      "  - Produces: done",
      "  - Consumes: nothing",
    ].join("\n"),
    "utf-8",
  );
}

function writeCompleteSliceArtifacts(base: string): void {
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\nDone.\n", "utf-8");
  writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.\n", "utf-8");
}

function writeCompleteMilestoneSummary(base: string): void {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# Milestone Summary\nDone.\n", "utf-8");
}

function writePausedSession(
  base: string,
  milestoneId = "M001",
  stepMode = false,
  worktreePath?: string,
  unitType?: string,
  unitId?: string,
): void {
  const runtimeDir = join(base, ".gsd", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "paused-session.json"),
    JSON.stringify({ milestoneId, originalBasePath: base, stepMode, worktreePath, unitType, unitId }, null, 2),
    "utf-8",
  );
}

function writeActivityLog(base: string, entries: Record<string, unknown>[]): void {
  const activityDir = join(base, ".gsd", "activity");
  mkdirSync(activityDir, { recursive: true });
  writeFileSync(
    join(activityDir, "001-execute-task-M001-S01-T01.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf-8",
  );
}

function makeState(phase: GSDState["phase"], activeMilestone = true): GSDState {
  return {
    activeMilestone: activeMilestone ? { id: "M001", title: "Test" } : null,
    activeSlice: null,
    activeTask: null,
    phase,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  };
}

// ─── interrupted-session helpers ───────────────────────────────────────────

test("hasResumableDerivedState treats only unfinished active work as resumable", () => {
  assert.equal(hasResumableDerivedState(makeState("executing")), true);
  assert.equal(hasResumableDerivedState(makeState("complete")), false);
  assert.equal(hasResumableDerivedState(makeState("pre-planning", false)), false);
});

test("isBootstrapCrashLock detects starting/bootstrap special case", () => {
  const bootstrap: LockData = {
    pid: 999999999,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isBootstrapCrashLock(bootstrap), true);
  assert.equal(isBootstrapCrashLock({ ...bootstrap, unitType: "execute-task" }), false);
});

test("readPausedSessionMetadata reads paused-session metadata when present", () => {
  const base = makeTmpBase();
  try {
    writePausedSession(base, "M009");
    const meta = readPausedSessionMetadata(base);
    assert.equal(meta?.milestoneId, "M009");
  } finally {
    cleanup(base);
  }
});

test("readPausedSessionMetadata preserves unitType and unitId through round-trip", () => {
  const base = makeTmpBase();
  try {
    writePausedSession(base, "M001", false, undefined, "execute-task", "M001/S01/T02");
    const meta = readPausedSessionMetadata(base);
    assert.equal(meta?.unitType, "execute-task");
    assert.equal(meta?.unitId, "M001/S01/T02");
  } finally {
    cleanup(base);
  }
});

test("readPausedSessionMetadata handles legacy metadata without unitType/unitId", () => {
  const base = makeTmpBase();
  try {
    // Write metadata without unitType/unitId (simulates older version)
    const runtimeDir = join(base, ".gsd", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "paused-session.json"),
      JSON.stringify({ milestoneId: "M001", originalBasePath: base }),
      "utf-8",
    );
    const meta = readPausedSessionMetadata(base);
    assert.equal(meta?.milestoneId, "M001");
    assert.equal(meta?.unitType, undefined);
    assert.equal(meta?.unitId, undefined);
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession returns none when no lock and no paused session exist", async () => {
  const base = makeTmpBase();
  try {
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "none");
    assert.equal(assessment.lock, null);
    assert.equal(assessment.pausedSession, null);
    assert.equal(assessment.state, null);
    assert.equal(assessment.recovery, null);
    assert.equal(assessment.recoveryPrompt, null);
    assert.equal(assessment.recoveryToolCallCount, 0);
    assert.equal(assessment.artifactSatisfied, false);
    assert.equal(assessment.hasResumableDiskState, false);
    assert.equal(assessment.isBootstrapCrash, false);
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession classifies stale complete repo as stale and suppresses recovery", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, true);
    writeCompleteSliceArtifacts(base);
    writeCompleteMilestoneSummary(base);
    writeTestLock(base, "execute-task", "M001/S01/T01");

    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.hasResumableDiskState, false);
    assert.equal(assessment.recoveryPrompt, null);
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession suppresses prompt when expected artifact already exists and no resumable state remains", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, true);
    writeCompleteSliceArtifacts(base);
    writeCompleteMilestoneSummary(base);
    writeTestLock(base, "complete-slice", "M001/S01");

    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.artifactSatisfied, true);
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession keeps paused-session resume recoverable when disk state is unfinished", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writePausedSession(base);
    writeTestLock(base, "execute-task", "M001/S01/T01");

    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.pausedSession?.milestoneId, "M001");
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession marks stale paused-session metadata as stale when no work remains", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, true);
    writeCompleteSliceArtifacts(base);
    writeCompleteMilestoneSummary(base);
    writePausedSession(base, "M999");

    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.hasResumableDiskState, false);
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession classifies paused session without lock as recoverable when disk state is resumable", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writePausedSession(base, "M001", true);

    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.lock, null);
    assert.equal(assessment.pausedSession?.milestoneId, "M001");
    assert.equal(assessment.hasResumableDiskState, true);
    assert.equal(assessment.isBootstrapCrash, false);
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession falls back to basePath when worktreePath no longer exists", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    // Reference a worktree that doesn't exist on disk
    writePausedSession(base, "M001", false, "/nonexistent/worktree");

    const assessment = await assessInterruptedSession(base);
    // Should use basePath (which has an unfinished roadmap) instead of the missing worktree
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.hasResumableDiskState, true);
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession prefers paused worktree state when worktreePath is recorded", async () => {
  const base = makeTmpBase();
  const worktree = join(base, "worktree-copy");
  try {
    writeRoadmap(base, false);
    writeRoadmap(worktree, true);
    writeCompleteSliceArtifacts(worktree);
    writeCompleteMilestoneSummary(worktree);
    writePausedSession(base, "M001", false, worktree);

    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.hasResumableDiskState, false);
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession keeps unfinished derived state recoverable without trace", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writeTestLock(base, "plan-slice", "M001/S01");

    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.hasResumableDiskState, true);
    assert.equal(assessment.recoveryPrompt, null);
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession preserves crash trace when activity log has tool calls", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writeTestLock(base, "execute-task", "M001/S01/T01");
    writeActivityLog(base, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "1",
              name: "bash",
              arguments: { command: "npm test" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "1",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "ok" }],
        },
      },
    ]);

    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.ok(assessment.recoveryToolCallCount > 0);
    assert.ok(assessment.recoveryPrompt?.includes("Recovery Briefing"));
  } finally {
    cleanup(base);
  }
});

test("assessInterruptedSession treats bootstrap crash as stale without paused metadata", async () => {
  const base = makeTmpBase();
  try {
    writeTestLock(base, "starting", "bootstrap");

    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.isBootstrapCrash, true);
  } finally {
    cleanup(base);
  }
});

// ─── writeLock / readCrashLock ────────────────────────────────────────────

test("writeLock creates lock file and readCrashLock reads it", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  writeLock(base, "execute-task", "M001/S01/T01", "/tmp/session.jsonl");
  const lock = readCrashLock(base);
  assert.ok(lock, "lock should exist");
  assert.equal(lock!.unitType, "execute-task");
  assert.equal(lock!.unitId, "M001/S01/T01");
  assert.equal(lock!.sessionFile, "/tmp/session.jsonl");
  assert.equal(lock!.pid, process.pid);
});

test("readCrashLock returns null when no lock exists", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const lock = readCrashLock(base);
  assert.equal(lock, null);
});

// ─── clearLock ────────────────────────────────────────────────────────────

test("clearLock removes existing lock file", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  writeLock(base, "plan-slice", "M001/S01");
  assert.ok(readCrashLock(base), "lock should exist before clear");
  clearLock(base);
  assert.equal(readCrashLock(base), null, "lock should be gone after clear");
});

test("clearLock is safe when no lock exists", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  assert.doesNotThrow(() => clearLock(base));
});

// ─── isLockProcessAlive ──────────────────────────────────────────────────

test("#2470: isLockProcessAlive returns true for own PID (we hold the lock)", () => {
  // Own PID means we ARE the lock holder — alive, not stale. (#2470)
  // Callers that need recycled-PID detection (e.g. startAuto) already
  // guard with `crashLock.pid !== process.pid` before calling us.
  const lock: LockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive(lock), true, "own PID should return true — we are alive");
});

test("isLockProcessAlive returns false for dead PID", () => {
  const lock: LockData = {
    pid: 999999999,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive(lock), false);
});

test("isLockProcessAlive returns false for invalid PIDs", () => {
  const base: Omit<LockData, "pid"> = {
    startedAt: new Date().toISOString(),
    unitType: "x",
    unitId: "x",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive({ ...base, pid: 0 } as LockData), false);
  assert.equal(isLockProcessAlive({ ...base, pid: -1 } as LockData), false);
  assert.equal(isLockProcessAlive({ ...base, pid: 1.5 } as LockData), false);
});

// ─── formatCrashInfo ─────────────────────────────────────────────────────

test("formatCrashInfo includes unit type, id, and PID", () => {
  const lock: LockData = {
    pid: 12345,
    startedAt: "2025-01-01T00:00:00.000Z",
    unitType: "complete-slice",
    unitId: "M002/S03",
    unitStartedAt: "2025-01-01T00:01:00.000Z",
  };
  const info = formatCrashInfo(lock);
  assert.ok(info.includes("complete-slice"));
  assert.ok(info.includes("M002/S03"));
  assert.ok(info.includes("12345"));
});
