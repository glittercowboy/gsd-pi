// gsd-2 + Unit dispatch ledger (DB-backed coordination, Phase B)
//
// Records every auto-mode unit dispatch (plan-slice, run-task, summarize, …)
// with worker_id, fencing token, status lifecycle, and retry metadata. The
// ledger is the substrate Phase C will consume to migrate stuck-state.json
// and paused-session.json out of the runtime/ directory.
//
// Codex review MEDIUM B2: partial unique index
//   idx_unit_dispatches_active_per_unit ON unit_dispatches(unit_id)
//   WHERE status IN ('claimed','running')
// enforces that two workers cannot simultaneously claim the same unit.
// recordDispatchClaim relies on the index to fail fast at INSERT time
// rather than racing in application code.

import { randomUUID } from "node:crypto";

import {
  _getAdapter,
  isDbAvailable,
  transaction,
  insertAuditEvent,
} from "../gsd-db.js";

export type DispatchStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "stuck"
  | "canceled"
  | "paused";

export interface UnitDispatchRow {
  id: number;
  trace_id: string;
  turn_id: string | null;
  worker_id: string;
  milestone_lease_token: number;
  milestone_id: string;
  slice_id: string | null;
  task_id: string | null;
  unit_type: string;
  unit_id: string;
  status: DispatchStatus;
  attempt_n: number;
  started_at: string;
  ended_at: string | null;
  exit_reason: string | null;
  error_summary: string | null;
  verification_evidence_id: number | null;
  next_run_at: string | null;
  retry_after_ms: number | null;
  max_attempts: number;
  last_error_code: string | null;
  last_error_at: string | null;
}

export interface RecordClaimInput {
  traceId: string;
  turnId?: string | null;
  workerId: string;
  milestoneLeaseToken: number;
  milestoneId: string;
  sliceId?: string | null;
  taskId?: string | null;
  unitType: string;
  unitId: string;
  /**
   * Attempt number for this unit. Callers should compute this from the
   * most recent prior dispatch for the same unit_id (use
   * getRecentForUnit() then add 1). Defaults to 1 for fresh claims.
   */
  attemptN?: number;
  /** Per-attempt cap; defaults to 3. */
  maxAttempts?: number;
}

export type RecordClaimResult =
  | { ok: true; dispatchId: number }
  | { ok: false; error: "already_active"; existingId: number; existingStatus: DispatchStatus; existingWorker: string };

/**
 * Insert a new dispatch row in `claimed` state. Atomic guard against
 * double-claim (B2): the partial unique index
 * idx_unit_dispatches_active_per_unit refuses the INSERT if any row for
 * the same unit_id already has status IN ('claimed','running').
 */
