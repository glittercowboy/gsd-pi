/**
 * Regression test for #2705: Web UI shows "Start auto" even while auto mode is
 * already running.
 *
 * Root cause: collectAuthoritativeAutoDashboardData spawns a subprocess that
 * imports auto.ts fresh. The module-level AutoSession state (s.active) is
 * always false in a new process, so the subprocess always reports
 * { active: false } even when auto IS running in the parent process.
 *
 * Fix: after obtaining the subprocess result, reconcile active/paused state
 * with on-disk session lock and paused-session metadata.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  collectAuthoritativeAutoDashboardData,
} from "../../web/auto-dashboard-service.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function makeTempFixture(): { projectCwd: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gsd-auto-lock-test-"));
  const projectCwd = join(root, "project");
  mkdirSync(projectCwd, { recursive: true });
  return {
    projectCwd,
    cleanup: () => {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function writeAutoModule(dir: string, payload: Record<string, unknown>): string {
  const modulePath = join(dir, "fake-auto-dashboard.mjs");
  writeFileSync(
    modulePath,
    `export function getAutoDashboardData() { return ${JSON.stringify(payload)}; }\n`,
  );
  return modulePath;
}

function writeSessionLock(projectCwd: string, data: Record<string, unknown>): void {
  const gsdDir = join(projectCwd, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "auto.lock"), JSON.stringify(data));
}

function writePausedSession(projectCwd: string, data: Record<string, unknown>): void {
  const runtimeDir = join(projectCwd, ".gsd", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "paused-session.json"), JSON.stringify(data));
}

const INACTIVE_PAYLOAD = {
  active: false,
  paused: false,
  stepMode: false,
  startTime: 0,
  elapsed: 0,
  currentUnit: null,
  completedUnits: [],
  basePath: "",
  totalCost: 0,
  totalTokens: 0,
};

// ─── Tests ──────────────────────────────────────────────────────────

test("#2705 regression: subprocess reports active=false but session lock exists with live PID → reconcile to active=true", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  const modulePath = writeAutoModule(fixture.projectCwd, INACTIVE_PAYLOAD);

  // On disk: session lock exists with current PID (simulates auto running in parent process).
  writeSessionLock(fixture.projectCwd, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
  });

  const result = await collectAuthoritativeAutoDashboardData(repoRoot, {
    env: {
      ...process.env,
      GSD_WEB_TEST_AUTO_DASHBOARD_MODULE: modulePath,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
    },
  });

  // After reconciliation, active MUST be true because the lock PID is alive.
  assert.equal(result.active, true, "active must be reconciled to true when session lock PID is alive");
  assert.equal(result.paused, false, "paused must remain false when no paused-session exists");
});

test("#2705: subprocess reports active=false and no session lock → remains inactive", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  const modulePath = writeAutoModule(fixture.projectCwd, INACTIVE_PAYLOAD);

  const result = await collectAuthoritativeAutoDashboardData(repoRoot, {
    env: {
      ...process.env,
      GSD_WEB_TEST_AUTO_DASHBOARD_MODULE: modulePath,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
    },
  });

  assert.equal(result.active, false, "active must remain false when no session lock exists");
  assert.equal(result.paused, false);
});

test("#2705: subprocess reports active=false but paused-session.json exists → reconcile to paused=true", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  const modulePath = writeAutoModule(fixture.projectCwd, INACTIVE_PAYLOAD);

  writePausedSession(fixture.projectCwd, {
    milestoneId: "M001",
    pausedAt: new Date().toISOString(),
    stepMode: false,
  });

  const result = await collectAuthoritativeAutoDashboardData(repoRoot, {
    env: {
      ...process.env,
      GSD_WEB_TEST_AUTO_DASHBOARD_MODULE: modulePath,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
    },
  });

  assert.equal(result.paused, true, "paused must be reconciled to true when paused-session.json exists");
  assert.equal(result.active, false, "active must remain false when paused (paused overrides active)");
});

test("#2705: subprocess reports active=true → no reconciliation needed", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  const activePayload = {
    active: true,
    paused: false,
    stepMode: true,
    startTime: 1000,
    elapsed: 500,
    currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 1000 },
    completedUnits: [],
    basePath: fixture.projectCwd,
    totalCost: 1.5,
    totalTokens: 1000,
  };
  const modulePath = writeAutoModule(fixture.projectCwd, activePayload);

  const result = await collectAuthoritativeAutoDashboardData(repoRoot, {
    env: {
      ...process.env,
      GSD_WEB_TEST_AUTO_DASHBOARD_MODULE: modulePath,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
    },
  });

  assert.equal(result.active, true, "active should remain true when subprocess already reports it");
});

test("#2705: session lock exists but PID is dead → remains inactive (stale lock)", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  const modulePath = writeAutoModule(fixture.projectCwd, INACTIVE_PAYLOAD);

  // Use a PID that is almost certainly dead.
  writeSessionLock(fixture.projectCwd, {
    pid: 999999999,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: new Date().toISOString(),
  });

  const result = await collectAuthoritativeAutoDashboardData(repoRoot, {
    env: {
      ...process.env,
      GSD_WEB_TEST_AUTO_DASHBOARD_MODULE: modulePath,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
    },
  });

  assert.equal(result.active, false, "active must remain false when session lock PID is dead (stale lock)");
});
