import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildParityReport, parseParityEvents, writeParityReport } from "../uok/parity-report.ts";

test("uok parity report summarizes paths, statuses, and fallback use", () => {
  const events = parseParityEvents([
    JSON.stringify({ path: "uok-kernel", phase: "enter" }),
    JSON.stringify({ path: "uok-kernel", phase: "exit", status: "ok" }),
    JSON.stringify({ path: "legacy-fallback", phase: "enter" }),
    JSON.stringify({ path: "legacy-fallback", phase: "exit", status: "error", error: "boom" }),
  ].join("\n"));

  const report = buildParityReport(events, "/tmp/uok-parity.jsonl");
  assert.equal(report.totalEvents, 4);
  assert.equal(report.paths["uok-kernel"], 2);
  assert.equal(report.fallbackInvocations, 2);
  assert.deepEqual(report.criticalMismatches, ["boom"]);
});

test("uok parity report writes runtime report artifact", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-parity-"));
  t.after(() => {
    rmSync(basePath, { recursive: true, force: true });
  });

  const runtime = join(basePath, ".gsd", "runtime");
  mkdirSync(runtime, { recursive: true });
  appendFileSync(
    join(runtime, "uok-parity.jsonl"),
    `${JSON.stringify({ path: "uok-kernel", phase: "exit", status: "ok" })}\n`,
    "utf-8",
  );

  const report = writeParityReport(basePath);
  assert.equal(report.totalEvents, 1);
  const saved = JSON.parse(readFileSync(join(runtime, "uok-parity-report.json"), "utf-8"));
  assert.equal(saved.statuses.ok, 1);
});
