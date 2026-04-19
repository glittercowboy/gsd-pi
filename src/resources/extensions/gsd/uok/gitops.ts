import { isDbAvailable, upsertTurnGitTransaction } from "../gsd-db.js";
import type { TurnCloseoutRecord } from "./contracts.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./audit.js";

export type TurnGitStage = "turn-start" | "stage" | "checkpoint" | "publish" | "record";

interface GitTxArgs {
  basePath: string;
  traceId: string;
  turnId: string;
  unitType?: string;
  unitId?: string;
  stage: TurnGitStage;
  action: "commit" | "snapshot" | "status-only";
  push: boolean;
  status: "ok" | "failed";
  error?: string;
  metadata?: Record<string, unknown>;
}

export function writeTurnGitTransaction(args: GitTxArgs): void {
  if (!isDbAvailable()) return;
  upsertTurnGitTransaction({
    traceId: args.traceId,
    turnId: args.turnId,
    unitType: args.unitType,
    unitId: args.unitId,
    stage: args.stage,
    action: args.action,
    push: args.push,
    status: args.status,
    error: args.error,
    metadata: args.metadata,
    updatedAt: new Date().toISOString(),
  });

  emitUokAuditEvent(
    args.basePath,
    buildAuditEnvelope({
      traceId: args.traceId,
      turnId: args.turnId,
      category: "gitops",
      type: `turn-git-${args.stage}`,
      payload: {
        unitType: args.unitType,
        unitId: args.unitId,
        action: args.action,
        push: args.push,
        status: args.status,
        error: args.error,
        ...(args.metadata ?? {}),
      },
    }),
  );
}

export function writeTurnCloseoutGitRecord(basePath: string, record: TurnCloseoutRecord): void {
  writeTurnGitTransaction({
    basePath,
    traceId: record.traceId,
    turnId: record.turnId,
    unitType: record.unitType,
    unitId: record.unitId,
    stage: "record",
    action: record.gitAction,
    push: record.gitPushed,
    status: record.failureClass === "git" ? "failed" : "ok",
    error: record.failureClass === "git" ? "git closeout failure" : undefined,
    metadata: {
      turnStatus: record.status,
      finishedAt: record.finishedAt,
      activityFile: record.activityFile,
    },
  });
}
