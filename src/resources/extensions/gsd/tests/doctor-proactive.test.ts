import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
/**
 * doctor-proactive.test.ts — Tests for proactive healing layer.
 *
 * Tests:
 *   - Pre-dispatch health gate (stale lock, merge state)
 *   - Health score tracking (snapshots, trends)
 *   - Auto-heal escalation (consecutive errors, threshold)
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  preDispatchHealthGate,
  recordHealthSnapshot,
  getHealthTrend,
  getConsecutiveErrorUnits,
  getHealthHistory,
  checkHealEscalation,
  resetProactiveHealing,
  formatHealthSummary,
} from "../doctor-proactive.ts";
function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createGitRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-proactive-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

function createRepoWithActiveMilestone(): string {
  const dir = createGitRepo();
  const msDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(msDir, { recursive: true });
  writeFileSync(join(msDir, "ROADMAP.md"), `---
id: M001
title: "Active Milestone"
---

# M001: Active Milestone

## Vision
Test

## Success Criteria
- Done

## Slices
- [ ] **S01: Test slice** \`risk:low\` \`depends:[]\`
  > After this: done

## Boundary Map
_None_
`);
  return dir;
}

describe('doctor-proactive', async () => {
  const cleanups: string[] = [];

  try {
    // ─── Health Score Tracking ─────────────────────────────────────────
    test('health tracking: initial state', () => {
      resetProactiveHealing();
      assert.deepStrictEqual(getHealthTrend(), "unknown", "trend is unknown with no data");
      assert.deepStrictEqual(getConsecutiveErrorUnits(), 0, "no consecutive errors initially");
      assert.deepStrictEqual(getHealthHistory().length, 0, "no history initially");
    });

    test('health tracking: recording snapshots', () => {
      resetProactiveHealing();
      recordHealthSnapshot(0, 2, 1);
      recordHealthSnapshot(0, 1, 0);
      recordHealthSnapshot(0, 0, 0);

      assert.deepStrictEqual(getHealthHistory().length, 3, "3 snapshots recorded");
      assert.deepStrictEqual(getConsecutiveErrorUnits(), 0, "no consecutive errors after clean units");
    });

    test('health tracking: consecutive error counting', () => {
      resetProactiveHealing();
      recordHealthSnapshot(2, 1, 0); // errors
      recordHealthSnapshot(1, 0, 0); // errors
      recordHealthSnapshot(1, 0, 0); // errors
      assert.deepStrictEqual(getConsecutiveErrorUnits(), 3, "3 consecutive error units");

      recordHealthSnapshot(0, 0, 0); // clean
      assert.deepStrictEqual(getConsecutiveErrorUnits(), 0, "streak reset on clean unit");
    });

    test('health tracking: trend detection', () => {
      resetProactiveHealing();
      // Record 5 older snapshots with low issues
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(0, 1, 0);
      }
      // Record 5 recent snapshots with high issues
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(3, 5, 0);
      }
      assert.deepStrictEqual(getHealthTrend(), "degrading", "detects degrading trend");
    });

    test('health tracking: improving trend', () => {
      resetProactiveHealing();
      // Record 5 older snapshots with high issues
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(3, 5, 0);
      }
      // Record 5 recent snapshots with low issues
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(0, 0, 0);
      }
      assert.deepStrictEqual(getHealthTrend(), "improving", "detects improving trend");
    });

    test('health tracking: stable trend', () => {
      resetProactiveHealing();
      for (let i = 0; i < 10; i++) {
        recordHealthSnapshot(1, 1, 0);
      }
      assert.deepStrictEqual(getHealthTrend(), "stable", "detects stable trend");
    });

    // ─── Auto-Heal Escalation ─────────────────────────────────────────
    test('escalation: below threshold', () => {
      resetProactiveHealing();
      recordHealthSnapshot(1, 0, 0);
      recordHealthSnapshot(1, 0, 0);
      recordHealthSnapshot(1, 0, 0);
      const result = checkHealEscalation(1, [{ code: "test", message: "test error", unitId: "M001/S01" }]);
      assert.deepStrictEqual(result.shouldEscalate, false, "no escalation below threshold");
      assert.ok(result.reason.includes("3/5"), "reason shows progress toward threshold");
    });

    test('escalation: at threshold', () => {
      resetProactiveHealing();
      // Need 5+ consecutive error units AND degrading/stable trend
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(0, 0, 0); // older clean snapshots
      }
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(2, 1, 0); // recent error snapshots
      }
      const result = checkHealEscalation(2, [{ code: "test", message: "test error", unitId: "M001/S01" }]);
      assert.deepStrictEqual(result.shouldEscalate, true, "escalates at threshold with degrading trend");
      assert.ok(result.reason.includes("5 consecutive"), "reason mentions consecutive count");
    });

    test('escalation: no double escalation', () => {
      // Don't reset — should already be escalated from previous test
      recordHealthSnapshot(2, 0, 0);
      const result = checkHealEscalation(2, [{ code: "test", message: "test error", unitId: "M001/S01" }]);
      assert.deepStrictEqual(result.shouldEscalate, false, "no double escalation in same session");
      assert.ok(result.reason.includes("already escalated"), "reason explains why no escalation");
    });

    test('escalation: deferred when improving', () => {
      resetProactiveHealing();
      // 5 older snapshots with high errors
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(5, 5, 0);
      }
      // 5 recent snapshots with fewer errors (still > 0)
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(1, 0, 0);
      }
      const result = checkHealEscalation(1, [{ code: "test", message: "test error", unitId: "M001/S01" }]);
      assert.deepStrictEqual(result.shouldEscalate, false, "no escalation when trend is improving");
      assert.ok(result.reason.includes("improving"), "reason mentions improving trend");
    });

    // ─── Health Summary Formatting ────────────────────────────────────
    test('formatHealthSummary', () => {
      resetProactiveHealing();
      assert.deepStrictEqual(formatHealthSummary(), "No health data yet.", "empty summary when no data");

      recordHealthSnapshot(2, 3, 1);
      const summary = formatHealthSummary();
      assert.ok(summary.includes("2 errors") && summary.includes("3 warnings"), "summary includes error/warning counts");
      assert.ok(summary.includes("1 fix applied"), "summary includes fix count");
      assert.ok(summary.includes("1 of 5 consecutive errors"), "summary includes error streak");
    });

    // ─── Pre-Dispatch Health Gate ─────────────────────────────────────
    test('health gate: clean state', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-proactive-")));
      cleanups.push(dir);
      mkdirSync(join(dir, ".gsd"), { recursive: true });

      const result = await preDispatchHealthGate(dir);
      assert.ok(result.proceed, "gate passes on clean state");
      assert.deepStrictEqual(result.issues.length, 0, "no issues on clean state");
    });

    test('health gate: missing STATE.md does NOT block dispatch (#889)', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-proactive-")));
      cleanups.push(dir);
      // Create milestones dir but no STATE.md — mimics fresh worktree
      mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap\n");

      const result = await preDispatchHealthGate(dir);
      assert.ok(result.proceed, "gate must NOT block when STATE.md is missing (deadlock #889)");
      assert.deepStrictEqual(result.issues.length, 0, "missing STATE.md is not a blocking issue");
      assert.ok(result.fixesApplied.some((f: string) => f.includes("STATE.md")), "reports STATE.md status as info");
    });

    test('health gate: stale crash lock auto-cleared', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-proactive-")));
      cleanups.push(dir);
      mkdirSync(join(dir, ".gsd"), { recursive: true });

      // Write a stale lock
      writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify({
        pid: 9999999, startedAt: "2026-03-10T00:00:00Z",
        unitType: "execute-task", unitId: "M001/S01/T01",
        unitStartedAt: "2026-03-10T00:01:00Z", completedUnits: 3,
      }));

      const result = await preDispatchHealthGate(dir);
      assert.ok(result.proceed, "gate passes after auto-clearing stale lock");
      assert.ok(result.fixesApplied.some(f => f.includes("cleared stale auto.lock")), "reports lock cleared");
      assert.ok(!existsSync(join(dir, ".gsd", "auto.lock")), "lock file removed");
    });

    test('health gate: corrupt merge state auto-healed', async () => {
    if (process.platform !== "win32") {
    {
      const dir = createGitRepo();
      cleanups.push(dir);

      // Inject MERGE_HEAD
      const headHash = run("git rev-parse HEAD", dir);
      writeFileSync(join(dir, ".git", "MERGE_HEAD"), headHash + "\n");

      const result = await preDispatchHealthGate(dir);
      assert.ok(result.proceed, "gate passes after auto-healing merge state");
      assert.ok(result.fixesApplied.some(f => f.includes("cleaned merge state")), "reports merge state cleaned");
      assert.ok(!existsSync(join(dir, ".git", "MERGE_HEAD")), "MERGE_HEAD removed");
    }
    } else {
      console.log("  (skipped on Windows)");
    }
    });

    test('health gate: STATE.md missing — auto-healed', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-proactive-")));
      cleanups.push(dir);
      // Minimal .gsd structure: milestones dir exists but no STATE.md
      mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });

      const stateFile = join(dir, ".gsd", "STATE.md");
      assert.ok(!existsSync(stateFile), "STATE.md does not exist before gate");

      const result = await preDispatchHealthGate(dir);
      assert.ok(result.proceed, "gate passes after rebuilding STATE.md");
      assert.ok(
        result.fixesApplied.some(f => f.includes("rebuilt missing STATE.md")),
        "reports STATE.md rebuilt",
      );
      assert.ok(existsSync(stateFile), "STATE.md created by auto-heal");
      assert.ok(result.issues.length === 0, "no blocking issues after heal");
    });

    test('health gate: stale integration branch uses detected fallback', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      const metaPath = join(dir, ".gsd", "milestones", "M001", "M001-META.json");
      writeFileSync(metaPath, JSON.stringify({ integrationBranch: "feature/missing" }, null, 2));

      const result = await preDispatchHealthGate(dir);
      assert.ok(result.proceed, "gate does not block when stale integration branch has detected fallback");
      assert.deepStrictEqual(result.issues.length, 0, "stale integration branch with fallback is not a blocking issue");
      assert.ok(
        result.fixesApplied.some(f => f.includes('feature/missing') && f.includes('main')),
        "fixesApplied reports stale recorded branch and detected fallback branch",
      );
    });

    test('health gate: stale integration branch uses configured fallback', async () => {
      const dir = createRepoWithActiveMilestone();
      cleanups.push(dir);

      run("git branch trunk", dir);
      writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), `---\ngit:\n  main_branch: "trunk"\n---\n`);
      const metaPath = join(dir, ".gsd", "milestones", "M001", "M001-META.json");
      writeFileSync(metaPath, JSON.stringify({ integrationBranch: "feature/missing" }, null, 2));

      const previousCwd = process.cwd();
      process.chdir(dir);
      try {
        const result = await preDispatchHealthGate(dir);
        assert.ok(result.proceed, "gate does not block when configured main_branch can be used as fallback");
        assert.deepStrictEqual(result.issues.length, 0, "configured fallback is not treated as a blocking issue");
        assert.ok(
          result.fixesApplied.some(f => f.includes('feature/missing') && f.includes('trunk')),
          "fixesApplied reports stale recorded branch and configured fallback branch",
        );
      } finally {
        process.chdir(previousCwd);
      }
    });

  } finally {
    resetProactiveHealing();
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});
