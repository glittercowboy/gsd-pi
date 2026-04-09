/**
 * agent-end-retry.test.ts — Regression checks for the agent_end model.
 *
 * The per-unit one-shot resolve function lives at module level in auto-loop.ts
 * (_currentResolve). handleAgentEnd is a thin compatibility wrapper around
 * resolveAgentEnd().
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_TS_PATH = join(__dirname, "..", "auto.ts");
const AUTO_RESOLVE_TS_PATH = join(__dirname, "..", "auto", "resolve.ts");
const SESSION_TS_PATH = join(__dirname, "..", "auto", "session.ts");

function getAutoTsSource(): string {
  return readFileSync(AUTO_TS_PATH, "utf-8");
}

function getAutoResolveTsSource(): string {
  return readFileSync(AUTO_RESOLVE_TS_PATH, "utf-8");
}

function getSessionTsSource(): string {
  return readFileSync(SESSION_TS_PATH, "utf-8");
}

test("auto/resolve.ts declares _currentResolve for per-unit one-shot promises", () => {
  const source = getAutoResolveTsSource();
  assert.ok(
    source.includes("_currentResolve"),
    "auto/resolve.ts must declare _currentResolve for the per-unit resolve function",
  );
  assert.ok(
    source.includes("_sessionSwitchInFlight"),
    "auto/resolve.ts must declare _sessionSwitchInFlight guard",
  );
});

test("AutoSession no longer holds promise state (moved to auto-loop.ts module scope)", () => {
  const source = getSessionTsSource();
  // Properties should NOT exist as class fields
  assert.ok(
    !source.includes("pendingResolve:"),
    "AutoSession must not declare pendingResolve (moved to auto-loop.ts)",
  );
  assert.ok(
    !source.includes("pendingAgentEndQueue:"),
    "AutoSession must not declare pendingAgentEndQueue (removed — events are dropped)",
  );
});

test("legacy pendingAgentEndRetry state is gone", () => {
  const source = getSessionTsSource();
  assert.ok(
    !source.includes("pendingAgentEndRetry"),
    "AutoSession should no longer use legacy pendingAgentEndRetry state",
  );
});

test("handleAgentEnd is a thin compatibility wrapper", () => {
  const source = getAutoTsSource();
  const fnIdx = source.indexOf("export async function handleAgentEnd");
  assert.ok(fnIdx > -1, "handleAgentEnd must exist in auto.ts");
  const fnBlock = source.slice(fnIdx, source.indexOf("\n// ─── ", fnIdx + 100));

  assert.ok(
    fnBlock.includes("resolveAgentEnd("),
    "handleAgentEnd must delegate to resolveAgentEnd",
  );
  assert.ok(
    !fnBlock.includes("pendingAgentEndRetry"),
    "handleAgentEnd must not use legacy retry state",
  );
  assert.ok(
    !fnBlock.includes("dispatchNextUnit"),
    "handleAgentEnd must not dispatch recursively",
  );
});

test("handleAgentEnd early return calls resolveAgentEndCancelled", () => {
  const source = getAutoTsSource();
  const fnIdx = source.indexOf("export async function handleAgentEnd");
  assert.ok(fnIdx > -1, "handleAgentEnd must exist in auto.ts");
  const fnBlock = source.slice(fnIdx, source.indexOf("\n// ─── ", fnIdx + 100));

  assert.ok(
    fnBlock.includes("resolveAgentEndCancelled()"),
    "handleAgentEnd must call resolveAgentEndCancelled on early return to prevent orphaned promises",
  );
});

test("pauseAuto calls resolveAgentEndCancelled to unblock the loop", () => {
  const source = getAutoTsSource();
  const fnIdx = source.indexOf("export async function pauseAuto");
  assert.ok(fnIdx > -1, "pauseAuto must exist in auto.ts");
  // Extract the function body (up to the next export or top-level function)
  const fnBlock = source.slice(fnIdx, source.indexOf("\n/**\n * Build", fnIdx + 100));

  assert.ok(
    fnBlock.includes("resolveAgentEndCancelled("),
    "pauseAuto must call resolveAgentEndCancelled to unblock the auto-loop promise",
  );
});

test("auto-timers.ts idle watchdog catch calls resolveAgentEndCancelled", () => {
  const TIMERS_PATH = join(__dirname, "..", "auto-timers.ts");
  const source = readFileSync(TIMERS_PATH, "utf-8");

  const idleCatchIdx = source.indexOf("[idle-watchdog] Unhandled error");
  assert.ok(idleCatchIdx > -1, "idle watchdog catch block must exist");
  // Check that resolveAgentEndCancelled is called near this catch
  const catchRegion = source.slice(Math.max(0, idleCatchIdx - 200), idleCatchIdx + 200);
  assert.ok(
    catchRegion.includes("resolveAgentEndCancelled("),
    "idle watchdog catch block must call resolveAgentEndCancelled",
  );
});

test("auto-timers.ts hard timeout catch calls resolveAgentEndCancelled", () => {
  const TIMERS_PATH = join(__dirname, "..", "auto-timers.ts");
  const source = readFileSync(TIMERS_PATH, "utf-8");

  const hardCatchIdx = source.indexOf("[hard-timeout] Unhandled error");
  assert.ok(hardCatchIdx > -1, "hard timeout catch block must exist");
  const catchRegion = source.slice(Math.max(0, hardCatchIdx - 200), hardCatchIdx + 200);
  assert.ok(
    catchRegion.includes("resolveAgentEndCancelled("),
    "hard timeout catch block must call resolveAgentEndCancelled",
  );
});

test("resolveAgentEndCancelled is exported from auto/resolve.ts", () => {
  const source = getAutoResolveTsSource();
  assert.ok(
    source.includes("export function resolveAgentEndCancelled"),
    "auto/resolve.ts must export resolveAgentEndCancelled",
  );
});
