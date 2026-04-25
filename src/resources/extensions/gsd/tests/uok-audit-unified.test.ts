import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitJournalEvent } from "../journal.ts";
import { saveActivityLog } from "../activity-log.ts";
import { initMetrics, resetMetrics, snapshotUnitMetrics } from "../metrics.ts";
import { setLogBasePath, logWarning } from "../workflow-logger.ts";
import { setUnifiedAuditEnabled } from "../uok/audit-toggle.ts";

function readAuditEvents(basePath: string): Array<Record<string, unknown>> {
  const file = join(basePath, ".gsd", "audit", "events.jsonl");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeMockContext(entries: unknown[]): any {
  return {
    sessionManager: {
      getEntries: () => entries,
    },
  };
}

test("unified audit plane bridges journal/activity/metrics/workflow logger into audit envelope log", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-audit-"));
  setUnifiedAuditEnabled(true);
  try {
    emitJournalEvent(basePath, {
      ts: new Date().toISOString(),
      flowId: "trace-123",
      seq: 1,
      eventType: "iteration-start",
      data: { turnId: "turn-123", unitId: "M001/S01/T01" },
    });

    const activityCtx = makeMockContext([
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ]);
    const activityPath = saveActivityLog(activityCtx, basePath, "execute-task", "M001/S01/T01");
    assert.ok(activityPath);

    initMetrics(basePath);
    const metricsCtx = makeMockContext([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.01 },
          content: [],
        },
      },
    ]);
    const unit = snapshotUnitMetrics(
      metricsCtx,
      "execute-task",
      "M001/S01/T01",
      Date.now() - 1000,
      "openai/gpt-5.4",
      { traceId: "trace-123", turnId: "turn-123" },
    );
    assert.ok(unit);
    resetMetrics();

    setLogBasePath(basePath);
    logWarning("engine", "audit bridge check", { id: "turn-123" });

    const events = readAuditEvents(basePath);
    const types = new Set(events.map((event) => String(event.type ?? "")));
    assert.ok(types.has("journal-iteration-start"));
    assert.ok(types.has("activity-log-saved"));
    assert.ok(types.has("unit-metrics-snapshot"));
    assert.ok(types.has("workflow-log-warn"));
  } finally {
    setUnifiedAuditEnabled(false);
    resetMetrics();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("unified audit bridge is disabled when toggle is off", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-audit-off-"));
  setUnifiedAuditEnabled(false);
  try {
    emitJournalEvent(basePath, {
      ts: new Date().toISOString(),
      flowId: "trace-off",
      seq: 1,
      eventType: "iteration-start",
    });
    const events = readAuditEvents(basePath);
    assert.equal(events.length, 0);
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});
