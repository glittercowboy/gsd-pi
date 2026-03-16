/**
 * doctor-runtime.test.ts — Tests for doctor runtime health checks.
 *
 * Tests detection and auto-fix of:
 *   stale_crash_lock, orphaned_completed_units, stale_hook_state,
 *   activity_log_bloat, state_file_missing, state_file_stale,
 *   gitignore_missing_patterns
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { runGSDDoctor } from "../doctor.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

/** Create a minimal .gsd project with a milestone for STATE.md tests. */
function createMinimalProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-runtime-test-")));
  const msDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(msDir, { recursive: true });
  writeFileSync(join(msDir, "M001-ROADMAP.md"), `# M001: Test

## Slices
- [ ] **S01: Demo** \`risk:low\` \`depends:[]\`
  > After this: done
`);
  const sDir = join(msDir, "slices", "S01", "tasks");
  mkdirSync(sDir, { recursive: true });
  writeFileSync(join(msDir, "slices", "S01", "S01-PLAN.md"), `# S01: Demo

**Goal:** Demo

## Tasks
- [ ] **T01: Do thing** \`est:10m\`
`);
  return dir;
}

/** Create a minimal git repo with .gsd for gitignore tests. */
function createGitProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-runtime-git-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

async function main(): Promise<void> {
  const cleanups: string[] = [];

  try {
    // ─── Test 1: Stale crash lock detection & fix ─────────────────────
    console.log("\n=== stale_crash_lock ===");
    {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // Write a lock file with a PID that is definitely dead (use PID 1 million+)
      const lockData = {
        pid: 9999999,
        startedAt: "2026-03-10T00:00:00Z",
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        unitStartedAt: "2026-03-10T00:01:00Z",
        completedUnits: 3,
      };
      writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(lockData, null, 2));

      const detect = await runGSDDoctor(dir);
      const lockIssues = detect.issues.filter(i => i.code === "stale_crash_lock");
      assertTrue(lockIssues.length > 0, "detects stale crash lock");
      assertTrue(lockIssues[0]?.message.includes("9999999"), "message includes PID");
      assertTrue(lockIssues[0]?.fixable === true, "stale lock is fixable");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("cleared stale auto.lock")), "fix clears stale lock");
      assertTrue(!existsSync(join(dir, ".gsd", "auto.lock")), "auto.lock removed after fix");
    }

    // ─── Test 2: No false positive for missing lock ───────────────────
    console.log("\n=== stale_crash_lock — no false positive ===");
    {
      const dir = createMinimalProject();
      cleanups.push(dir);

      const detect = await runGSDDoctor(dir);
      const lockIssues = detect.issues.filter(i => i.code === "stale_crash_lock");
      assertEq(lockIssues.length, 0, "no stale lock issue when no lock file exists");
    }

    // ─── Test 3: Stale hook state detection & fix ─────────────────────
    console.log("\n=== stale_hook_state ===");
    {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // Write hook state with active cycle counts and no auto.lock (no running session)
      const hookState = {
        cycleCounts: {
          "code-review/execute-task/M001/S01/T01": 2,
          "lint-check/execute-task/M001/S01/T02": 1,
        },
        savedAt: "2026-03-10T00:00:00Z",
      };
      writeFileSync(join(dir, ".gsd", "hook-state.json"), JSON.stringify(hookState, null, 2));

      const detect = await runGSDDoctor(dir);
      const hookIssues = detect.issues.filter(i => i.code === "stale_hook_state");
      assertTrue(hookIssues.length > 0, "detects stale hook state");
      assertTrue(hookIssues[0]?.message.includes("2 residual cycle count"), "message includes count");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("cleared stale hook-state.json")), "fix clears hook state");

      // Verify the file was cleaned
      const content = JSON.parse(readFileSync(join(dir, ".gsd", "hook-state.json"), "utf-8"));
      assertEq(Object.keys(content.cycleCounts).length, 0, "hook state cycle counts cleared");
    }

    // ─── Test 4: Activity log bloat detection ─────────────────────────
    console.log("\n=== activity_log_bloat ===");
    {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // Create an activity dir with > 500 files
      const activityDir = join(dir, ".gsd", "activity");
      mkdirSync(activityDir, { recursive: true });
      for (let i = 0; i < 510; i++) {
        writeFileSync(join(activityDir, `${String(i).padStart(3, "0")}-execute-task-M001-S01-T01.jsonl`), `{"test":${i}}\n`);
      }

      const detect = await runGSDDoctor(dir);
      const bloatIssues = detect.issues.filter(i => i.code === "activity_log_bloat");
      assertTrue(bloatIssues.length > 0, "detects activity log bloat");
      assertTrue(bloatIssues[0]?.message.includes("510 files"), "message includes file count");
    }

    // ─── Test 5: STATE.md missing detection & fix ─────────────────────
    console.log("\n=== state_file_missing ===");
    {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // No STATE.md exists by default in our minimal setup
      const stateFilePath = join(dir, ".gsd", "STATE.md");
      assertTrue(!existsSync(stateFilePath), "STATE.md does not exist initially");

      const detect = await runGSDDoctor(dir);
      const stateIssues = detect.issues.filter(i => i.code === "state_file_missing");
      assertTrue(stateIssues.length > 0, "detects missing STATE.md");
      assertTrue(stateIssues[0]?.fixable === true, "missing STATE.md is fixable");
      assertEq(stateIssues[0]?.severity, "warning", "missing STATE.md is a warning (derived file)");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("created STATE.md")), "fix creates STATE.md");
      assertTrue(existsSync(stateFilePath), "STATE.md exists after fix");

      // Verify content has expected structure
      const content = readFileSync(stateFilePath, "utf-8");
      assertTrue(content.includes("# GSD State"), "STATE.md has header");
      assertTrue(content.includes("M001"), "STATE.md references milestone");
    }

    // ─── Test 6: STATE.md stale detection & fix ───────────────────────
    console.log("\n=== state_file_stale ===");
    {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // Write a STATE.md with wrong phase/milestone info
      const stateFilePath = join(dir, ".gsd", "STATE.md");
      writeFileSync(stateFilePath, `# GSD State

**Active Milestone:** None
**Active Slice:** None
**Phase:** idle

## Milestone Registry

## Recent Decisions
- None recorded

## Blockers
- None

## Next Action
None
`);

      const detect = await runGSDDoctor(dir);
      const staleIssues = detect.issues.filter(i => i.code === "state_file_stale");
      assertTrue(staleIssues.length > 0, "detects stale STATE.md");
      assertTrue(staleIssues[0]?.message.includes("idle"), "message references old phase");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("rebuilt STATE.md")), "fix rebuilds STATE.md");

      // Verify updated content matches derived state
      const content = readFileSync(stateFilePath, "utf-8");
      assertTrue(content.includes("M001"), "rebuilt STATE.md references milestone");
    }

    // ─── Test 7: Gitignore missing patterns detection & fix ───────────
    if (process.platform !== "win32") {
    console.log("\n=== gitignore_missing_patterns ===");
    {
      const dir = createGitProject();
      cleanups.push(dir);

      // Create .gsd dir so checks can run
      mkdirSync(join(dir, ".gsd"), { recursive: true });

      // Write a .gitignore missing GSD runtime patterns
      writeFileSync(join(dir, ".gitignore"), `node_modules/
.env
`);

      const detect = await runGSDDoctor(dir);
      const gitignoreIssues = detect.issues.filter(i => i.code === "gitignore_missing_patterns");
      assertTrue(gitignoreIssues.length > 0, "detects missing gitignore patterns");
      assertTrue(gitignoreIssues[0]?.message.includes(".gsd/activity/"), "message lists missing patterns");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("added missing GSD runtime patterns")), "fix adds patterns");

      // Verify patterns were added
      const content = readFileSync(join(dir, ".gitignore"), "utf-8");
      assertTrue(content.includes(".gsd/activity/"), "gitignore now has activity pattern");
      assertTrue(content.includes(".gsd/auto.lock"), "gitignore now has auto.lock pattern");
    }
    } else {
      console.log("\n=== gitignore_missing_patterns (skipped on Windows) ===");
    }

    // ─── Test 8: No false positive when gitignore has blanket .gsd/ ───
    if (process.platform !== "win32") {
    console.log("\n=== gitignore — blanket .gsd/ ===");
    {
      const dir = createGitProject();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gitignore"), `.gsd/
node_modules/
`);

      const detect = await runGSDDoctor(dir);
      const gitignoreIssues = detect.issues.filter(i => i.code === "gitignore_missing_patterns");
      assertEq(gitignoreIssues.length, 0, "no missing patterns when blanket .gsd/ present");
    }
    } else {
      console.log("\n=== gitignore — blanket .gsd/ (skipped on Windows) ===");
    }

    // ─── Test 9: Orphaned completed-units detection & fix ─────────────
    console.log("\n=== orphaned_completed_units ===");
    {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // Write completed-units.json with keys that reference non-existent artifacts
      const completedKeys = [
        "execute-task/M001/S01/T99",  // T99 doesn't exist
        "complete-slice/M001/S99",     // S99 doesn't exist
      ];
      writeFileSync(join(dir, ".gsd", "completed-units.json"), JSON.stringify(completedKeys));

      const detect = await runGSDDoctor(dir);
      const orphanIssues = detect.issues.filter(i => i.code === "orphaned_completed_units");
      assertTrue(orphanIssues.length > 0, "detects orphaned completed-unit keys");
      assertTrue(orphanIssues[0]?.message.includes("2 completed-unit key"), "message includes count");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assertTrue(fixed.fixesApplied.some(f => f.includes("removed") && f.includes("orphaned")), "fix removes orphaned keys");

      // Verify keys were cleaned
      const content = JSON.parse(readFileSync(join(dir, ".gsd", "completed-units.json"), "utf-8"));
      assertEq(content.length, 0, "all orphaned keys removed");
    }

  } finally {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  report();
}

main();
