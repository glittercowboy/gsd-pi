import type { FailureClass, GateResult } from "./contracts.js";
import { insertGateRun } from "../gsd-db.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./audit.js";

export interface GateRunnerContext {
  basePath: string;
  traceId: string;
  turnId: string;
  milestoneId?: string;
  sliceId?: string;
  taskId?: string;
  unitType?: string;
  unitId?: string;
}

export interface GateExecutionInput {
  id: string;
  type: string;
  execute: (ctx: GateRunnerContext, attempt: number) => Promise<{
    outcome: "pass" | "fail" | "retry" | "manual-attention";
    rationale?: string;
    findings?: string;
    failureClass?: FailureClass;
  }>;
}

const RETRY_MATRIX: Record<FailureClass, number> = {
  none: 0,
  policy: 0,
  input: 0,
  execution: 1,
  artifact: 1,
  verification: 1,
  closeout: 1,
  git: 1,
  timeout: 2,
  "manual-attention": 0,
  unknown: 0,
};

export class UokGateRunner {
  private readonly registry = new Map<string, GateExecutionInput>();

  register(gate: GateExecutionInput): void {
    this.registry.set(gate.id, gate);
  }

  list(): GateExecutionInput[] {
    return Array.from(this.registry.values());
  }

  async run(id: string, ctx: GateRunnerContext): Promise<GateResult> {
    const gate = this.registry.get(id);
    if (!gate) {
      return {
        gateId: id,
        gateType: "unknown",
        outcome: "manual-attention",
        failureClass: "unknown",
        rationale: `Gate ${id} not registered`,
        attempt: 1,
        maxAttempts: 1,
        retryable: false,
        evaluatedAt: new Date().toISOString(),
      };
    }

    let attempt = 0;
    let final: GateResult | null = null;
    const maxAttemptsByFailureClass = RETRY_MATRIX;

    while (attempt < 3) {
      attempt += 1;
      const now = new Date().toISOString();
      const result = await gate.execute(ctx, attempt);
      const failureClass = result.failureClass ?? (result.outcome === "pass" ? "none" : "unknown");
      const retryBudget = maxAttemptsByFailureClass[failureClass] ?? 0;
      const retryable = result.outcome !== "pass" && attempt <= retryBudget;

      final = {
        gateId: gate.id,
        gateType: gate.type,
        outcome: retryable ? "retry" : result.outcome,
        failureClass,
        rationale: result.rationale,
        findings: result.findings,
        attempt,
        maxAttempts: Math.max(1, retryBudget),
        retryable,
        evaluatedAt: now,
      };

      insertGateRun({
        traceId: ctx.traceId,
        turnId: ctx.turnId,
        gateId: final.gateId,
        gateType: final.gateType,
        unitType: ctx.unitType,
        unitId: ctx.unitId,
        milestoneId: ctx.milestoneId,
        sliceId: ctx.sliceId,
        taskId: ctx.taskId,
        outcome: final.outcome,
        failureClass: final.failureClass,
        rationale: final.rationale,
        findings: final.findings,
        attempt: final.attempt,
        maxAttempts: final.maxAttempts,
        retryable: final.retryable,
        evaluatedAt: final.evaluatedAt,
      });

      emitUokAuditEvent(
        ctx.basePath,
        buildAuditEnvelope({
          traceId: ctx.traceId,
          turnId: ctx.turnId,
          category: "gate",
          type: "gate-run",
          payload: {
            gateId: final.gateId,
            gateType: final.gateType,
            outcome: final.outcome,
            failureClass: final.failureClass,
            attempt: final.attempt,
            maxAttempts: final.maxAttempts,
            retryable: final.retryable,
          },
        }),
      );

      if (!retryable) break;
    }

    return final ?? {
      gateId: gate.id,
      gateType: gate.type,
      outcome: "manual-attention",
      failureClass: "unknown",
      attempt: 1,
      maxAttempts: 1,
      retryable: false,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
