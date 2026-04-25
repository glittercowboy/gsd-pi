import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { isStaleWrite } from "../auto/turn-epoch.js";
import { withFileLockSync } from "../file-lock.js";
import { gsdRoot } from "../paths.js";
import { isDbAvailable, insertAuditEvent } from "../gsd-db.js";
import type { AuditEventEnvelope } from "./contracts.js";

function auditLogPath(basePath: string): string {
  return join(gsdRoot(basePath), "audit", "events.jsonl");
}

function ensureAuditDir(basePath: string): void {
  mkdirSync(join(gsdRoot(basePath), "audit"), { recursive: true });
}

export function buildAuditEnvelope(args: {
  traceId: string;
  turnId?: string;
  causedBy?: string;
  category: AuditEventEnvelope["category"];
  type: string;
  payload?: Record<string, unknown>;
}): AuditEventEnvelope {
  return {
    eventId: randomUUID(),
    traceId: args.traceId,
    turnId: args.turnId,
    causedBy: args.causedBy,
    category: args.category,
    type: args.type,
    ts: new Date().toISOString(),
    payload: args.payload ?? {},
  };
}

export function emitUokAuditEvent(basePath: string, event: AuditEventEnvelope): void {
  // Drop writes from a turn superseded by timeout recovery / cancellation.
  if (isStaleWrite("uok-audit")) return;
  try {
    ensureAuditDir(basePath);
    const path = auditLogPath(basePath);
    // proper-lockfile requires the target file to exist before locking.
    // Touch it via open(O_APPEND|O_CREAT) so the first writer wins the race
    // atomically at the kernel level.
    if (!existsSync(path)) closeSync(openSync(path, "a"));
    // onLocked: "skip" — audit writes are best-effort; under heavy contention
    // POSIX O_APPEND atomicity still protects small line writes, so skipping
    // the lock rather than stalling orchestration is the correct tradeoff.
    withFileLockSync(
      path,
      () => {
        appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
      },
      { onLocked: "skip" },
    );
  } catch {
    // Best-effort: audit writes must never break orchestration.
  }

  if (!isDbAvailable()) return;
  try {
    insertAuditEvent(event);
  } catch {
    // Projection failures are non-fatal while legacy readers are still active.
  }
}
