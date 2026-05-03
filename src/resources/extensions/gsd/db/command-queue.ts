// gsd-2 + Worker IPC command queue (DB-backed coordination, Phase B)
//
// New infrastructure for dispatcher-to-worker IPC (cancel signals, pause
// requests, etc.). NOT a replacement for any existing on-disk queue and
// NOT related to startAutoCommandPolling() in auto.ts (which polls a
// remote channel like Telegram, not a local file queue).
//
// Broadcast semantics (codex review LOW B4):
// SQLite indexes NULLs in B-trees, so the single index
// idx_command_queue_pending(target_worker, claimed_at) serves both:
//   - targeted queries: WHERE target_worker = ?
//   - broadcast queries: WHERE target_worker IS NULL
// Workers should poll for both forms (their own ID + broadcasts) on each
// claim cycle.

import {
  _getAdapter,
  isDbAvailable,
  transaction,
} from "../gsd-db.js";

export interface CommandQueueRow {
  id: number;
  target_worker: string | null;
  command: string;
  args_json: string;
  enqueued_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  completed_at: string | null;
  result_json: string | null;
}

export interface EnqueueInput {
  /** null = broadcast to all workers; string = target a specific worker_id */
  targetWorker: string | null;
  command: string;
  args?: Record<string, unknown>;
}

/**
 * Enqueue a command. Returns the new row id. Broadcast commands
 * (targetWorker=null) will be claimed by exactly one worker — the IPC
 * model is "single delivery to whoever claims first", not pub-sub.
 */
export function enqueueCommand(input: EnqueueInput): number {
  if (!isDbAvailable()) {
    throw new Error("enqueueCommand: DB unavailable");
  }
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  const result = transaction(() => {
    return db.prepare(
      `INSERT INTO command_queue (target_worker, command, args_json, enqueued_at)
       VALUES (:target_worker, :command, :args_json, :enqueued_at)`,
    ).run({
      ":target_worker": input.targetWorker,
      ":command": input.command,
      ":args_json": JSON.stringify(input.args ?? {}),
      ":enqueued_at": now,
    });
  });
  return Number((result as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0);
}

/**
 * Atomically claim the next pending command for the given worker. Returns
 * the claimed row, or null if nothing to claim.
 *
 * Polls both targeted (target_worker = workerId) and broadcast
 * (target_worker IS NULL) queues, oldest-first.
 */
export function claimNextCommand(workerId: string): CommandQueueRow | null {
  if (!isDbAvailable()) return null;
  const now = new Date().toISOString();
  const db = _getAdapter()!;

  return transaction((): CommandQueueRow | null => {
    // Find the oldest unclaimed command targeted at this worker OR
    // broadcast. The partial index covers both via NULL-in-B-tree.
    const row = db.prepare(
      `SELECT id, target_worker, command, args_json, enqueued_at,
              claimed_at, claimed_by, completed_at, result_json
       FROM command_queue
       WHERE claimed_at IS NULL
         AND (target_worker = :worker_id OR target_worker IS NULL)
       ORDER BY enqueued_at ASC, id ASC
       LIMIT 1`,
    ).get({ ":worker_id": workerId }) as CommandQueueRow | undefined;

    if (!row) return null;

    // Conditional UPDATE — only succeeds if still unclaimed (guards against
    // races between two workers polling simultaneously).
    const result = db.prepare(
      `UPDATE command_queue
       SET claimed_at = :now, claimed_by = :worker_id
       WHERE id = :id AND claimed_at IS NULL`,
    ).run({ ":now": now, ":worker_id": workerId, ":id": row.id });

    const changes =
      typeof (result as { changes?: unknown }).changes === "number"
        ? (result as { changes: number }).changes
        : 0;

    if (changes !== 1) return null; // lost the race

    return { ...row, claimed_at: now, claimed_by: workerId };
  });
}

/**
 * Mark a command complete with optional result payload. Idempotent — if
 * the command is already completed, the second call is a no-op.
 */
export function completeCommand(
  id: number,
  result?: Record<string, unknown>,
): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE command_queue
     SET completed_at = :now, result_json = :result_json
     WHERE id = :id
       AND claimed_at IS NOT NULL
       AND completed_at IS NULL`,
  ).run({
    ":id": id,
    ":now": now,
    ":result_json": result ? JSON.stringify(result) : null,
  });
}

/** Diagnostic helper: read a single row by id. */
export function getCommand(id: number): CommandQueueRow | null {
  if (!isDbAvailable()) return null;
  const db = _getAdapter()!;
  const row = db.prepare(
    `SELECT id, target_worker, command, args_json, enqueued_at,
            claimed_at, claimed_by, completed_at, result_json
     FROM command_queue WHERE id = :id`,
  ).get({ ":id": id }) as CommandQueueRow | undefined;
  return row ?? null;
}
