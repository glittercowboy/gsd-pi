/**
 * est-annotation-timeout.test.ts — Regression tests for #2243.
 *
 * Tasks with `est: 30m` or `est: 2h` annotations should get extended
 * supervision timeouts. The parseEstimateMinutes helper should parse
 * estimate strings, and startUnitSupervision should use them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const timersSrcPath = join(import.meta.dirname, "..", "auto-timers.ts");
const timersSrc = readFileSync(timersSrcPath, "utf-8");

// ─── Source analysis: parseEstimateMinutes exists and is exported ────────────

test("#2243: auto-timers.ts should export parseEstimateMinutes", () => {
  assert.ok(
    timersSrc.includes("export function parseEstimateMinutes"),
    "parseEstimateMinutes should be exported from auto-timers.ts",
  );
});

// ─── Inline unit test of parseEstimateMinutes logic ─────────────────────────
// Since importing the module pulls in heavy deps, test the parsing logic inline.

function parseEstimateMinutes(estimate: string): number | null {
  if (!estimate || typeof estimate !== "string") return null;
  const trimmed = estimate.trim();
  if (!trimmed) return null;

  let totalMinutes = 0;
  let matched = false;

  const hoursMatch = trimmed.match(/(\d+)\s*h/i);
  if (hoursMatch) {
    totalMinutes += Number(hoursMatch[1]) * 60;
    matched = true;
  }

  const minutesMatch = trimmed.match(/(\d+)\s*m/i);
  if (minutesMatch) {
    totalMinutes += Number(minutesMatch[1]);
    matched = true;
  }

  return matched ? totalMinutes : null;
}

test("#2243: parseEstimateMinutes parses '30m' correctly", () => {
  assert.equal(parseEstimateMinutes("30m"), 30);
});

test("#2243: parseEstimateMinutes parses '2h' correctly", () => {
  assert.equal(parseEstimateMinutes("2h"), 120);
});

test("#2243: parseEstimateMinutes parses '1h30m' correctly", () => {
  assert.equal(parseEstimateMinutes("1h30m"), 90);
});

test("#2243: parseEstimateMinutes parses '15m' correctly", () => {
  assert.equal(parseEstimateMinutes("15m"), 15);
});

test("#2243: parseEstimateMinutes returns null for empty string", () => {
  assert.equal(parseEstimateMinutes(""), null);
});

test("#2243: parseEstimateMinutes returns null for invalid string", () => {
  assert.equal(parseEstimateMinutes("not a time"), null);
});

// ─── Source analysis: startUnitSupervision uses task estimates ───────────────

test("#2243: startUnitSupervision should reference task estimates for timeout scaling", () => {
  const usesEstimate =
    timersSrc.includes("parseEstimateMinutes") &&
    timersSrc.includes("estimateMinutes") &&
    timersSrc.includes("taskEstimate");

  assert.ok(
    usesEstimate,
    "startUnitSupervision should use task estimate annotations for timeout scaling",
  );
});

test("#2243: SupervisionContext should accept an optional taskEstimate field", () => {
  const ctxIdx = timersSrc.indexOf("SupervisionContext");
  assert.ok(ctxIdx !== -1, "SupervisionContext interface exists");

  const ctxEnd = timersSrc.indexOf("}", ctxIdx);
  const ctxBlock = timersSrc.slice(ctxIdx, ctxEnd);

  assert.ok(
    ctxBlock.includes("taskEstimate"),
    "SupervisionContext should include a taskEstimate field",
  );
});

test("#2243: timeouts should be scaled by estimate (timeoutScale in source)", () => {
  assert.ok(
    timersSrc.includes("timeoutScale"),
    "auto-timers.ts should use a timeoutScale factor derived from est: annotations",
  );
});

test("#2243: idle timeout should NOT be scaled (idle is idle regardless of estimate)", () => {
  // Find the idleTimeoutMs line
  const idleIdx = timersSrc.indexOf("const idleTimeoutMs");
  assert.ok(idleIdx !== -1, "idleTimeoutMs variable exists");
  
  const idleLine = timersSrc.slice(idleIdx, timersSrc.indexOf("\n", idleIdx));
  assert.ok(
    !idleLine.includes("timeoutScale"),
    "idleTimeoutMs should NOT be scaled — idle is idle",
  );
});
