/**
 * dispatch-stall-guard.test.ts — Verifies defensive guards against dispatch stalls (#1073).
 *
 * After a slice completes, dispatchNextUnit must reliably dispatch the next unit.
 * These tests verify:
 * 1. newSession() has timeout protection (prevents permanent hang if session creation stalls)
 * 2. handleAgentEnd has a dispatch hang guard (catches dispatchNextUnit itself hanging)
 * 3. Session timeout constants are exported for configurability
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_TS_PATH = join(__dirname, "..", "auto.ts");
const SESSION_TS_PATH = join(__dirname, "..", "auto", "session.ts");

function getAutoTsSource(): string {
  return readFileSync(AUTO_TS_PATH, "utf-8");
}

function getSessionTsSource(): string {
  return readFileSync(SESSION_TS_PATH, "utf-8");
}

// ── Session timeout constants ───────────────────────────────────────────────

test("AutoSession exports NEW_SESSION_TIMEOUT_MS constant", () => {
  const source = getSessionTsSource();
  assert.ok(
    source.includes("NEW_SESSION_TIMEOUT_MS"),
    "auto/session.ts must export NEW_SESSION_TIMEOUT_MS for newSession() timeout",
  );
});

test("AutoSession exports DISPATCH_HANG_TIMEOUT_MS constant", () => {
  const source = getSessionTsSource();
  assert.ok(
    source.includes("DISPATCH_HANG_TIMEOUT_MS"),
    "auto/session.ts must export DISPATCH_HANG_TIMEOUT_MS for dispatch hang detection",
  );
});

test("NEW_SESSION_TIMEOUT_MS is a reasonable value (15-120 seconds)", () => {
  const source = getSessionTsSource();
  const match = source.match(/NEW_SESSION_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
  assert.ok(match, "NEW_SESSION_TIMEOUT_MS must have a numeric value");
  const value = parseInt(match![1]!.replace(/_/g, ""), 10);
  assert.ok(value >= 15_000 && value <= 120_000,
    `NEW_SESSION_TIMEOUT_MS must be 15-120s, got ${value}ms`,
  );
});

test("DISPATCH_HANG_TIMEOUT_MS is greater than NEW_SESSION_TIMEOUT_MS", () => {
  const source = getSessionTsSource();
  const sessionMatch = source.match(/NEW_SESSION_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
  const dispatchMatch = source.match(/DISPATCH_HANG_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
  assert.ok(sessionMatch && dispatchMatch, "Both timeout constants must exist");
  const sessionTimeout = parseInt(sessionMatch![1]!.replace(/_/g, ""), 10);
  const dispatchTimeout = parseInt(dispatchMatch![1]!.replace(/_/g, ""), 10);
  assert.ok(dispatchTimeout > sessionTimeout,
    `DISPATCH_HANG_TIMEOUT_MS (${dispatchTimeout}) must be > NEW_SESSION_TIMEOUT_MS (${sessionTimeout})`,
  );
});

// ── newSession() timeout in dispatchNextUnit ─────────────────────────────────

test("dispatchNextUnit wraps newSession() with Promise.race timeout", () => {
  const source = getAutoTsSource();
  // Search the full file — dispatchNextUnit is very large
  assert.ok(
    source.includes("Promise.race") && source.includes("NEW_SESSION_TIMEOUT_MS"),
    "dispatchNextUnit must use Promise.race with NEW_SESSION_TIMEOUT_MS to timeout newSession() (#1073)",
  );
});

test("dispatchNextUnit handles newSession() timeout gracefully", () => {
  const source = getAutoTsSource();
  // Must notify user when session times out
  assert.ok(
    source.includes("Session creation timed out") || source.includes("Session creation failed"),
    "dispatchNextUnit must notify user when newSession() times out or fails (#1073)",
  );
});

// ── Dispatch hang guard in handleAgentEnd ────────────────────────────────────

test("handleAgentEnd has a dispatch hang guard before dispatchNextUnit", () => {
  const source = getAutoTsSource();
  const fnIdx = source.indexOf("export async function handleAgentEnd");
  assert.ok(fnIdx > -1, "handleAgentEnd must exist");

  // Find the section between step mode check and dispatchNextUnit call
  const fnBlock = source.slice(fnIdx, source.indexOf("\n// ─── Step Mode", fnIdx + 100));
  assert.ok(
    fnBlock.includes("DISPATCH_HANG_TIMEOUT_MS") || fnBlock.includes("dispatchHangGuard"),
    "handleAgentEnd must have a dispatch hang guard before calling dispatchNextUnit (#1073)",
  );
});

test("dispatch hang guard is cleared in finally block", () => {
  const source = getAutoTsSource();
  const fnIdx = source.indexOf("export async function handleAgentEnd");
  const fnBlock = source.slice(fnIdx, source.indexOf("\n// ─── Step Mode", fnIdx + 100));
  assert.ok(
    fnBlock.includes("clearTimeout(dispatchHangGuard)"),
    "dispatch hang guard must be cleared in finally block to prevent false alarms (#1073)",
  );
});

// ── Constants are imported in auto.ts ────────────────────────────────────────

test("auto.ts imports NEW_SESSION_TIMEOUT_MS and DISPATCH_HANG_TIMEOUT_MS", () => {
  const source = getAutoTsSource();
  assert.ok(
    source.includes("NEW_SESSION_TIMEOUT_MS"),
    "auto.ts must import NEW_SESSION_TIMEOUT_MS from session.ts",
  );
  assert.ok(
    source.includes("DISPATCH_HANG_TIMEOUT_MS"),
    "auto.ts must import DISPATCH_HANG_TIMEOUT_MS from session.ts",
  );
});
