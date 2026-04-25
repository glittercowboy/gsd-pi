import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireWriterToken,
  hasActiveWriterToken,
  nextWriteRecord,
  releaseWriterToken,
  resetWriterTokensForTests,
} from "../uok/writer.ts";

test("uok writer enforces one active token per turn", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-writer-"));
  resetWriterTokensForTests();
  t.after(() => {
    resetWriterTokensForTests();
    rmSync(basePath, { recursive: true, force: true });
  });

  const token = acquireWriterToken({
    basePath,
    traceId: "trace-1",
    turnId: "turn-1",
  });
  assert.equal(hasActiveWriterToken(basePath, "turn-1"), true);
  assert.throws(
    () => acquireWriterToken({ basePath, traceId: "trace-1", turnId: "turn-1" }),
    /already active/,
  );

  releaseWriterToken(basePath, token);
  assert.equal(hasActiveWriterToken(basePath, "turn-1"), false);
});

test("uok writer produces monotonic sequence records across turns", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-writer-seq-"));
  resetWriterTokensForTests();
  t.after(() => {
    resetWriterTokensForTests();
    rmSync(basePath, { recursive: true, force: true });
  });

  const token1 = acquireWriterToken({
    basePath,
    traceId: "trace-1",
    turnId: "turn-1",
  });
  const first = nextWriteRecord({
    basePath,
    token: token1,
    category: "audit",
    operation: "append",
    path: ".gsd/audit/events.jsonl",
  });
  releaseWriterToken(basePath, token1);

  const token2 = acquireWriterToken({
    basePath,
    traceId: "trace-2",
    turnId: "turn-2",
  });
  const second = nextWriteRecord({
    basePath,
    token: token2,
    category: "gitops",
    operation: "insert",
  });

  assert.equal(first.sequence.sequence, 1);
  assert.equal(second.sequence.sequence, 2);
  assert.equal(second.sequence.turnId, "turn-2");
});
