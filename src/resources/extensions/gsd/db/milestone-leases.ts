// gsd-2 + Milestone leases with fencing tokens (DB-backed coordination, Phase B)
//
// One worker at a time may hold a lease on a given milestone. Leases carry a
// monotonic fencing token that increments on every successful takeover, so
// stale workers can be cheaply detected and rejected at write time
// (unit_dispatches.milestone_lease_token).
//
// Codex review BLOCKING B1: claim semantics must atomically handle two
// distinct cases inside one transaction:
//   1. First claim (no row exists)         → INSERT with fencing_token=1
//   2. Takeover (row exists, expired/released) → UPDATE w/ fencing_token+1
// `INSERT OR ABORT` alone is wrong because the row already exists for any
// takeover and a plain INSERT cannot succeed.

import { randomUUID } from "node:crypto";

import {
  _getAdapter,
  isDbAvailable,
  transaction,
  insertAuditEvent,
} from "../gsd-db.js";

const LEASE_TTL_SECONDS = 60;

export type LeaseStatus = "held" | "released" | "expired";

export interface MilestoneLeaseRow {
  milestone_id: string;
  worker_id: string;
  fencing_token: number;
  acquired_at: string;
  expires_at: string;
  status: LeaseStatus;
}

export type ClaimResult =
  | { ok: true; token: number; expiresAt: string }
  | { ok: false; error: "held_by"; byWorker: string; expiresAt: string };

function ttlExpiry(now: Date): string {
  return new Date(now.getTime() + LEASE_TTL_SECONDS * 1000).toISOString();
}

/**
 * Acquire (or take over an expired) milestone lease for the given worker.
 *
 * Atomicity: the entire claim runs inside a single transaction so the
 * INSERT-vs-UPDATE branch decision can never tear under concurrent claims.
 * Fencing token is computed by SQL (`fencing_token + 1`), never supplied
 * by the client. Initial value is 1.
 *
 * datetime('now') uses the local monotonic clock — single-host SQLite WAL
 * only. Cross-host coordination would need a real coordinator; out of scope
 * for Phase B.
 */
