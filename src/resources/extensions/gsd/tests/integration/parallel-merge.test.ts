/**
 * parallel-merge.test.ts — Tests for parallel merge reconciliation (G5).
 *
 * Covers:
 *   - determineMergeOrder: sequential vs by-completion ordering, filtering
 *   - formatMergeResults: success, conflict, empty, mixed output formatting
 *   - mergeCompletedMilestone: clean merge with session cleanup, missing roadmap,
 *     conflict detection with structured error
 *   - mergeAllCompleted: stop-on-first-conflict, sequential execution order
 *
 * Pure-function tests need no git. Integration tests use temp repos with real
 * git operations (same pattern as auto-worktree-milestone-merge.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  determineMergeOrder,
  mergeCompletedMilestone,
  mergeAllCompleted,
  formatMergeResults,
  type MergeResult,
} from "../../parallel-merge.ts";
import type { WorkerInfo } from "../../parallel-orchestrator.ts";
import {
  writeSessionStatus,
  readSessionStatus,
} from "../../session-status-io.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  updateMilestoneStatus,
} from "../../gsd-db.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "parallel-merge-test-")));
  run("git init -b main", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  // Mirror production: .gsd/worktrees/ is gitignored so autoCommitDirtyState
  // doesn't pick up the worktrees directory as dirty state (#1127 fix).
  writeFileSync(join(dir, ".gitignore"), ".gsd/worktrees/\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  return dir;
}

function makeWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    milestoneId: "M001",
    title: "Test milestone",
    pid: process.pid,
    process: null,
    worktreePath: "/tmp/test",
    startedAt: Date.now(),
    state: "stopped",
    cost: 1.5,
    ...overrides,
  };
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

/** Set up a milestone roadmap file in .gsd/milestones/<MID>/ */
function setupRoadmap(repo: string, mid: string, title: string, slices: string[]): void {
  const dir = join(repo, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  const sliceLines = slices.map(s => `- [x] **${s}**`).join("\n");
  writeFileSync(
    join(dir, `${mid}-ROADMAP.md`),
    `# ${mid}: ${title}\n\n## Slices\n${sliceLines}\n`,
  );
}

/** Create a milestone branch with file changes, then return to main. */
function createMilestoneBranch(
  repo: string,
  mid: string,
  files: Array<{ name: string; content: string }>,
): void {
  run(`git checkout -b milestone/${mid}`, repo);
  for (const f of files) {
    const dir = join(repo, ...f.name.split("/").slice(0, -1));
    if (dir !== repo) mkdirSync(dir, { recursive: true });
    writeFileSync(join(repo, f.name), f.content);
  }
  run("git add .", repo);
  run(`git commit -m "feat(${mid}): add files"`, repo);
  run("git checkout main", repo);
}

// ═══════════════════════════════════════════════════════════════════════════════
// determineMergeOrder — Pure function tests
// ═══════════════════════════════════════════════════════════════════════════════

test("determineMergeOrder — sequential sorts by milestone ID", () => {
  const workers = [
    makeWorker({ milestoneId: "M003", startedAt: 100 }),
    makeWorker({ milestoneId: "M001", startedAt: 300 }),
    makeWorker({ milestoneId: "M002", startedAt: 200 }),
  ];
  const order = determineMergeOrder(workers, "sequential");
  assert.deepEqual(order, ["M001", "M002", "M003"]);
});

test("determineMergeOrder — by-completion sorts by startedAt (earliest first)", () => {
  const workers = [
    makeWorker({ milestoneId: "M003", startedAt: 100 }),
    makeWorker({ milestoneId: "M001", startedAt: 300 }),
    makeWorker({ milestoneId: "M002", startedAt: 200 }),
  ];
  const order = determineMergeOrder(workers, "by-completion");
  assert.deepEqual(order, ["M003", "M002", "M001"]);
});

test("determineMergeOrder — only includes stopped workers", () => {
  const workers = [
    makeWorker({ milestoneId: "M001", state: "stopped" }),
    makeWorker({ milestoneId: "M002", state: "running" }),
    makeWorker({ milestoneId: "M003", state: "stopped" }),
    makeWorker({ milestoneId: "M004", state: "error" }),
    makeWorker({ milestoneId: "M005", state: "paused" }),
  ];
  const order = determineMergeOrder(workers, "sequential");
  assert.deepEqual(order, ["M001", "M003"]);
});

test("determineMergeOrder — empty workers returns empty array", () => {
  assert.deepEqual(determineMergeOrder([], "sequential"), []);
  assert.deepEqual(determineMergeOrder([], "by-completion"), []);
});

test("determineMergeOrder — defaults to sequential when order not specified", () => {
  const workers = [
    makeWorker({ milestoneId: "M002" }),
    makeWorker({ milestoneId: "M001" }),
  ];
  const order = determineMergeOrder(workers);
  assert.deepEqual(order, ["M001", "M002"]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatMergeResults — Pure function tests
// ═══════════════════════════════════════════════════════════════════════════════

test("formatMergeResults — empty results", () => {
  const output = formatMergeResults([]);
  assert.ok(output.includes("No completed milestones"));
});

test("formatMergeResults — successful merge", () => {
  const results: MergeResult[] = [
    { milestoneId: "M001", success: true, commitMessage: "feat: Auth\n\nGSD-Milestone: M001\nBranch: milestone/M001", pushed: true },
  ];
  const output = formatMergeResults(results);
  assert.ok(output.includes("M001"));
  assert.ok(output.includes("merged successfully"));
  assert.ok(output.includes("(pushed)"));
});

test("formatMergeResults — successful merge without push", () => {
  const results: MergeResult[] = [
    { milestoneId: "M001", success: true, commitMessage: "feat: Auth\n\nGSD-Milestone: M001\nBranch: milestone/M001", pushed: false },
  ];
  const output = formatMergeResults(results);
  assert.ok(output.includes("merged successfully"));
  assert.ok(!output.includes("(pushed)"));
});

test("formatMergeResults — conflict with file list", () => {
  const results: MergeResult[] = [
    {
      milestoneId: "M002",
      success: false,
      error: "Merge conflict: 2 conflicting file(s)",
      conflictFiles: ["src/app.ts", "src/main.ts"],
    },
  ];
  const output = formatMergeResults(results);
  assert.ok(output.includes("CONFLICT"));
  assert.ok(output.includes("src/app.ts"));
  assert.ok(output.includes("src/main.ts"));
  assert.ok(output.includes("Resolve conflicts manually"));
});

test("formatMergeResults — generic failure without conflict files", () => {
  const results: MergeResult[] = [
    { milestoneId: "M003", success: false, error: "No roadmap found for M003" },
  ];
  const output = formatMergeResults(results);
  assert.ok(output.includes("M003"));
  assert.ok(output.includes("failed"));
  assert.ok(output.includes("No roadmap found"));
});

test("formatMergeResults — mixed results", () => {
  const results: MergeResult[] = [
    { milestoneId: "M001", success: true, commitMessage: "feat: OK\n\nGSD-Milestone: M001\nBranch: milestone/M001", pushed: false },
    { milestoneId: "M002", success: false, error: "conflict", conflictFiles: ["a.ts"] },
  ];
  const output = formatMergeResults(results);
  assert.ok(output.includes("M001"));
  assert.ok(output.includes("merged successfully"));
  assert.ok(output.includes("M002"));
  assert.ok(output.includes("CONFLICT"));
});

// ═══════════════════════════════════════════════════════════════════════════════
// mergeCompletedMilestone — Integration tests (real git)
// ═══════════════════════════════════════════════════════════════════════════════

test("mergeCompletedMilestone — missing roadmap returns error result", async () => {
  const base = join(tmpdir(), `parallel-merge-noroadmap-${Date.now()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  try {
    const result = await mergeCompletedMilestone(base, "M999");
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("No roadmap found") || result.error?.includes("Could not read"));
    assert.equal(result.milestoneId, "M999");
  } finally {
    cleanup(base);
  }
});

test("mergeCompletedMilestone — clean merge, session status cleaned up", async () => {
  const savedCwd = process.cwd();
  const repo = createTempRepo();

  try {
    // Create milestone branch with a new file
    createMilestoneBranch(repo, "M010", [
      { name: "auth.ts", content: "export const auth = true;\n" },
    ]);

    // Set up roadmap
    setupRoadmap(repo, "M010", "Auth System", ["S01: JWT module"]);

    // Write session status to verify cleanup
    writeSessionStatus(repo, {
      milestoneId: "M010",
      pid: process.pid,
      state: "stopped",
      currentUnit: null,
      completedUnits: 3,
      cost: 1.5,
      lastHeartbeat: Date.now(),
      startedAt: Date.now() - 60000,
      worktreePath: join(repo, ".gsd", "worktrees", "M010"),
    });

    // Verify session status exists before merge
    const statusBefore = readSessionStatus(repo, "M010");
    assert.ok(statusBefore, "session status should exist before merge");

    // Merge from project root
    process.chdir(repo);
    const result = await mergeCompletedMilestone(repo, "M010");

    assert.equal(result.success, true, `merge should succeed: ${result.error}`);
    assert.ok(result.commitMessage, "should have commit message");
    assert.equal(result.milestoneId, "M010");

    // Verify file merged to main
    assert.ok(existsSync(join(repo, "auth.ts")), "auth.ts should be on main");

    // Verify commit on main (M010 is now in the body as a GSD-Milestone trailer)
    const log = run("git log -1 --format=%B main", repo);
    assert.ok(log.includes("GSD-Milestone: M010"), "commit message should reference M010 in trailer");

    // Verify session status cleaned up
    const statusAfter = readSessionStatus(repo, "M010");
    assert.equal(statusAfter, null, "session status should be cleaned up after merge");

    // Verify milestone branch deleted
    const branches = run("git branch", repo);
    assert.ok(!branches.includes("milestone/M010"), "milestone branch should be deleted");
  } finally {
    process.chdir(savedCwd);
    cleanup(repo);
  }
});

test("mergeCompletedMilestone — conflict returns structured error with file list", async () => {
  const savedCwd = process.cwd();
  const repo = createTempRepo();

  try {
    // Create milestone branch that modifies README.md
    run("git checkout -b milestone/M020", repo);
    writeFileSync(join(repo, "README.md"), "# M020 version\n");
    run("git add .", repo);
    run('git commit -m "M020 changes README"', repo);
    run("git checkout main", repo);

    // Modify README.md on main to create conflict
    writeFileSync(join(repo, "README.md"), "# main version (diverged)\n");
    run("git add .", repo);
    run('git commit -m "main changes README"', repo);

    // Set up roadmap
    setupRoadmap(repo, "M020", "Conflict Test", ["S01: Conflict scenario"]);

    process.chdir(repo);
    const result = await mergeCompletedMilestone(repo, "M020");

    assert.equal(result.success, false, "merge should fail with conflict");
    assert.equal(result.milestoneId, "M020");
    assert.ok(result.conflictFiles, "should have conflictFiles");
    assert.ok(result.conflictFiles!.length > 0, "should have at least one conflict file");
    assert.ok(result.conflictFiles!.includes("README.md"), "README.md should be in conflicts");
    assert.ok(result.error?.includes("conflict"), "error message should mention conflict");
  } finally {
    process.chdir(savedCwd);
    // Reset git state before cleanup (repo may be in conflicted state)
    try { run("git reset --hard HEAD", repo); } catch { /* */ }
    cleanup(repo);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// mergeAllCompleted — Integration tests
// ═══════════════════════════════════════════════════════════════════════════════

test("mergeAllCompleted — merges in sequential order", async () => {
  const savedCwd = process.cwd();
  const repo = createTempRepo();

  try {
    // M001: adds auth.ts
    createMilestoneBranch(repo, "M001", [
      { name: "auth.ts", content: "export const auth = true;\n" },
    ]);
    // M002: adds dashboard.ts
    createMilestoneBranch(repo, "M002", [
      { name: "dashboard.ts", content: "export const dash = true;\n" },
    ]);

    setupRoadmap(repo, "M001", "Auth", ["S01: Auth module"]);
    setupRoadmap(repo, "M002", "Dashboard", ["S01: Dashboard module"]);

    const workers = [
      makeWorker({ milestoneId: "M002", startedAt: 100 }),
      makeWorker({ milestoneId: "M001", startedAt: 200 }),
    ];

    process.chdir(repo);
    const results = await mergeAllCompleted(repo, workers, "sequential");

    // Both should succeed
    assert.equal(results.length, 2, "should have two results");
    assert.equal(results[0]!.milestoneId, "M001", "M001 merged first (sequential)");
    assert.equal(results[0]!.success, true, "M001 should succeed");
    assert.equal(results[1]!.milestoneId, "M002", "M002 merged second");
    assert.equal(results[1]!.success, true, "M002 should succeed");

    // Both files on main
    assert.ok(existsSync(join(repo, "auth.ts")), "auth.ts on main");
    assert.ok(existsSync(join(repo, "dashboard.ts")), "dashboard.ts on main");
  } finally {
    process.chdir(savedCwd);
    cleanup(repo);
  }
});

test("mergeAllCompleted — stops on first conflict, skips later milestones", async () => {
  const savedCwd = process.cwd();
  const repo = createTempRepo();

  try {
    // M001: modifies README.md (will conflict with main)
    run("git checkout -b milestone/M001", repo);
    writeFileSync(join(repo, "README.md"), "# M001 version\n");
    run("git add .", repo);
    run('git commit -m "M001 changes README"', repo);
    run("git checkout main", repo);

    // M002: adds a new file (would NOT conflict)
    createMilestoneBranch(repo, "M002", [
      { name: "feature.ts", content: "export const feature = true;\n" },
    ]);

    // Modify README.md on main to create conflict with M001
    writeFileSync(join(repo, "README.md"), "# main diverged version\n");
    run("git add .", repo);
    run('git commit -m "main diverges README"', repo);

    setupRoadmap(repo, "M001", "Conflict milestone", ["S01: Conflict test"]);
    setupRoadmap(repo, "M002", "Clean milestone", ["S01: Clean test"]);

    const workers = [
      makeWorker({ milestoneId: "M001" }),
      makeWorker({ milestoneId: "M002" }),
    ];

    process.chdir(repo);
    const results = await mergeAllCompleted(repo, workers, "sequential");

    // Only M001 attempted (conflict stops the queue)
    assert.equal(results.length, 1, "should only have one result — stopped after conflict");
    assert.equal(results[0]!.milestoneId, "M001");
    assert.equal(results[0]!.success, false, "M001 should fail");
    assert.ok(results[0]!.conflictFiles && results[0]!.conflictFiles.length > 0, "should have conflict files");

    // M002 was NOT attempted
    assert.ok(!results.some(r => r.milestoneId === "M002"), "M002 should not be attempted");

    // feature.ts should NOT be on main (M002 never merged)
    assert.ok(!existsSync(join(repo, "feature.ts")), "feature.ts should not be on main");
  } finally {
    process.chdir(savedCwd);
    try { run("git reset --hard HEAD", repo); } catch { /* */ }
    cleanup(repo);
  }
});

test("mergeAllCompleted — by-completion order respects startedAt", async () => {
  const savedCwd = process.cwd();
  const repo = createTempRepo();

  try {
    // M001: adds auth.ts (started later)
    createMilestoneBranch(repo, "M001", [
      { name: "auth.ts", content: "export const auth = true;\n" },
    ]);
    // M002: adds feature.ts (started earlier)
    createMilestoneBranch(repo, "M002", [
      { name: "feature.ts", content: "export const feature = true;\n" },
    ]);

    setupRoadmap(repo, "M001", "Auth", ["S01: Auth module"]);
    setupRoadmap(repo, "M002", "Feature", ["S01: Feature module"]);

    const workers = [
      makeWorker({ milestoneId: "M001", startedAt: 2000 }),
      makeWorker({ milestoneId: "M002", startedAt: 1000 }),
    ];

    process.chdir(repo);
    const results = await mergeAllCompleted(repo, workers, "by-completion");

    // M002 should be merged first (earlier startedAt)
    assert.equal(results.length, 2);
    assert.equal(results[0]!.milestoneId, "M002", "M002 merged first (earlier startedAt)");
    assert.equal(results[1]!.milestoneId, "M001", "M001 merged second");
  } finally {
    process.chdir(savedCwd);
    cleanup(repo);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug #2812 — determineMergeOrder should use worktree DB as source of truth
// ═══════════════════════════════════════════════════════════════════════════════

/** Set up a worktree DB with a milestone marked complete */
function setupWorktreeDb(basePath: string, mid: string): void {
  const wtGsdDir = join(basePath, ".gsd", "worktrees", mid, ".gsd");
  mkdirSync(wtGsdDir, { recursive: true });
  const dbPath = join(wtGsdDir, "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: mid, title: `Milestone ${mid}`, status: "complete" });
  updateMilestoneStatus(mid, "complete", new Date().toISOString());
  closeDatabase();
}

test("determineMergeOrder — finds milestones completed in worktree DB even when worker state is 'error' (#2812)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "merge-db-bug-")));
  try {
    // Simulate the bug scenario: orchestrator has stale "error" state
    // but the worktree DB shows milestone is actually complete.
    setupWorktreeDb(base, "M011");

    const workers = [
      makeWorker({ milestoneId: "M010", state: "error" }),
      makeWorker({ milestoneId: "M011", state: "error" }),  // stale — actually complete in DB
      makeWorker({ milestoneId: "M012", state: "running" }),
    ];

    const order = determineMergeOrder(workers, "sequential", base);

    // M011 should be included because its worktree DB says status='complete'
    assert.ok(
      order.includes("M011"),
      `Expected M011 in merge order (worktree DB says complete), got: [${order}]`,
    );
    // M010 and M012 should NOT be included (no worktree DB with complete status)
    assert.ok(!order.includes("M010"), "M010 should not be in merge order (error, no DB)");
    assert.ok(!order.includes("M012"), "M012 should not be in merge order (running, no DB)");
  } finally {
    cleanup(base);
  }
});

test("determineMergeOrder — workers with state='stopped' still included without basePath", () => {
  // Backward compatibility: existing behavior still works when basePath is omitted
  const workers = [
    makeWorker({ milestoneId: "M001", state: "stopped" }),
    makeWorker({ milestoneId: "M002", state: "error" }),
  ];
  const order = determineMergeOrder(workers, "sequential");
  assert.deepEqual(order, ["M001"]);
});

test("determineMergeOrder — combines stopped workers and DB-complete milestones without duplicates", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "merge-dedup-")));
  try {
    // M001 is stopped in orchestrator AND complete in worktree DB
    setupWorktreeDb(base, "M001");

    const workers = [
      makeWorker({ milestoneId: "M001", state: "stopped" }),
      makeWorker({ milestoneId: "M002", state: "running" }),
    ];

    const order = determineMergeOrder(workers, "sequential", base);
    // M001 should appear exactly once
    assert.deepEqual(order, ["M001"]);
  } finally {
    cleanup(base);
  }
});

test("mergeAllCompleted — discovers DB-complete milestones when workers show error (#2812)", async () => {
  const savedCwd = process.cwd();
  const repo = createTempRepo();

  try {
    // Create milestone branch with a file
    createMilestoneBranch(repo, "M011", [
      { name: "feature.ts", content: "export const feature = true;\n" },
    ]);
    setupRoadmap(repo, "M011", "Feature System", ["S01: Feature module"]);

    // Set up worktree DB showing M011 is complete
    setupWorktreeDb(repo, "M011");

    // Orchestrator thinks M011 is in error (stale state)
    const workers = [
      makeWorker({ milestoneId: "M011", state: "error" }),
    ];

    process.chdir(repo);
    const results = await mergeAllCompleted(repo, workers, "sequential");

    // Should find and merge M011 despite orchestrator "error" state
    assert.equal(results.length, 1, "should have one result");
    assert.equal(results[0]!.milestoneId, "M011");
    assert.equal(results[0]!.success, true, `M011 merge should succeed: ${results[0]!.error}`);
  } finally {
    process.chdir(savedCwd);
    cleanup(repo);
  }
});
