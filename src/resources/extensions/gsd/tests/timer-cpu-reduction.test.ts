/**
 * Verify timer interval constants and CPU-reduction patterns.
 *
 * These tests assert that timer intervals and cache TTLs stay at their
 * optimized values. Regression to aggressive intervals (e.g. 100ms state
 * cache, 800ms pulse, 2s dashboard refresh) would reintroduce measurable
 * CPU overhead from synchronous filesystem I/O on short polling cycles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXT_DIR = join(import.meta.dirname, "..");

function readSource(file: string): string {
  return readFileSync(join(EXT_DIR, file), "utf-8");
}

// ── State cache TTL ──────────────────────────────────────────────────────────

test("state.ts: CACHE_TTL_MS must be >= 5000ms to avoid constant re-derivation", () => {
  const source = readSource("state.ts");
  const match = source.match(/const CACHE_TTL_MS\s*=\s*(\d+)/);
  assert.ok(match, "CACHE_TTL_MS constant must exist in state.ts");
  const ttl = Number(match[1]);
  assert.ok(ttl >= 5000, `CACHE_TTL_MS is ${ttl}ms — must be >= 5000ms to prevent deriveState() thrashing`);
});

// ── Dashboard overlay refresh ────────────────────────────────────────────────

test("dashboard-overlay.ts: refresh interval must be >= 10s", () => {
  const source = readSource("dashboard-overlay.ts");
  // Match the setInterval call in the constructor
  const match = source.match(/this\.refreshTimer\s*=\s*setInterval\([^,]+,\s*(\d[\d_]*)\)/);
  assert.ok(match, "refreshTimer setInterval must exist in dashboard-overlay.ts");
  const interval = Number(match[1].replace(/_/g, ""));
  assert.ok(interval >= 10000, `Dashboard refresh is ${interval}ms — must be >= 10000ms`);
});

// ── Pulse timer elimination ──────────────────────────────────────────────────

test("auto-dashboard.ts: pulse must not use a separate setInterval", () => {
  const source = readSource("auto-dashboard.ts");
  // The old pattern: setInterval(() => { pulseBright = ...; }, 800)
  assert.ok(
    !source.includes("pulseTimer = setInterval"),
    "pulseTimer setInterval must be eliminated — derive pulse from Date.now() instead",
  );
});

// ── Timer consolidation ──────────────────────────────────────────────────────

test("auto-timers.ts: idle watchdog and context-pressure share a single setInterval", () => {
  const source = readSource("auto-timers.ts");
  // After consolidation, continueHereHandle should not be assigned a setInterval
  const continueHereInterval = source.match(/s\.continueHereHandle\s*=\s*setInterval/);
  assert.ok(
    !continueHereInterval,
    "continueHereHandle must not have its own setInterval — context-pressure check should be inside the idle watchdog tick",
  );
});

// ── nativeHasChanges cache covers both paths ─────────────────────────────────

test("native-git-bridge.ts: nativeHasChanges cache must apply before native/fallback branch", () => {
  const source = readSource("native-git-bridge.ts");
  const fnIdx = source.indexOf("export function nativeHasChanges");
  assert.ok(fnIdx > -1, "nativeHasChanges function must exist");
  const fnBlock = source.slice(fnIdx, fnIdx + 600);

  // Cache check must come BEFORE the native = loadNative() call
  const cacheCheckIdx = fnBlock.indexOf("_hasChangesCachedAt");
  const loadNativeIdx = fnBlock.indexOf("loadNative()");
  assert.ok(cacheCheckIdx > -1, "cache check must exist in nativeHasChanges");
  assert.ok(loadNativeIdx > -1, "loadNative() call must exist in nativeHasChanges");
  assert.ok(
    cacheCheckIdx < loadNativeIdx,
    "cache check must come BEFORE loadNative() — both native and fallback paths must benefit from cache",
  );
});

// ── Unit runtime in-memory cache ─────────────────────────────────────────────

test("unit-runtime.ts: readUnitRuntimeRecord uses in-memory cache", () => {
  const source = readSource("unit-runtime.ts");
  assert.ok(
    source.includes("_runtimeCache"),
    "unit-runtime.ts must have an in-memory _runtimeCache Map",
  );
  // The read function should check cache before disk
  const readFn = source.slice(source.indexOf("export function readUnitRuntimeRecord"));
  assert.ok(
    readFn.includes("_runtimeCache.get("),
    "readUnitRuntimeRecord must check _runtimeCache before reading from disk",
  );
});
