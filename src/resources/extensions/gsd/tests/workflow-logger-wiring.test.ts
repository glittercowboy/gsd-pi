// GSD Extension — workflow-logger wiring regression tests
//
// Verifies the plumbing between workflow-logger and the rest of the state
// system (auto-loop phases, detect-stuck, notification store). Without this
// wiring, warnings/errors logged during a unit leak across units, never
// reach the user as a consolidated post-unit alert, and don't enrich
// stuck-detection reasons.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  logWarning,
  logError,
  peekLogs,
  _resetLogs,
  setStderrLoggingEnabled,
} from "../workflow-logger.ts";
import { detectStuck } from "../auto/detect-stuck.ts";

const phasesSrc = readFileSync(
  join(import.meta.dirname, "..", "auto", "phases.ts"),
  "utf-8",
);
const autoSrc = readFileSync(
  join(import.meta.dirname, "..", "auto.ts"),
  "utf-8",
);

// ─── Source-scan: phases.ts calls the logger lifecycle API ─────────────────

test("auto/phases.ts imports _resetLogs, drainAndSummarize, formatForNotification, hasAnyIssues", () => {
  assert.match(
    phasesSrc,
    /from\s+"\.\.\/workflow-logger\.js"/,
    "phases.ts imports from workflow-logger",
  );
  for (const name of [
    "_resetLogs",
    "drainLogs",
    "drainAndSummarize",
    "formatForNotification",
    "hasAnyIssues",
  ]) {
    assert.ok(
      phasesSrc.includes(name),
      `phases.ts should reference ${name}`,
    );
  }
});

test("runUnitPhase calls _resetLogs() before assigning s.currentUnit", () => {
  // Find the "s.currentUnit = { type: unitType" assignment line and check
  // the preceding ~500 chars contain a _resetLogs() call.
  const idx = phasesSrc.indexOf("s.currentUnit = { type: unitType");
  assert.ok(idx > 0, "runUnitPhase should assign s.currentUnit");
  const before = phasesSrc.slice(Math.max(0, idx - 500), idx);
  assert.match(
    before,
    /_resetLogs\(\)/,
    "_resetLogs() must be called immediately before s.currentUnit assignment",
  );
});

test("runFinalize drains and surfaces logger buffer via ctx.ui.notify", () => {
  // Locate the runFinalize success path and verify it calls drainAndSummarize
  // and routes the result through ctx.ui.notify.
  const runFinalizeIdx = phasesSrc.indexOf("export async function runFinalize");
  assert.ok(runFinalizeIdx > 0, "runFinalize export should exist");
  const finalizeBody = phasesSrc.slice(runFinalizeIdx);
  assert.match(
    finalizeBody,
    /hasAnyIssues\(\)/,
    "runFinalize should gate drain on hasAnyIssues",
  );
  assert.match(
    finalizeBody,
    /drainAndSummarize\(\)/,
    "runFinalize should call drainAndSummarize on success",
  );
  assert.match(
    finalizeBody,
    /formatForNotification\(logs\)/,
    "runFinalize should format drained logs for the notification",
  );
});