export function recordDispatchClaim(input: RecordClaimInput): RecordClaimResult {
  if (!isDbAvailable()) {
    throw new Error("recordDispatchClaim: DB unavailable");
  }
  const now = new Date().toISOString();

  return transaction((): RecordClaimResult => {
    const db = _getAdapter()!;

    try {
      const result = db.prepare(
        `INSERT INTO unit_dispatches (
          trace_id, turn_id, worker_id, milestone_lease_token,
          milestone_id, slice_id, task_id,
          unit_type, unit_id, status, attempt_n,
          started_at, max_attempts
        ) VALUES (
          :trace_id, :turn_id, :worker_id, :milestone_lease_token,
          :milestone_id, :slice_id, :task_id,
          :unit_type, :unit_id, 'claimed', :attempt_n,
          :started_at, :max_attempts
        )`,
      ).run({
        ":trace_id": input.traceId,
        ":turn_id": input.turnId ?? null,
        ":worker_id": input.workerId,
        ":milestone_lease_token": input.milestoneLeaseToken,
        ":milestone_id": input.milestoneId,
        ":slice_id": input.sliceId ?? null,
        ":task_id": input.taskId ?? null,
        ":unit_type": input.unitType,
        ":unit_id": input.unitId,
        ":attempt_n": input.attemptN ?? 1,
        ":started_at": now,
        ":max_attempts": input.maxAttempts ?? 3,
      });
      const id = Number((result as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0);

      insertAuditEvent({
        eventId: randomUUID(),
        traceId: input.traceId,
        turnId: input.turnId ?? undefined,
        category: "orchestration",
        type: "dispatch-claimed",
        ts: now,
        payload: {
          dispatchId: id,
          unitId: input.unitId,
          unitType: input.unitType,
          workerId: input.workerId,
          attemptN: input.attemptN ?? 1,
        },
      });

      return { ok: true, dispatchId: id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isUniqueConflict = /UNIQUE/i.test(msg);
      const isForeignKeyFailure = /FOREIGN KEY/i.test(msg);
      if (!isUniqueConflict || isForeignKeyFailure) throw err;

      // Partial unique index rejected the INSERT — surface the existing
      // active dispatch so callers can decide what to do.
      const existing = db.prepare(
        `SELECT id, status, worker_id FROM unit_dispatches
         WHERE unit_id = :unit_id AND status IN ('claimed','running')
         ORDER BY id DESC LIMIT 1`,
      ).get({ ":unit_id": input.unitId }) as { id: number; status: DispatchStatus; worker_id: string } | undefined;

      return {
        ok: false,
        error: "already_active",
        existingId: existing?.id ?? 0,
        existingStatus: existing?.status ?? "claimed",
        existingWorker: existing?.worker_id ?? "unknown",
      };
    }
  });
}

/** Transition a `claimed` dispatch into `running`. */
export function markRunning(dispatchId: number): void {
  if (!isDbAvailable()) return;
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE unit_dispatches SET status = 'running'
     WHERE id = :id AND status = 'claimed'`,
  ).run({ ":id": dispatchId });
}

export interface CompleteOpts {
  verificationEvidenceId?: number | null;
  exitReason?: string;
}

/** Transition a dispatch into `completed`. */
export function markCompleted(dispatchId: number, opts?: CompleteOpts): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  transaction(() => {
    db.prepare(
      `UPDATE unit_dispatches
       SET status = 'completed', ended_at = :ended_at,
           exit_reason = :exit_reason,
           verification_evidence_id = :evidence_id
       WHERE id = :id`,
    ).run({
      ":id": dispatchId,
      ":ended_at": now,
      ":exit_reason": opts?.exitReason ?? null,
      ":evidence_id": opts?.verificationEvidenceId ?? null,
    });
  });
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: dispatchId.toString(),
    category: "orchestration",
    type: "dispatch-completed",
    ts: now,
    payload: { dispatchId },
  });
}

export interface FailureOpts {
  errorSummary: string;
  errorCode?: string;
  /** Backoff before next attempt (used by stuck-detector retry suppression). */
  retryAfterMs?: number;
}

/** Transition a dispatch into `failed`, optionally scheduling a retry. */
export function markFailed(dispatchId: number, opts: FailureOpts): void {
  if (!isDbAvailable()) return;
  const now = new Date();
  const nowIso = now.toISOString();
  const nextRunIso = opts.retryAfterMs
    ? new Date(now.getTime() + opts.retryAfterMs).toISOString()
    : null;
  const db = _getAdapter()!;
  transaction(() => {
    db.prepare(
      `UPDATE unit_dispatches
       SET status = 'failed', ended_at = :ended_at,
           error_summary = :error_summary,
           last_error_code = :last_error_code,
           last_error_at = :last_error_at,
           retry_after_ms = :retry_after_ms,
           next_run_at = :next_run_at
       WHERE id = :id`,
    ).run({
      ":id": dispatchId,
      ":ended_at": nowIso,
      ":error_summary": opts.errorSummary,
      ":last_error_code": opts.errorCode ?? null,
      ":last_error_at": nowIso,
      ":retry_after_ms": opts.retryAfterMs ?? null,
      ":next_run_at": nextRunIso,
    });
  });
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: dispatchId.toString(),
    category: "orchestration",
    type: "dispatch-failed",
    ts: nowIso,
    payload: { dispatchId, errorSummary: opts.errorSummary, retryAfterMs: opts.retryAfterMs ?? null },
  });
}

/** Transition a dispatch into `stuck`. */
export function markStuck(dispatchId: number, reason: string): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  transaction(() => {
    db.prepare(
      `UPDATE unit_dispatches
       SET status = 'stuck', ended_at = :ended_at, exit_reason = :reason
       WHERE id = :id`,
    ).run({ ":id": dispatchId, ":ended_at": now, ":reason": reason });
  });
}

/** Transition a dispatch into `paused`. */
export function markPaused(dispatchId: number): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE unit_dispatches
     SET status = 'paused', ended_at = :ended_at
     WHERE id = :id AND status IN ('claimed','running')`,
  ).run({ ":id": dispatchId, ":ended_at": now });
}

/** Transition a dispatch into `canceled`. */
export function markCanceled(dispatchId: number, reason: string): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE unit_dispatches
     SET status = 'canceled', ended_at = :ended_at, exit_reason = :reason
     WHERE id = :id AND status IN ('pending','claimed','running')`,
  ).run({ ":id": dispatchId, ":ended_at": now, ":reason": reason });
}

/**
 * Fetch the most recent N dispatches for a unit. Used by recordDispatchClaim
 * callers to compute attempt_n and by detect-stuck.ts (B3) to consult
 * retry budget before tripping the stuck verdict.
 */
export function getRecentForUnit(unitId: string, limit = 10): UnitDispatchRow[] {
  if (!isDbAvailable()) return [];
  const db = _getAdapter()!;
  return db.prepare(
    `SELECT * FROM unit_dispatches WHERE unit_id = :unit_id ORDER BY id DESC LIMIT :limit`,
  ).all({ ":unit_id": unitId, ":limit": limit }) as unknown as UnitDispatchRow[];
}

/**
 * Fetch the latest dispatch for a unit, regardless of status. Returns null
 * if the unit has never been dispatched.
 */
export function getLatestForUnit(unitId: string): UnitDispatchRow | null {
  if (!isDbAvailable()) return null;
  const db = _getAdapter()!;
  const row = db.prepare(
    `SELECT * FROM unit_dispatches WHERE unit_id = :unit_id ORDER BY id DESC LIMIT 1`,
  ).get({ ":unit_id": unitId }) as UnitDispatchRow | undefined;
  return row ?? null;
}

/**
 * Fetch dispatches for a milestone filtered by status. Useful for janitors
 * + dashboards.
 */
export function getDispatchesByStatus(
  milestoneId: string,
  status: DispatchStatus,
): UnitDispatchRow[] {
  if (!isDbAvailable()) return [];
  const db = _getAdapter()!;
  return db.prepare(
    `SELECT * FROM unit_dispatches WHERE milestone_id = :mid AND status = :status ORDER BY id`,
  ).all({ ":mid": milestoneId, ":status": status }) as unknown as UnitDispatchRow[];
}
