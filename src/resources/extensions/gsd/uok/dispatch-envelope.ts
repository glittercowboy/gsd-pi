import type {
  DispatchExplanation,
  DispatchReasonCode,
  GateResult,
  UokDispatchEnvelope,
  UokGraphNode,
} from "./contracts.js";

export interface BuildDispatchEnvelopeInput {
  action: UokDispatchEnvelope["action"];
  node?: Pick<UokGraphNode, "kind" | "reads" | "writes" | "dependsOn">;
  unitType?: string;
  unitId?: string;
  prompt?: string;
  reasonCode: DispatchReasonCode;
  summary: string;
  evidence?: Record<string, unknown>;
  blockedBy?: DispatchExplanation["blockedBy"];
  gateVerdict?: GateResult;
  trace?: UokDispatchEnvelope["trace"];
}

export function buildDispatchEnvelope(input: BuildDispatchEnvelopeInput): UokDispatchEnvelope {
  return {
    action: input.action,
    nodeKind: input.node?.kind,
    unitType: input.unitType,
    unitId: input.unitId,
    prompt: input.prompt,
    reason: {
      reasonCode: input.reasonCode,
      summary: input.summary,
      evidence: input.evidence,
      blockedBy: input.blockedBy,
    },
    gateVerdict: input.gateVerdict,
    constraints: input.node
      ? {
          reads: input.node.reads,
          writes: input.node.writes,
          dependsOn: input.node.dependsOn,
        }
      : undefined,
    trace: input.trace,
  };
}

export function explainDispatch(envelope: UokDispatchEnvelope): string {
  const subject = envelope.unitType && envelope.unitId
    ? `${envelope.unitType} ${envelope.unitId}`
    : envelope.nodeKind ?? envelope.action;
  const blocked = envelope.reason.blockedBy && envelope.reason.blockedBy.length > 0
    ? ` Blocked by: ${envelope.reason.blockedBy.map((b) => `${b.kind}:${b.id}`).join(", ")}.`
    : "";
  return `[${envelope.reason.reasonCode}] ${subject}: ${envelope.reason.summary}.${blocked}`;
}
