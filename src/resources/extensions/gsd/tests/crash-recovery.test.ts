import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  PAUSED_SESSION_KV_KEY,
} from "../interrupted-session.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  _getAdapter,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { recordDispatchClaim } from "../db/unit-dispatches.ts";
import { insertSlice, insertTask } from "../gsd-db.ts";
import { setRuntimeKv } from "../db/runtime-kv.ts";
import { normalizeRealPath } from "../paths.ts";
import type { GSDState } from "../types.ts";
import { _synthesizePausedSessionRecoveryForTest } from "../auto.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  // Phase C pt 2: lock and paused-session live in the DB now. Open it
  // for every test base so the helpers below can write through.
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

/**
 * Phase C pt 2 fixture: insert a stale worker row + dispatch + session_file
 * directly via SQL so it appears as a crashed PEER process, not as the
 * current test process. assessInterruptedSession filters out
 * `rawLock.pid === process.pid` to avoid classifying its own process as
 * a previous crash; using PID 999999999 (functionally guaranteed dead)
 * bypasses that guard exactly the way the old file-based writeTestLock
 * did with the same PID.
 */
function writeTestLock(
  base: string,
  unitType: string,
  unitId: string,
  sessionFile?: string,
): void {
  const projectRoot = normalizeRealPath(base);
  const workerId = `test-fake-${randomUUID().slice(0, 8)}`;
  const fakePid = 999999999;
  const stalePast = "1970-01-01T00:00:00.000Z";
  const db = _getAdapter()!;
  db.prepare(
    `INSERT INTO workers (
      worker_id, host, pid, started_at, version,
      last_heartbeat_at, status, project_root_realpath
    ) VALUES (
      :w, 'test-host', :pid, :started_at, 'test',
      :stale, 'active', :project_root
    )`,
  ).run({
    ":w": workerId,
    ":pid": fakePid,
    ":started_at": new Date().toISOString(),
    ":stale": stalePast,
    ":project_root": projectRoot,
  });

  // Ensure milestones referenced by the unitId exist so the dispatch
  // FK is satisfied. Parse "M###/S##" or "M###" or "starting" / etc.
  const midMatch = unitId.match(/^(M\d+)/);
  if (midMatch && unitType !== "starting") {
    const mid = midMatch[1];
    try { insertMilestone({ id: mid, title: `Test ${mid}`, status: "active" }); }
    catch { /* may already exist */ }
    try {
      const lease = claimMilestoneLease(workerId, mid);
      recordDispatchClaim({
        traceId: randomUUID(),
        workerId,
        milestoneLeaseToken: lease.ok ? lease.token : 0,
        milestoneId: mid,
        unitType,
        unitId,
      });
    } catch { /* ignore — best-effort */ }
  }

  if (sessionFile) {
    setRuntimeKv("worker", workerId, "session_file", sessionFile);
  }
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
  // Phase C pt 2: makeTmpBase() opens the DB so writeTestLock can write
  // the workers row. deriveState then goes DB-first; mirror the markdown
  // fixture into the DB so the assessment sees the same milestone state.
  // Use direct upsert SQL so calling writeRoadmap twice (e.g. once for
  // base + once for a paused worktree) actually flips the status.
  const status = checked ? "complete" : "active";
  const adapter = _getAdapter();
  if (adapter) {
    adapter.prepare(
      `INSERT INTO milestones (id, title, status, created_at)
       VALUES (:id, :title, :status, :now)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, title = excluded.title`,
    ).run({ ":id": "M001", ":title": "Test Milestone", ":status": status, ":now": new Date().toISOString() });
    adapter.prepare(
      `INSERT INTO slices (milestone_id, id, title, status, created_at)
       VALUES (:mid, :sid, :title, :status, :now)
       ON CONFLICT(milestone_id, id) DO UPDATE SET status = excluded.status, title = excluded.title`,
    ).run({ ":mid": "M001", ":sid": "S01", ":title": "Test slice", ":status": status, ":now": new Date().toISOString() });
  }
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
  // Phase C pt 2: paused-session.json migrated to runtime_kv
  // (global scope, key PAUSED_SESSION_KV_KEY).
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
    milestoneId,
    originalBasePath: base,
    stepMode,
    worktreePath,
    unitType,
    unitId,
  });
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

