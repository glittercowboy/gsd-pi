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
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

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

async function main(): Promise<void> {
  const cleanups: string[] = [];

  try {
    // ─── Health Score Tracking ─────────────────────────────────────────
    console.log("\n=== health tracking: initial state ===");
    {
      resetProactiveHealing();
      assertEq(getHealthTrend(), "unknown", "trend is unknown with no data");
      assertEq(getConsecutiveErrorUnits(), 0, "no consecutive errors initially");
      assertEq(getHealthHistory().length, 0, "no history initially");
    }

    console.log("\n=== health tracking: recording snapshots ===");
    {
      resetProactiveHealing();
      recordHealthSnapshot(0, 2, 1);
      recordHealthSnapshot(0, 1, 0);
      recordHealthSnapshot(0, 0, 0);

      assertEq(getHealthHistory().length, 3, "3 snapshots recorded");
      assertEq(getConsecutiveErrorUnits(), 0, "no consecutive errors after clean units");
    }

    console.log("\n=== health tracking: consecutive error counting ===");
    {
      resetProactiveHealing();
      recordHealthSnapshot(2, 1, 0); // errors
      recordHealthSnapshot(1, 0, 0); // errors
      recordHealthSnapshot(1, 0, 0); // errors
      assertEq(getConsecutiveErrorUnits(), 3, "3 consecutive error units");

      recordHealthSnapshot(0, 0, 0); // clean
      assertEq(getConsecutiveErrorUnits(), 0, "streak reset on clean unit");
    }

    console.log("\n=== health tracking: trend detection ===");
    {
      resetProactiveHealing();
      // Record 5 older snapshots with low issues
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(0, 1, 0);
      }
      // Record 5 recent snapshots with high issues
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(3, 5, 0);
      }
      assertEq(getHealthTrend(), "degrading", "detects degrading trend");
    }

    console.log("\n=== health tracking: improving trend ===");
    {
      resetProactiveHealing();
      // Record 5 older snapshots with high issues
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(3, 5, 0);
      }
      // Record 5 recent snapshots with low issues
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(0, 0, 0);
      }
      assertEq(getHealthTrend(), "improving", "detects improving trend");
    }

    console.log("\n=== health tracking: stable trend ===");
    {
      resetProactiveHealing();
      for (let i = 0; i < 10; i++) {
        recordHealthSnapshot(1, 1, 0);
      }
      assertEq(getHealthTrend(), "stable", "detects stable trend");
    }

    // ─── Auto-Heal Escalation ─────────────────────────────────────────
    console.log("\n=== escalation: below threshold ===");
    {
      resetProactiveHealing();
      recordHealthSnapshot(1, 0, 0);
      recordHealthSnapshot(1, 0, 0);
      recordHealthSnapshot(1, 0, 0);
      const result = checkHealEscalation(1, [{ code: "test", message: "test error", unitId: "M001/S01" }]);
      assertEq(result.shouldEscalate, false, "no escalation below threshold");
      assertTrue(result.reason.includes("3/5"), "reason shows progress toward threshold");
    }

    console.log("\n=== escalation: at threshold ===");
    {
      resetProactiveHealing();
      // Need 5+ consecutive error units AND degrading/stable trend
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(0, 0, 0); // older clean snapshots
      }
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(2, 1, 0); // recent error snapshots
      }
      const result = checkHealEscalation(2, [{ code: "test", message: "test error", unitId: "M001/S01" }]);
      assertEq(result.shouldEscalate, true, "escalates at threshold with degrading trend");
      assertTrue(result.reason.includes("5 consecutive"), "reason mentions consecutive count");
    }

    console.log("\n=== escalation: no double escalation ===");
    {
      // Don't reset — should already be escalated from previous test
      recordHealthSnapshot(2, 0, 0);
      const result = checkHealEscalation(2, [{ code: "test", message: "test error", unitId: "M001/S01" }]);
      assertEq(result.shouldEscalate, false, "no double escalation in same session");
      assertTrue(result.reason.includes("already escalated"), "reason explains why no escalation");
    }

    console.log("\n=== escalation: deferred when improving ===");
    {
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
      assertEq(result.shouldEscalate, false, "no escalation when trend is improving");
      assertTrue(result.reason.includes("improving"), "reason mentions improving trend");
    }

    // ─── Health Summary Formatting ────────────────────────────────────
    console.log("\n=== formatHealthSummary ===");
    {
      resetProactiveHealing();
      assertEq(formatHealthSummary(), "No health data yet.", "empty summary when no data");

      recordHealthSnapshot(2, 3, 1);
      const summary = formatHealthSummary();
      assertTrue(summary.includes("2 errors") && summary.includes("3 warnings"), "summary includes error/warning counts");
      assertTrue(summary.includes("1 fix applied"), "summary includes fix count");
      assertTrue(summary.includes("1 of 5 consecutive errors"), "summary includes error streak");
    }

    // ─── Pre-Dispatch Health Gate ─────────────────────────────────────
    console.log("\n=== health gate: clean state ===");
    {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-proactive-")));
      cleanups.push(dir);
      mkdirSync(join(dir, ".gsd"), { recursive: true });

      const result = await preDispatchHealthGate(dir);
      assertTrue(result.proceed, "gate passes on clean state");
      assertEq(result.issues.length, 0, "no issues on clean state");
    }

    console.log("\n=== health gate: missing STATE.md does NOT block dispatch (#889) ===");
    {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-proactive-")));
      cleanups.push(dir);
      // Create milestones dir but no STATE.md — mimics fresh worktree
      mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap\n");

      const result = await preDispatchHealthGate(dir);
      assertTrue(result.proceed, "gate must NOT block when STATE.md is missing (deadlock #889)");
      assertEq(result.issues.length, 0, "missing STATE.md is not a blocking issue");
      assertTrue(result.fixesApplied.some((f: string) => f.includes("STATE.md")), "reports STATE.md status as info");
    }

    console.log("\n=== health gate: stale crash lock auto-cleared ===");
    {
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
      assertTrue(result.proceed, "gate passes after auto-clearing stale lock");
      assertTrue(result.fixesApplied.some(f => f.includes("cleared stale auto.lock")), "reports lock cleared");
      assertTrue(!existsSync(join(dir, ".gsd", "auto.lock")), "lock file removed");
    }

    console.log("\n=== health gate: corrupt merge state auto-healed ===");
    if (process.platform !== "win32") {
    {
      const dir = createGitRepo();
      cleanups.push(dir);

      // Inject MERGE_HEAD
      const headHash = run("git rev-parse HEAD", dir);
      writeFileSync(join(dir, ".git", "MERGE_HEAD"), headHash + "\n");

      const result = await preDispatchHealthGate(dir);
      assertTrue(result.proceed, "gate passes after auto-healing merge state");
      assertTrue(result.fixesApplied.some(f => f.includes("cleaned merge state")), "reports merge state cleaned");
      assertTrue(!existsSync(join(dir, ".git", "MERGE_HEAD")), "MERGE_HEAD removed");
    }
    } else {
      console.log("  (skipped on Windows)");
    }

    console.log("\n=== health gate: STATE.md missing — auto-healed ===");
    {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-proactive-")));
      cleanups.push(dir);
      // Minimal .gsd structure: milestones dir exists but no STATE.md
      mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });

      const stateFile = join(dir, ".gsd", "STATE.md");
      assertTrue(!existsSync(stateFile), "STATE.md does not exist before gate");

      const result = await preDispatchHealthGate(dir);
      assertTrue(result.proceed, "gate passes after rebuilding STATE.md");
      assertTrue(
        result.fixesApplied.some(f => f.includes("rebuilt missing STATE.md")),
        "reports STATE.md rebuilt",
      );
      assertTrue(existsSync(stateFile), "STATE.md created by auto-heal");
      assertTrue(result.issues.length === 0, "no blocking issues after heal");
    }

  } finally {
    resetProactiveHealing();
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  report();
}

main();
