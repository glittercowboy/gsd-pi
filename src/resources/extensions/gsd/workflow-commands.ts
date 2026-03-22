// GSD Extension — Workflow Command Handlers
// All 7 command handlers that form the core mutation API of the WorkflowEngine.
// Each command validates preconditions, writes atomically via transaction(),
// and returns rich results with progress context per D-04.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import type { DbAdapter } from "./gsd-db.js";
import { transaction } from "./gsd-db.js";

// ─── Param & Result Interfaces ──────────────────────────────────────────────

export interface CompleteTaskParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  summary: string;
  evidence?: string[];
}

export interface CompleteTaskResult {
  taskId: string;
  status: string;
  progress: string;
  nextTask: string | null;
  nextTaskTitle: string | null;
}

export interface CompleteSliceParams {
  milestoneId: string;
  sliceId: string;
  summary: string;
  uatResult?: string;
}

export interface CompleteSliceResult {
  sliceId: string;
  status: string;
  progress: string;
  nextSlice: string | null;
}

export interface PlanSliceParams {
  milestoneId: string;
  sliceId: string;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    estimate?: string;
    files?: string[];
    verify?: string;
  }>;
}

export interface PlanSliceResult {
  sliceId: string;
  taskCount: number;
  taskIds: string[];
}

export interface SaveDecisionParams {
  scope: string;
  decision: string;
  choice: string;
  rationale: string;
  revisable?: string;
  whenContext?: string;
  madeBy?: "human" | "agent" | "collaborative";
}

export interface SaveDecisionResult {
  id: string;
}

export interface StartTaskParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export interface StartTaskResult {
  taskId: string;
  status: string;
  startedAt: string;
}

export interface RecordVerificationParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RecordVerificationResult {
  taskId: string;
  evidenceId: number;
}

export interface ReportBlockerParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  description: string;
}

export interface ReportBlockerResult {
  taskId: string;
  status: string;
}

// ─── Command Implementations ────────────────────────────────────────────────

/**
 * completeTask: Atomically mark a task as done with summary and optional evidence.
 * Idempotent — calling on an already-done task returns current state without error.
 * Returns rich progress context per D-04.
 */
export function completeTask(
  db: DbAdapter,
  params: CompleteTaskParams,
): CompleteTaskResult {
  const { milestoneId, sliceId, taskId, summary, evidence } = params;

  return transaction(() => {
    // Fetch task
    const task = db
      .prepare(
        "SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
      )
      .get(milestoneId, sliceId, taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Idempotent: if already done, return current state
    if ((task["status"] as string) === "done") {
      const progress = computeTaskProgress(db, milestoneId, sliceId);
      const next = getNextPendingTask(db, milestoneId, sliceId);
      return {
        taskId,
        status: "done",
        progress,
        nextTask: next?.id ?? null,
        nextTaskTitle: next?.title ?? null,
      };
    }

    // Update task
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE tasks SET status = 'done', summary = ?, completed_at = ? WHERE milestone_id = ? AND slice_id = ? AND id = ?",
    ).run(summary, now, milestoneId, sliceId, taskId);

    // Insert evidence if provided
    if (evidence && evidence.length > 0) {
      const stmt = db.prepare(
        "INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, stdout, stderr, duration_ms, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const ev of evidence) {
        stmt.run(taskId, sliceId, milestoneId, ev, 0, "", "", 0, now);
      }
    }

    // Compute progress
    const progress = computeTaskProgress(db, milestoneId, sliceId);
    const next = getNextPendingTask(db, milestoneId, sliceId);

    return {
      taskId,
      status: "done",
      progress,
      nextTask: next?.id ?? null,
      nextTaskTitle: next?.title ?? null,
    };
  });
}

/**
 * completeSlice: Atomically mark a slice as done with summary and optional UAT result.
 * Returns progress context for the parent milestone.
 */