test("runFinalize timeout branches drain the buffer to prevent bleed", () => {
  // Both timeout branches route through failClosedOnFinalizeTimeout; that
  // helper must drain the buffer so timed-out unit logs do not bleed into
  // the next unit.
  const runFinalizeIdx = phasesSrc.indexOf("export async function runFinalize");
  const finalizeBody = phasesSrc.slice(runFinalizeIdx);
  const timeoutHelperCalls =
    (finalizeBody.match(/failClosedOnFinalizeTimeout\(/g) ?? []).length;
  assert.ok(
    timeoutHelperCalls >= 2,
    `runFinalize timeout branches should each route through failClosedOnFinalizeTimeout() (found ${timeoutHelperCalls}, expected >= 2)`,
  );

  const helperMatch = phasesSrc.match(
    /async function failClosedOnFinalizeTimeout[\s\S]*?drainLogs\(\)/,
  );
  assert.ok(
    helperMatch,
    "failClosedOnFinalizeTimeout should drain the logger buffer before returning",
  );
});

// ─── Source-scan: auto.ts calls setLogBasePath in startAuto ────────────────

test("startAuto calls setLogBasePath(base) so audit log is pinned on resume", () => {
  const startAutoIdx = autoSrc.indexOf("export async function startAuto");
  assert.ok(startAutoIdx > 0, "startAuto export should exist");
  const body = autoSrc.slice(startAutoIdx);
  assert.match(
    body,
    /setLogBasePath\(base\)/,
    "startAuto must call setLogBasePath(base) to pin the audit log",
  );
});

// ─── Runtime: detect-stuck enriches reason with summarizeLogs() ────────────

test("detectStuck reason includes workflow-logger summary when logs present", () => {
  setStderrLoggingEnabled(false);
  try {
    _resetLogs();
    logWarning("projection", "STATE.md render failed");
    logError("db", "WAL checkpoint failed");

    const result = detectStuck([
      { key: "execute-task/slice-A/task-1", error: "ENOENT: no such file" },
      { key: "execute-task/slice-A/task-1", error: "ENOENT: no such file" },
    ]);

    assert.notEqual(result, null);
    assert.equal(result!.stuck, true);
    assert.match(
      result!.reason,
      /Same error repeated:/,
      "reason should still start with the rule string",
    );
    assert.match(
      result!.reason,
      /STATE\.md render failed/,
      "reason should include the accumulated logger warning",
    );
    assert.match(
      result!.reason,
      /WAL checkpoint failed/,
      "reason should include the accumulated logger error",
    );

    // Critical: summarizeLogs must not drain — the auto-loop's finalize
    // step owns the buffer lifecycle, detect-stuck is read-only.
    assert.equal(
      peekLogs().length,
      2,
      "detect-stuck must not drain the buffer",
    );
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(true);
  }
});

test("detectStuck reason unchanged when logger buffer is empty", () => {
  setStderrLoggingEnabled(false);
  try {
    _resetLogs();
    const result = detectStuck([
      { key: "A", error: "boom" },
      { key: "A", error: "boom" },
    ]);
    assert.notEqual(result, null);
    // No trailing " — " suffix when there are no logs to summarize.
    assert.doesNotMatch(
      result!.reason,
      / — \d+ (error|warning)/,
      "reason should have no logger suffix when buffer is empty",
    );
  } finally {
    setStderrLoggingEnabled(true);
  }
});

// ─── Runtime: readTransaction rollback failure surfaces via logError ────────
//
// snapshotState now delegates its transaction to readTransaction() in
// gsd-db.ts (single-writer refactor in #4198), so the split-brain
// ROLLBACK-failure log lives there, not in workflow-manifest.ts.

test("readTransaction logs ROLLBACK failures as split-brain signal", () => {
  const dbSrc = readFileSync(
    join(import.meta.dirname, "..", "gsd-db.ts"),
    "utf-8",
  );
  assert.match(
    dbSrc,
    /logError\("db",\s*"snapshotState ROLLBACK failed"/,
    "readTransaction ROLLBACK catch should call logError",
  );
});

// ─── Runtime: state.ts and workflow-projections.ts log silent bailouts ─────

test("state.ts logs roadmap read failures instead of silently continuing", () => {
  const stateSrc = readFileSync(
    join(import.meta.dirname, "..", "state.ts"),
    "utf-8",
  );
  assert.match(
    stateSrc,
    /logWarning\("state",\s*"reconcileDiskToDb: roadmap read failed/,
    "state.ts reconcileDiskToDb should log roadmap read failures",
  );
});

test("workflow-projections.ts logs DB probe failures instead of silent return", () => {
  const projectionsSrc = readFileSync(
    join(import.meta.dirname, "..", "workflow-projections.ts"),
    "utf-8",
  );
  assert.match(
    projectionsSrc,
    /logWarning\("projection",\s*"renderStateProjection: DB handle probe failed/,
    "renderStateProjection DB probe should log on failure",
  );
});