test("paused session recovery consumes JSONL without deleting the evidence file", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const sessionFile = join(base, "paused-session.jsonl");
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "session", id: "session-1" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "bash",
              id: "tool-1",
              arguments: { command: "echo paused" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "bash",
          isError: false,
          content: "paused\n",
        },
      }),
    ].join("\n"),
    "utf-8",
  );

  const recovery = _synthesizePausedSessionRecoveryForTest(
    base,
    "execute-task",
    "M001/S01/T01",
    sessionFile,
  );

  assert.equal(recovery?.trace.toolCallCount, 1);
  assert.equal(existsSync(sessionFile), true, "paused JSONL must remain available after synthesis");
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
    // Phase C pt 2: write directly to runtime_kv (simulates older payload
    // missing the now-canonical unitType/unitId fields).
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
      milestoneId: "M001",
      originalBasePath: base,
    });
    const meta = readPausedSessionMetadata(base);
    assert.equal(meta?.milestoneId, "M001");
    assert.equal(meta?.unitType, undefined);
    assert.equal(meta?.unitId, undefined);
  } finally {
    cleanup(base);
  }
});

test("readPausedSessionMetadata drops stale discuss-milestone pseudo PROJECT metadata", () => {
  const base = makeTmpBase();
  try {
    // Phase C pt 2: write directly to runtime_kv (the file location is gone)
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
      milestoneId: null,
      originalBasePath: base,
      unitType: "discuss-milestone",
      unitId: "PROJECT",
    });

    const meta = readPausedSessionMetadata(base);
    assert.equal(meta, null);
    // Confirm the row was deleted by readPausedSessionMetadata's
    // isStalePseudoMilestonePause branch.
    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT 1 FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :k`,
    ).get({ ":k": PAUSED_SESSION_KV_KEY });
    assert.equal(row, undefined);
  } finally {
    cleanup(base);
  }
});

test("readPausedSessionMetadata drops stale deep setup pseudo-unit metadata", () => {
  const base = makeTmpBase();
  try {
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
      milestoneId: "WORKFLOW-PREFS",
      originalBasePath: base,
      unitType: "workflow-preferences",
      unitId: "WORKFLOW-PREFS",
    });

    const meta = readPausedSessionMetadata(base);
    assert.equal(meta, null);
    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT 1 FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :k`,
    ).get({ ":k": PAUSED_SESSION_KV_KEY });
    assert.equal(row, undefined);
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
  // Phase C pt 2: lock state is reconstructed from workers + unit_dispatches
  // + runtime_kv. The fresh worker is not stale yet — we register, dispatch,
  // write the session_file, then expire the heartbeat to simulate a crash.
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  insertMilestone({ id: "M001", title: "Test", status: "active" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  recordDispatchClaim({
    traceId: "t1", workerId, milestoneLeaseToken: lease.token,
    milestoneId: "M001", unitType: "execute-task", unitId: "M001/S01/T01",
  });
  writeLock(base, "execute-task", "M001/S01/T01", "/tmp/session.jsonl");

  // Force stale so readCrashLock surfaces it.
  _getAdapter()!.prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :w`,
  ).run({ ":w": workerId });

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
  // Phase C pt 2: clearLock now drops the session_file runtime_kv row
  // for the LIVE worker (not the stale one). The "lock state" itself
  // (pid, unitType, etc.) lives in workers + unit_dispatches; those are
  // managed by markWorkerStopping (called from stopAuto, not here).
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });

  writeLock(base, "plan-slice", "M001/S01", "/tmp/session.jsonl");
  // Confirm the session_file row landed for the live worker.
  const adapter = _getAdapter()!;
  const before = adapter.prepare(
    `SELECT 1 FROM runtime_kv WHERE scope = 'worker' AND scope_id = :w AND key = 'session_file'`,
  ).get({ ":w": workerId });
  assert.ok(before, "session_file row exists before clear");

  clearLock(base);

  const after = adapter.prepare(
    `SELECT 1 FROM runtime_kv WHERE scope = 'worker' AND scope_id = :w AND key = 'session_file'`,
  ).get({ ":w": workerId });
  assert.equal(after, undefined, "session_file row gone after clearLock");
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
