import type {
  TurnCloseoutRecord,
  TurnContract,
  TurnResult,
  UokTurnObserver,
} from "./contracts.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./audit.js";
import { writeTurnCloseoutGitRecord, writeTurnGitTransaction } from "./gitops.js";

export interface CreateTurnObserverOptions {
  basePath: string;
  gitAction: "commit" | "snapshot" | "status-only";
  gitPush: boolean;
  enableAudit: boolean;
  enableGitops: boolean;
}

export function createTurnObserver(options: CreateTurnObserverOptions): UokTurnObserver {
  let current: TurnContract | null = null;
  const phaseResults: TurnResult["phaseResults"] = [];

  return {
    onTurnStart(contract): void {
      current = contract;
      phaseResults.length = 0;

      if (options.enableGitops) {
        writeTurnGitTransaction({
          basePath: options.basePath,
          traceId: contract.traceId,
          turnId: contract.turnId,
          unitType: contract.unitType,
          unitId: contract.unitId,
          stage: "turn-start",
          action: options.gitAction,
          push: options.gitPush,
          status: "ok",
          metadata: {
            iteration: contract.iteration,
            sidecarKind: contract.sidecarKind,
          },
        });
      }

      if (options.enableAudit) {
        emitUokAuditEvent(
          options.basePath,
          buildAuditEnvelope({
            traceId: contract.traceId,
            turnId: contract.turnId,
            category: "orchestration",
            type: "turn-start",
            payload: {
              iteration: contract.iteration,
              unitType: contract.unitType,
              unitId: contract.unitId,
              sidecarKind: contract.sidecarKind,
            },
          }),
        );
      }
    },

    onPhaseResult(phase, action, data): void {
      phaseResults.push({
        phase,
        action,
        ts: new Date().toISOString(),
        data,
      });

      if (!current || !options.enableGitops) return;
      if (phase === "dispatch") {
        writeTurnGitTransaction({
          basePath: options.basePath,
          traceId: current.traceId,
          turnId: current.turnId,
          unitType: data?.unitType as string | undefined,
          unitId: data?.unitId as string | undefined,
          stage: "stage",
          action: options.gitAction,
          push: options.gitPush,
          status: "ok",
          metadata: { action },
        });
      }
      if (phase === "unit") {
        writeTurnGitTransaction({
          basePath: options.basePath,
          traceId: current.traceId,
          turnId: current.turnId,
          unitType: data?.unitType as string | undefined,
          unitId: data?.unitId as string | undefined,
          stage: "checkpoint",
          action: options.gitAction,
          push: options.gitPush,
          status: "ok",
          metadata: { action },
        });
      }
      if (phase === "finalize") {
        writeTurnGitTransaction({
          basePath: options.basePath,
          traceId: current.traceId,
          turnId: current.turnId,
          unitType: data?.unitType as string | undefined,
          unitId: data?.unitId as string | undefined,
          stage: "publish",
          action: options.gitAction,
          push: options.gitPush,
          status: "ok",
          metadata: { action },
        });
      }
    },

    onTurnResult(result): void {
      const merged: TurnResult = {
        ...result,
        phaseResults: result.phaseResults.length > 0 ? result.phaseResults : [...phaseResults],
      };

      if (options.enableAudit) {
        emitUokAuditEvent(
          options.basePath,
          buildAuditEnvelope({
            traceId: merged.traceId,
            turnId: merged.turnId,
            category: "orchestration",
            type: "turn-result",
            payload: {
              unitType: merged.unitType,
              unitId: merged.unitId,
              status: merged.status,
              failureClass: merged.failureClass,
              error: merged.error,
              phaseCount: merged.phaseResults.length,
            },
          }),
        );
      }

      if (options.enableGitops) {
        const closeout: TurnCloseoutRecord = merged.closeout ?? {
          traceId: merged.traceId,
          turnId: merged.turnId,
          unitType: merged.unitType,
          unitId: merged.unitId,
          status: merged.status,
          failureClass: merged.failureClass,
          gitAction: options.gitAction,
          gitPushed: options.gitPush,
          finishedAt: merged.finishedAt,
        };
        writeTurnCloseoutGitRecord(options.basePath, closeout);
      }

      current = null;
      phaseResults.length = 0;
    },
  };
}
