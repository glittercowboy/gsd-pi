import test from "node:test";
import assert from "node:assert/strict";

import type {
  AuditEventEnvelope,
  GateResult,
  TurnContract,
  TurnResult,
  UokNodeKind,
} from "../uok/contracts.ts";
import { buildAuditEnvelope } from "../uok/audit.ts";

test("uok contracts serialize/deserialize turn envelopes", () => {
  const contract: TurnContract = {
    traceId: "trace-1",
    turnId: "turn-1",
    iteration: 1,
    basePath: "/tmp/project",
    unitType: "execute-task",
    unitId: "M001.S01.T01",
    startedAt: new Date().toISOString(),
  };

  const gate: GateResult = {
    gateId: "Q3",
    gateType: "policy",
    outcome: "pass",
    failureClass: "none",
    attempt: 1,
    maxAttempts: 1,
    retryable: false,
    evaluatedAt: new Date().toISOString(),
  };

  const result: TurnResult = {
    traceId: contract.traceId,
    turnId: contract.turnId,
    iteration: contract.iteration,
    unitType: contract.unitType,
    unitId: contract.unitId,
    status: "completed",
    failureClass: "none",
    phaseResults: [
      { phase: "dispatch", action: "next", ts: new Date().toISOString() },
      { phase: "unit", action: "continue", ts: new Date().toISOString() },
      { phase: "finalize", action: "next", ts: new Date().toISOString() },
    ],
    gateResults: [gate],
    startedAt: contract.startedAt,
    finishedAt: new Date().toISOString(),
  };

  const roundTrip = JSON.parse(JSON.stringify(result)) as TurnResult;
  assert.equal(roundTrip.turnId, "turn-1");
  assert.equal(roundTrip.gateResults?.[0]?.gateId, "Q3");
  assert.equal(roundTrip.phaseResults.length, 3);
});

test("uok contracts include required DAG node kinds", () => {
  const required: UokNodeKind[] = [
    "unit",
    "hook",
    "subagent",
    "team-worker",
    "verification",
    "reprocess",
    "refine",
  ];
  assert.deepEqual(required.length, 7);
});

test("uok audit envelope includes trace/turn/causality fields", () => {
  const event: AuditEventEnvelope = buildAuditEnvelope({
    traceId: "trace-xyz",
    turnId: "turn-xyz",
    causedBy: "turn-start",
    category: "orchestration",
    type: "turn-result",
    payload: { status: "completed" },
  });

  assert.equal(event.traceId, "trace-xyz");
  assert.equal(event.turnId, "turn-xyz");
  assert.equal(event.causedBy, "turn-start");
  assert.equal(event.payload.status, "completed");
});
