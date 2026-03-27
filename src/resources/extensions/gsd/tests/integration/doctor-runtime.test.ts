import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
/**
 * doctor-runtime.test.ts — Tests for doctor runtime health checks.
 *
 * Tests detection and auto-fix of:
 *   stale_crash_lock, stranded_lock_directory, orphaned_completed_units,
 *   stale_hook_state, activity_log_bloat, state_file_missing,
 *   state_file_stale, gitignore_missing_patterns
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { runGSDDoctor } from "../../doctor.ts";
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

describe('doctor-runtime', async () => {
  const cleanups: string[] = [];

  try {
    // ─── Test 1: Stale crash lock detection & fix ─────────────────────
    test('stale_crash_lock', async () => {
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
      assert.ok(lockIssues.length > 0, "detects stale crash lock");
      assert.ok(lockIssues[0]?.message.includes("9999999"), "message includes PID");
      assert.ok(lockIssues[0]?.fixable === true, "stale lock is fixable");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("cleared stale auto.lock")), "fix clears stale lock");
      assert.ok(!existsSync(join(dir, ".gsd", "auto.lock")), "auto.lock removed after fix");
    });

    // ─── Test 2: No false positive for missing lock ───────────────────
    test('stale_crash_lock — no false positive', async () => {
      const dir = createMinimalProject();
      cleanups.push(dir);

      const detect = await runGSDDoctor(dir);
      const lockIssues = detect.issues.filter(i => i.code === "stale_crash_lock");
      assert.deepStrictEqual(lockIssues.length, 0, "no stale lock issue when no lock file exists");
    });

    // ─── Test 3: Stale hook state detection & fix ─────────────────────
    test('stale_hook_state', async () => {
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
      assert.ok(hookIssues.length > 0, "detects stale hook state");
      assert.ok(hookIssues[0]?.message.includes("2 residual cycle count"), "message includes count");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("cleared stale hook-state.json")), "fix clears hook state");

      // Verify the file was cleaned
      const content = JSON.parse(readFileSync(join(dir, ".gsd", "hook-state.json"), "utf-8"));
      assert.deepStrictEqual(Object.keys(content.cycleCounts).length, 0, "hook state cycle counts cleared");
    });

    // ─── Test 4: Activity log bloat detection ─────────────────────────
    test('activity_log_bloat', async () => {
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
      assert.ok(bloatIssues.length > 0, "detects activity log bloat");
      assert.ok(bloatIssues[0]?.message.includes("510 files"), "message includes file count");
    });

    // ─── Test 5: STATE.md missing detection & fix ─────────────────────
    test('state_file_missing', async () => {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // No STATE.md exists by default in our minimal setup
      const stateFilePath = join(dir, ".gsd", "STATE.md");
      assert.ok(!existsSync(stateFilePath), "STATE.md does not exist initially");

      const detect = await runGSDDoctor(dir);
      const stateIssues = detect.issues.filter(i => i.code === "state_file_missing");
      assert.ok(stateIssues.length > 0, "detects missing STATE.md");
      assert.ok(stateIssues[0]?.fixable === true, "missing STATE.md is fixable");
      assert.deepStrictEqual(stateIssues[0]?.severity, "warning", "missing STATE.md is a warning (derived file)");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("created STATE.md")), "fix creates STATE.md");
      assert.ok(existsSync(stateFilePath), "STATE.md exists after fix");

      // Verify content has expected structure
      const content = readFileSync(stateFilePath, "utf-8");
      assert.ok(content.includes("# GSD State"), "STATE.md has header");
      assert.ok(content.includes("M001"), "STATE.md references milestone");
    });

    // ─── Test 6: STATE.md stale detection & fix ───────────────────────
    test('state_file_stale', async () => {
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
      assert.ok(staleIssues.length > 0, "detects stale STATE.md");
      assert.ok(staleIssues[0]?.message.includes("idle"), "message references old phase");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("rebuilt STATE.md")), "fix rebuilds STATE.md");

      // Verify updated content matches derived state
      const content = readFileSync(stateFilePath, "utf-8");
      assert.ok(content.includes("M001"), "rebuilt STATE.md references milestone");
    });

    // ─── Test 7: Gitignore missing patterns detection & fix ───────────
    if (process.platform !== "win32") {
    test('gitignore_missing_patterns', async () => {
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
      assert.ok(gitignoreIssues.length > 0, "detects missing gitignore patterns");
      assert.ok(gitignoreIssues[0]?.message.includes(".gsd"), "message lists missing .gsd pattern");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("added missing GSD runtime patterns")), "fix adds patterns");

      // Verify .gsd entry was added (external state symlink)
      const content = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.ok(content.includes(".gsd"), "gitignore now has .gsd entry");
    });
    } else {
    }

    // ─── Test 8: No false positive when gitignore has blanket .gsd/ ───
    if (process.platform !== "win32") {
    test('gitignore — blanket .gsd/', async () => {
      const dir = createGitProject();
      cleanups.push(dir);

      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gitignore"), `.gsd/
node_modules/
`);

      const detect = await runGSDDoctor(dir);
      const gitignoreIssues = detect.issues.filter(i => i.code === "gitignore_missing_patterns");
      assert.deepStrictEqual(gitignoreIssues.length, 0, "no missing patterns when blanket .gsd/ present");
    });
    } else {
    }

    // ─── Test 9: Orphaned completed-units detection & fix ─────────────
    test('orphaned_completed_units', async () => {
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
      assert.ok(orphanIssues.length > 0, "detects orphaned completed-unit keys");
      assert.ok(orphanIssues[0]?.message.includes("2 completed-unit key"), "message includes count");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(fixed.fixesApplied.some(f => f.includes("removed") && f.includes("orphaned")), "fix removes orphaned keys");

      // Verify keys were cleaned
      const content = JSON.parse(readFileSync(join(dir, ".gsd", "completed-units.json"), "utf-8"));
      assert.deepStrictEqual(content.length, 0, "all orphaned keys removed");
    });

    // ─── Test: Stranded lock directory detection & fix ────────────────
    // Skip on Windows: proper-lockfile uses advisory file locking on Windows,
    // not the directory-based mechanism. The .gsd.lock/ directory pattern is
    // a POSIX-specific lockfile implementation detail.
    if (process.platform !== "win32") {
    test('stranded_lock_directory', async () => {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // Create the proper-lockfile lock directory without a live lock holder.
      // The lock dir sits at <parent of .gsd>/.gsd.lock (i.e., <basePath>/.gsd.lock).
      const lockDir = join(dir, ".gsd.lock");
      mkdirSync(lockDir, { recursive: true });

      const detect = await runGSDDoctor(dir);
      const strandedIssues = detect.issues.filter(i => i.code === "stranded_lock_directory");
      assert.ok(strandedIssues.length > 0, "detects stranded lock directory");
      assert.ok(strandedIssues[0]?.message.includes("lock directory"), "message describes stranded lock directory");
      assert.ok(strandedIssues[0]?.fixable === true, "stranded lock dir is fixable");

      const fixed = await runGSDDoctor(dir, { fix: true });
      assert.ok(
        fixed.fixesApplied.some(f => f.includes("removed stranded lock directory")),
        "fix removes stranded lock directory",
      );
      assert.ok(!existsSync(lockDir), "lock directory removed after fix");
    });

    // ─── Test: Stranded lock dir with live lock holder — NOT flagged ───
    test('stranded_lock_directory (live holder not flagged)', async () => {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // Create lock dir + auto.lock with PID 1 (init/launchd — always alive, never our own PID)
      const lockDir = join(dir, ".gsd.lock");
      mkdirSync(lockDir, { recursive: true });
      const liveLockData = {
        pid: 1,
        startedAt: new Date().toISOString(),
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        unitStartedAt: new Date().toISOString(),
        completedUnits: 1,
      };
      writeFileSync(join(dir, ".gsd", "auto.lock"), JSON.stringify(liveLockData, null, 2));

      const detect = await runGSDDoctor(dir);
      const strandedIssues = detect.issues.filter(i => i.code === "stranded_lock_directory");
      assert.deepStrictEqual(strandedIssues.length, 0, "live lock holder: stranded_lock_directory NOT detected");
    });
    } else {
    }

    // ─── Test: orphaned_completed_units NOT auto-fixed at fixLevel="task" (#1809) ──
    // Regression: task-level doctor was removing completed-unit keys whose artifacts
    // were temporarily missing, causing deriveState to revert the user to S01 and
    // effectively discarding hours of work.
    test('orphaned_completed_units protected at fixLevel=task (#1809)', async () => {
      const dir = createMinimalProject();
      cleanups.push(dir);

      // Write completed-units.json with keys that reference non-existent artifacts.
      // At fixLevel="task" (auto-mode post-unit), these must NOT be removed.
      const completedKeys = [
        "execute-task/M001/S01/T99",  // artifact missing
        "complete-slice/M001/S99",     // artifact missing
      ];
      writeFileSync(join(dir, ".gsd", "completed-units.json"), JSON.stringify(completedKeys));

      // fixLevel="task" — the level used by auto-post-unit after every task
      const taskLevelFix = await runGSDDoctor(dir, { fix: true, fixLevel: "task" });
      const taskLevelOrphan = taskLevelFix.issues.filter(i => i.code === "orphaned_completed_units");
      assert.ok(taskLevelOrphan.length > 0, "orphaned_completed_units detected at task fixLevel");

      // Verify keys were NOT removed — the fix must be suppressed at task level
      const afterTaskFix = JSON.parse(readFileSync(join(dir, ".gsd", "completed-units.json"), "utf-8"));
      assert.deepStrictEqual(afterTaskFix.length, 2, "completed-unit keys preserved at fixLevel=task (data loss prevention)");
      assert.ok(
        !taskLevelFix.fixesApplied.some(f => f.includes("orphaned")),
        "no orphaned-units fix applied at fixLevel=task",
      );

      // fixLevel="all" (explicit manual doctor) — fix SHOULD apply
      const allLevelFix = await runGSDDoctor(dir, { fix: true, fixLevel: "all" });
      assert.ok(
        allLevelFix.fixesApplied.some(f => f.includes("orphaned")),
        "orphaned-units fix applied at fixLevel=all (manual doctor)",
      );
      const afterAllFix = JSON.parse(readFileSync(join(dir, ".gsd", "completed-units.json"), "utf-8"));
      assert.deepStrictEqual(afterAllFix.length, 0, "orphaned keys removed at fixLevel=all");
    });

  } finally {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});