export function completeSlice(
  db: DbAdapter,
  params: CompleteSliceParams,
): CompleteSliceResult {
  const { milestoneId, sliceId, summary, uatResult } = params;

  return transaction(() => {
    // Fetch slice
    const slice = db
      .prepare(
        "SELECT * FROM slices WHERE milestone_id = ? AND id = ?",
      )
      .get(milestoneId, sliceId);

    if (!slice) {
      throw new Error(`Slice ${sliceId} not found`);
    }

    // Update slice
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE slices SET status = 'done', summary = ?, uat_result = ?, completed_at = ? WHERE milestone_id = ? AND id = ?",
    ).run(summary, uatResult ?? null, now, milestoneId, sliceId);

    // Compute progress
    const progress = computeSliceProgress(db, milestoneId);
    const next = getNextPendingSlice(db, milestoneId);

    return {
      sliceId,
      status: "done",
      progress,
      nextSlice: next?.id ?? null,
    };
  });
}

/**
 * planSlice: Create multiple task rows for a slice in one transaction.
 * Throws if the slice already has tasks.
 */
export function planSlice(
  db: DbAdapter,
  params: PlanSliceParams,
): PlanSliceResult {
  const { milestoneId, sliceId, tasks } = params;

  return transaction(() => {
    // Check for existing tasks
    const existing = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM tasks WHERE milestone_id = ? AND slice_id = ?",
      )
      .get(milestoneId, sliceId);

    if (existing && (existing["cnt"] as number) > 0) {
      throw new Error(`Slice ${sliceId} already has tasks`);
    }

    // Insert tasks
    const stmt = db.prepare(
      "INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, verify, seq) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
    );

    const taskIds: string[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      stmt.run(
        t.id,
        sliceId,
        milestoneId,
        t.title,
        t.description,
        t.estimate ?? "",
        JSON.stringify(t.files ?? []),
        t.verify ?? null,
        i,
      );
      taskIds.push(t.id);
    }

    return {
      sliceId,
      taskCount: tasks.length,
      taskIds,
    };
  });
}

/**
 * saveDecision: Record a decision with auto-generated sequential ID.
 */
