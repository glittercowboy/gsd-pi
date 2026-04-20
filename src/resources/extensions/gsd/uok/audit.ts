import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  try {
    ensureAuditDir(basePath);
    appendFileSync(auditLogPath(basePath), `${JSON.stringify(event)}\n`, "utf-8");
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
