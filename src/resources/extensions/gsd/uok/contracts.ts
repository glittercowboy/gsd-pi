export type FailureClass =
  | "none"
  | "policy"
  | "input"
  | "execution"
  | "artifact"
  | "verification"
  | "closeout"
  | "git"
  | "timeout"
  | "manual-attention"
  | "unknown";

export type GateOutcome = "pass" | "fail" | "retry" | "manual-attention";

export type DispatchReasonCode =
  | "policy"
  | "state"
  | "recovery"
  | "manual"
  | "dependency"
  | "conflict"
  | "retry";

export interface GateResult {
  gateId: string;
  gateType: string;
  outcome: GateOutcome;
  failureClass: FailureClass;
  rationale?: string;
  findings?: string;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  evaluatedAt: string;
}

export type TurnPhase =
  | "pre-dispatch"
  | "dispatch"
  | "unit"
  | "finalize"
  | "guard"
  | "custom-engine";

export type TurnStatus =
  | "completed"
  | "failed"
  | "paused"
  | "stopped"
  | "skipped"
  | "retry";

export interface TurnContract {
  traceId: string;
  turnId: string;
  iteration: number;
  basePath: string;
  unitType?: string;
  unitId?: string;
  sidecarKind?: string;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

export interface TurnCloseoutRecord {
  traceId: string;
  turnId: string;
  unitType?: string;
  unitId?: string;
  status: TurnStatus;
  failureClass: FailureClass;
  gitAction: "commit" | "snapshot" | "status-only";
  gitPushed: boolean;
  activityFile?: string;
  finishedAt: string;
}

export interface TurnResult {
  traceId: string;
  turnId: string;
  iteration: number;
  unitType?: string;
  unitId?: string;
  status: TurnStatus;
  failureClass: FailureClass;
  phaseResults: Array<{
    phase: TurnPhase;
    action: string;
    ts: string;
    data?: Record<string, unknown>;
  }>;
  gateResults?: GateResult[];
  closeout?: TurnCloseoutRecord;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface DispatchExplanation {
  reasonCode: DispatchReasonCode;
  summary: string;
  evidence?: Record<string, unknown>;
  blockedBy?: Array<{
    kind: "gate" | "state" | "dependency" | "conflict" | "policy" | "manual";
    id: string;
    detail?: string;
  }>;
}

export interface UokDispatchEnvelope {
  action: "dispatch" | "stop" | "skip";
  nodeKind?: UokNodeKind;
  unitType?: string;
  unitId?: string;
  prompt?: string;
  reason: DispatchExplanation;
  gateVerdict?: GateResult;
  constraints?: {
    reads?: string[];
    writes?: string[];
    dependsOn?: string[];
    maxWorkers?: number;
  };
  trace?: {
    traceId?: string;
    turnId?: string;
    causedBy?: string;
  };
}

export interface AuditEventEnvelope {
  eventId: string;
  traceId: string;
  turnId?: string;
  causedBy?: string;
  category:
    | "orchestration"
    | "gate"
    | "model-policy"
    | "gitops"
    | "verification"
    | "metrics"
    | "plan"
    | "execution";
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export type UokNodeKind =
  | "unit"
  | "hook"
  | "subagent"
  | "team-worker"
  | "verification"
  | "reprocess"
  | "refine";

export interface UokGraphNode {
  id: string;
  kind: UokNodeKind;
  dependsOn: string[];
  writes?: string[];
  reads?: string[];
  metadata?: Record<string, unknown>;
}

export interface WriterToken {
  tokenId: string;
  traceId: string;
  turnId: string;
  acquiredAt: string;
  owner: "uok" | "legacy-compat" | "manual";
}

export interface WriteSequence {
  traceId: string;
  turnId: string;
  sequence: number;
}

export interface WriteRecord {
  writerToken: WriterToken;
  sequence: WriteSequence;
  category: "state" | "audit" | "gitops" | "gate" | "artifact" | "other";
  path?: string;
  operation: "append" | "replace" | "insert" | "update" | "delete" | "noop";
  ts: string;
  metadata?: Record<string, unknown>;
}

export interface UokTurnObserver {
  onTurnStart(contract: TurnContract): void;
  onPhaseResult(
    phase: TurnPhase,
    action: string,
    data?: Record<string, unknown>,
  ): void;
  onTurnResult(result: TurnResult): void;
}