export function saveDecision(
  db: DbAdapter,
  params: SaveDecisionParams,
): SaveDecisionResult {
  const { scope, decision, choice, rationale, revisable, whenContext, madeBy } =
    params;

  return transaction(() => {
    // Get next sequence number
    const maxRow = db
      .prepare("SELECT MAX(seq) as max_seq FROM decisions")
      .get();
    const maxSeq = (maxRow?.["max_seq"] as number) ?? 0;
    const nextSeq = maxSeq + 1;
    const id = `D${String(nextSeq).padStart(3, "0")}`;

    db.prepare(
      `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      whenContext ?? "",
      scope,
      decision,
      choice,
      rationale,
      revisable ?? "",
      madeBy ?? "agent",
      null,
    );

    return { id };
  });
}

/**
 * startTask: Mark a task as in-progress with a timestamp.
 * Throws if the task is already done.
 */
export function startTask(
  db: DbAdapter,
  params: StartTaskParams,
): StartTaskResult {
  const { milestoneId, sliceId, taskId } = params;

  return transaction(() => {
    const task = db
      .prepare(
        "SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
      )
      .get(milestoneId, sliceId, taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if ((task["status"] as string) === "done") {
      throw new Error(`Task ${taskId} is already done`);
    }

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE tasks SET status = 'in-progress', started_at = ? WHERE milestone_id = ? AND slice_id = ? AND id = ?",
    ).run(now, milestoneId, sliceId, taskId);

    return {
      taskId,
      status: "in-progress",
      startedAt: now,
    };
  });
}

/**
 * recordVerification: Store verification evidence against a task.
 */
export function recordVerification(
  db: DbAdapter,
  params: RecordVerificationParams,
): RecordVerificationResult {
  const { milestoneId, sliceId, taskId, command, exitCode, stdout, stderr, durationMs } =
    params;

  return transaction(() => {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        "INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, stdout, stderr, duration_ms, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(taskId, sliceId, milestoneId, command, exitCode, stdout, stderr, durationMs, now);

    // Extract lastInsertRowid from result
    let evidenceId = 0;
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      // node:sqlite returns { changes, lastInsertRowid }
      // better-sqlite3 returns { changes, lastInsertRowid }
      if ("lastInsertRowid" in r) {
        evidenceId = Number(r["lastInsertRowid"]);
      }
    }

    // Fallback: query the last inserted ID
    if (evidenceId === 0) {
      const row = db
        .prepare("SELECT MAX(id) as max_id FROM verification_evidence WHERE task_id = ? AND slice_id = ? AND milestone_id = ?")
        .get(taskId, sliceId, milestoneId);
      evidenceId = (row?.["max_id"] as number) ?? 0;
    }

    return {
      taskId,
      evidenceId,
    };
  });
}

/**
 * reportBlocker: Mark a task as blocked with a description.
 */
export function reportBlocker(
  db: DbAdapter,
  params: ReportBlockerParams,
): ReportBlockerResult {
  const { milestoneId, sliceId, taskId, description } = params;

  return transaction(() => {
    const task = db
      .prepare(
        "SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
      )
      .get(milestoneId, sliceId, taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    db.prepare(
      "UPDATE tasks SET status = 'blocked', blocker = ? WHERE milestone_id = ? AND slice_id = ? AND id = ?",
    ).run(description, milestoneId, sliceId, taskId);

    return {
      taskId,
      status: "blocked",
    };
  });
}

// ─── Exported Helpers ────────────────────────────────────────────────────────

/**
 * Compute milestone slice completion progress.
 * Returns total slices, done slices, and percentage for the given milestone.
 * Used by WorkflowEngine to trigger event compaction at 100% (EVT-03).
 */
export function _milestoneProgress(
  db: DbAdapter,
  milestoneId: string,
): { total: number; done: number; pct: number } {
  const totalRow = db
    .prepare("SELECT COUNT(*) as cnt FROM slices WHERE milestone_id = ?")
    .get(milestoneId);
  const doneRow = db
    .prepare("SELECT COUNT(*) as cnt FROM slices WHERE milestone_id = ? AND status = 'done'")
    .get(milestoneId);

  const total = (totalRow?.["cnt"] as number) ?? 0;
  const done = (doneRow?.["cnt"] as number) ?? 0;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return { total, done, pct };
}

// ─── Private Helpers ────────────────────────────────────────────────────────

function computeTaskProgress(
  db: DbAdapter,
  milestoneId: string,
  sliceId: string,
): string {
  const total = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM tasks WHERE milestone_id = ? AND slice_id = ?",
    )
    .get(milestoneId, sliceId);
  const done = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM tasks WHERE milestone_id = ? AND slice_id = ? AND status = 'done'",
    )
    .get(milestoneId, sliceId);

  const totalCount = (total?.["cnt"] as number) ?? 0;
  const doneCount = (done?.["cnt"] as number) ?? 0;

  return `${doneCount}/${totalCount} tasks done in ${sliceId}`;
}

function computeSliceProgress(
  db: DbAdapter,
  milestoneId: string,
): string {
  const total = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM slices WHERE milestone_id = ?",
    )
    .get(milestoneId);
  const done = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM slices WHERE milestone_id = ? AND status = 'done'",
    )
    .get(milestoneId);

  const totalCount = (total?.["cnt"] as number) ?? 0;
  const doneCount = (done?.["cnt"] as number) ?? 0;

  return `${doneCount}/${totalCount} slices done in ${milestoneId}`;
}

function getNextPendingTask(
  db: DbAdapter,
  milestoneId: string,
  sliceId: string,
): { id: string; title: string } | null {
  const row = db
    .prepare(
      "SELECT id, title FROM tasks WHERE milestone_id = ? AND slice_id = ? AND status = 'pending' ORDER BY seq, id LIMIT 1",
    )
    .get(milestoneId, sliceId);

  if (!row) return null;
  return { id: row["id"] as string, title: row["title"] as string };
}

function getNextPendingSlice(
  db: DbAdapter,
  milestoneId: string,
): { id: string } | null {
  const row = db
    .prepare(
      "SELECT id FROM slices WHERE milestone_id = ? AND status != 'done' ORDER BY seq, id LIMIT 1",
    )
    .get(milestoneId);

  if (!row) return null;
  return { id: row["id"] as string };
}
