import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTurnObserver } from "../uok/loop-adapter.ts";
import { hasActiveWriterToken, resetWriterTokensForTests } from "../uok/writer.ts";

function readAuditPayloads(basePath: string): Array<Record<string, unknown>> {
  const path = join(basePath, ".gsd", "audit", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { payload?: Record<string, unknown> })
    .map((event) => event.payload ?? {});
}

test("uok turn observer adds writer sequence metadata to audit events", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-loop-writer-"));
  resetWriterTokensForTests();
  t.after(() => {
    resetWriterTokensForTests();
    rmSync(basePath, { recursive: true, force: true });
  });

  const observer = createTurnObserver({
    basePath,
    gitAction: "status-only",
    gitPush: false,
    enableAudit: true,
    enableGitops: false,
  });

  observer.onTurnStart({
    basePath,
    traceId: "trace-1",
    turnId: "turn-1",
    iteration: 1,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    startedAt: new Date().toISOString(),
  });
  assert.equal(hasActiveWriterToken(basePath, "turn-1"), true);

  observer.onTurnResult({
    traceId: "trace-1",
    turnId: "turn-1",
    iteration: 1,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    status: "completed",
    failureClass: "none",
    phaseResults: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  assert.equal(hasActiveWriterToken(basePath, "turn-1"), false);
  const payloads = readAuditPayloads(basePath);
  assert.equal(payloads[0]?.writeSequence, 1);
  assert.equal(payloads[1]?.writeSequence, 2);
  assert.equal(typeof payloads[0]?.writerTokenId, "string");
});