export function claimMilestoneLease(
  workerId: string,
  milestoneId: string,
): ClaimResult {
  if (!isDbAvailable()) {
    throw new Error("claimMilestoneLease: DB unavailable");
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = ttlExpiry(now);

  return transaction((): ClaimResult => {
    const db = _getAdapter()!;

    // Step 1: try a fresh INSERT. If it fails because the row already
    // exists, fall through to the takeover branch below.
    let inserted = false;
    try {
      db.prepare(
        `INSERT INTO milestone_leases (
          milestone_id, worker_id, fencing_token,
          acquired_at, expires_at, status
        ) VALUES (
          :milestone_id, :worker_id, 1,
          :acquired_at, :expires_at, 'held'
        )`,
      ).run({
        ":milestone_id": milestoneId,
        ":worker_id": workerId,
        ":acquired_at": nowIso,
        ":expires_at": expiresIso,
      });
      inserted = true;
    } catch (err) {
      // SQLite raises a constraint error on duplicate PK — catch and fall
      // through to UPDATE. Any other error is a bug; rethrow.
      const msg = err instanceof Error ? err.message : String(err);
      const isUniqueConflict = /UNIQUE|PRIMARY KEY/i.test(msg);
      const isForeignKeyFailure = /FOREIGN KEY/i.test(msg);
      if (!isUniqueConflict || isForeignKeyFailure) throw err;
    }

    if (inserted) {
      insertAuditEvent({
        eventId: randomUUID(),
        traceId: workerId,
        category: "orchestration",
        type: "lease-acquired",
        ts: nowIso,
        payload: { workerId, milestoneId, token: 1, mode: "fresh" },
      });
      return { ok: true, token: 1, expiresAt: expiresIso };
    }

    // Step 2: takeover. Conditional UPDATE — only succeeds if the existing
    // lease is expired or explicitly released. Fencing token is incremented
    // by SQL (`fencing_token + 1`) so the new holder's token monotonically
    // exceeds the prior holder's. db.changes() === 1 confirms the takeover
    // actually happened (vs. losing the race to another worker).
    const updateResult = db.prepare(
      `UPDATE milestone_leases
       SET worker_id = :worker_id,
           fencing_token = fencing_token + 1,
           acquired_at = :acquired_at,
           expires_at = :expires_at,
           status = 'held'
       WHERE milestone_id = :milestone_id
         AND (status IN ('expired','released')
              OR datetime(expires_at) < datetime('now'))`,
    ).run({
      ":milestone_id": milestoneId,
      ":worker_id": workerId,
      ":acquired_at": nowIso,
      ":expires_at": expiresIso,
    });

    const changes =
      typeof (updateResult as { changes?: unknown }).changes === "number"
        ? (updateResult as { changes: number }).changes
        : 0;

    if (changes === 1) {
      // Read back to obtain the new token value.
      const row = db.prepare(
        `SELECT worker_id, fencing_token, expires_at FROM milestone_leases WHERE milestone_id = :milestone_id`,
      ).get({ ":milestone_id": milestoneId }) as Pick<MilestoneLeaseRow, "worker_id" | "fencing_token" | "expires_at"> | undefined;
      const token = row?.fencing_token ?? 1;
      insertAuditEvent({
        eventId: randomUUID(),
        traceId: workerId,
        category: "orchestration",
        type: "lease-acquired",
        ts: nowIso,
        payload: { workerId, milestoneId, token, mode: "takeover" },
      });
      return { ok: true, token, expiresAt: expiresIso };
    }

    // Lease still held by someone else — read current holder for the error.
    const holder = db.prepare(
      `SELECT worker_id, expires_at FROM milestone_leases WHERE milestone_id = :milestone_id`,
    ).get({ ":milestone_id": milestoneId }) as { worker_id: string; expires_at: string } | undefined;

    return {
      ok: false,
      error: "held_by",
      byWorker: holder?.worker_id ?? "unknown",
      expiresAt: holder?.expires_at ?? "",
    };
  });
}

/**
 * Refresh the lease's expires_at when the worker heartbeats. Idempotent —
 * silently no-ops if the lease was already taken over or released.
 */
export function refreshMilestoneLease(
  workerId: string,
  milestoneId: string,
  fencingToken: number,
): boolean {
  if (!isDbAvailable()) return false;
  const now = new Date();
  const expiresIso = ttlExpiry(now);
  const db = _getAdapter()!;
  const result = db.prepare(
    `UPDATE milestone_leases
     SET expires_at = :expires_at
     WHERE milestone_id = :milestone_id
       AND worker_id = :worker_id
       AND fencing_token = :token
       AND status = 'held'`,
  ).run({
    ":expires_at": expiresIso,
    ":milestone_id": milestoneId,
    ":worker_id": workerId,
    ":token": fencingToken,
  });
  const changes =
    typeof (result as { changes?: unknown }).changes === "number"
      ? (result as { changes: number }).changes
      : 0;
  return changes === 1;
}

/**
 * Voluntarily release the lease (e.g. clean shutdown). Future claims may
 * proceed without waiting for TTL expiry.
 */
export function releaseMilestoneLease(
  workerId: string,
  milestoneId: string,
  fencingToken: number,
): boolean {
  if (!isDbAvailable()) return false;
  const db = _getAdapter()!;
  const result = transaction(() => {
    return db.prepare(
      `UPDATE milestone_leases
       SET status = 'released'
       WHERE milestone_id = :milestone_id
         AND worker_id = :worker_id
         AND fencing_token = :token
         AND status = 'held'`,
    ).run({
      ":milestone_id": milestoneId,
      ":worker_id": workerId,
      ":token": fencingToken,
    });
  });
  const changes =
    typeof (result as { changes?: unknown }).changes === "number"
      ? (result as { changes: number }).changes
      : 0;
  if (changes === 1) {
    insertAuditEvent({
      eventId: randomUUID(),
      traceId: workerId,
      category: "orchestration",
      type: "lease-released",
      ts: new Date().toISOString(),
      payload: { workerId, milestoneId, token: fencingToken },
    });
  }
  return changes === 1;
}

/**
 * Read current lease row for diagnostics. Returns null if no row exists.
 */
export function getMilestoneLease(milestoneId: string): MilestoneLeaseRow | null {
  if (!isDbAvailable()) return null;
  const db = _getAdapter()!;
  const row = db.prepare(
    `SELECT milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
     FROM milestone_leases WHERE milestone_id = :milestone_id`,
  ).get({ ":milestone_id": milestoneId }) as MilestoneLeaseRow | undefined;
  return row ?? null;
}

/** TTL exported so callers (e.g. tests / janitors) can compute expirations. */
export function milestoneLeaseTtlSeconds(): number {
  return LEASE_TTL_SECONDS;
}
