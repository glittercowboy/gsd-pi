import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  inferCommitType,
  GitServiceImpl,
  RUNTIME_EXCLUSION_PATHS,
  VALID_BRANCH_NAME,
  runGit,
  readIntegrationBranch,
  writeIntegrationBranch,
  type GitPreferences,
  type CommitOptions,
  type MergeSliceResult,
  type PreMergeCheckResult,
} from "../git-service.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

async function main(): Promise<void> {
  // ─── inferCommitType ───────────────────────────────────────────────────

  console.log("\n=== inferCommitType ===");

  assertEq(
    inferCommitType("Implement user authentication"),
    "feat",
    "generic feature title → feat"
  );

  assertEq(
    inferCommitType("Add dashboard page"),
    "feat",
    "add-style title → feat"
  );

  assertEq(
    inferCommitType("Fix login redirect bug"),
    "fix",
    "title with 'fix' → fix"
  );

  assertEq(
    inferCommitType("Bug in session handling"),
    "fix",
    "title with 'bug' → fix"
  );

  assertEq(
    inferCommitType("Hotfix for production crash"),
    "fix",
    "title with 'hotfix' → fix"
  );

  assertEq(
    inferCommitType("Patch memory leak"),
    "fix",
    "title with 'patch' → fix"
  );

  assertEq(
    inferCommitType("Refactor state management"),
    "refactor",
    "title with 'refactor' → refactor"
  );

  assertEq(
    inferCommitType("Restructure project layout"),
    "refactor",
    "title with 'restructure' → refactor"
  );

  assertEq(
    inferCommitType("Reorganize module imports"),
    "refactor",
    "title with 'reorganize' → refactor"
  );

  assertEq(
    inferCommitType("Update API documentation"),
    "docs",
    "title with 'documentation' → docs"
  );

  assertEq(
    inferCommitType("Add doc for setup guide"),
    "docs",
    "title with 'doc' → docs"
  );

  assertEq(
    inferCommitType("Add unit tests for auth"),
    "test",
    "title with 'tests' → test"
  );

  assertEq(
    inferCommitType("Testing infrastructure setup"),
    "test",
    "title with 'testing' → test"
  );

  assertEq(
    inferCommitType("Chore: update dependencies"),
    "chore",
    "title with 'chore' → chore"
  );

  assertEq(
    inferCommitType("Cleanup unused imports"),
    "chore",
    "title with 'cleanup' → chore"
  );

  assertEq(
    inferCommitType("Clean up stale branches"),
    "chore",
    "title with 'clean up' → chore"
  );

  assertEq(
    inferCommitType("Archive old milestones"),
    "chore",
    "title with 'archive' → chore"
  );

  assertEq(
    inferCommitType("Remove deprecated endpoints"),
    "chore",
    "title with 'remove' → chore"
  );

  assertEq(
    inferCommitType("Delete temp files"),
    "chore",
    "title with 'delete' → chore"
  );

  // Mixed keywords — first match wins
  assertEq(
    inferCommitType("Fix and refactor the login module"),
    "fix",
    "mixed keywords → first match wins (fix before refactor)"
  );

  assertEq(
    inferCommitType("Refactor test utilities"),
    "refactor",
    "mixed keywords → first match wins (refactor before test)"
  );

  // Unknown / unrecognized title → feat
  assertEq(
    inferCommitType("Build the new pipeline"),
    "feat",
    "unrecognized title → feat"
  );

  assertEq(
    inferCommitType(""),
    "feat",
    "empty title → feat"
  );

  // Word boundary: "testify" should NOT match "test"
  assertEq(
    inferCommitType("Testify integration"),
    "feat",
    "'testify' does not match 'test' — word boundary prevents partial match"
  );

  // "documentary" should NOT match "doc" (word boundary)
  assertEq(
    inferCommitType("Documentary style UI"),
    "feat",
    "'documentary' does not match 'doc' — word boundary prevents partial match"
  );

  // "prefix" should NOT match "fix" (word boundary)
  assertEq(
    inferCommitType("Add prefix to all IDs"),
    "feat",
    "'prefix' does not match 'fix' — word boundary prevents partial match"
  );

  // ─── RUNTIME_EXCLUSION_PATHS ───────────────────────────────────────────

  console.log("\n=== RUNTIME_EXCLUSION_PATHS ===");

  assertEq(
    RUNTIME_EXCLUSION_PATHS.length,
    7,
    "exactly 7 runtime exclusion paths"
  );

  const expectedPaths = [
    ".gsd/activity/",
    ".gsd/runtime/",
    ".gsd/worktrees/",
    ".gsd/auto.lock",
    ".gsd/metrics.json",
    ".gsd/completed-units.json",
    ".gsd/STATE.md",
  ];

  assertEq(
    [...RUNTIME_EXCLUSION_PATHS],
    expectedPaths,
    "paths match expected set in order"
  );

  assert(
    RUNTIME_EXCLUSION_PATHS.includes(".gsd/activity/"),
    "includes .gsd/activity/"
  );
  assert(
    RUNTIME_EXCLUSION_PATHS.includes(".gsd/STATE.md"),
    "includes .gsd/STATE.md"
  );

  // ─── runGit ────────────────────────────────────────────────────────────

  console.log("\n=== runGit ===");

  const tempDir = mkdtempSync(join(tmpdir(), "gsd-git-service-test-"));
  run("git init -b main", tempDir);
  run("git config user.name 'Pi Test'", tempDir);
  run("git config user.email 'pi@example.com'", tempDir);

  // runGit should work on a valid repo
  const branch = runGit(tempDir, ["branch", "--show-current"]);
  assertEq(branch, "main", "runGit returns current branch");

  // runGit allowFailure returns empty string on failure
  const result = runGit(tempDir, ["log", "--oneline"], { allowFailure: true });
  assertEq(result, "", "runGit allowFailure returns empty on error (no commits yet)");

  // runGit throws on failure without allowFailure
  let threw = false;
  try {
    runGit(tempDir, ["log", "--oneline"]);
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes("git log --oneline failed"),
      "error message includes command and path"
    );
  }
  assert(threw, "runGit throws without allowFailure on error");

  // ─── Type exports compile check ────────────────────────────────────────

  console.log("\n=== Type exports ===");

  // These are compile-time checks — if we got here, the types import fine
  const _prefs: GitPreferences = { auto_push: true, remote: "origin" };
  const _opts: CommitOptions = { message: "test" };
  const _result: MergeSliceResult = { branch: "main", mergedCommitMessage: "msg", deletedBranch: false };
  assert(true, "GitPreferences type exported and usable");
  assert(true, "CommitOptions type exported and usable");
  assert(true, "MergeSliceResult type exported and usable");

  // Cleanup T01 temp dir
  rmSync(tempDir, { recursive: true, force: true });

  // ─── Helper: create file with intermediate dirs ────────────────────────

  function createFile(base: string, relativePath: string, content: string = "x"): void {
    const full = join(base, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }

  function initTempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "gsd-git-t02-"));
    run("git init -b main", dir);
    run("git config user.name 'Pi Test'", dir);
    run("git config user.email 'pi@example.com'", dir);
    // Need an initial commit so HEAD exists
    createFile(dir, ".gitkeep", "");
    run("git add -A", dir);
    run("git commit -m 'init'", dir);
    return dir;
  }

  // ─── GitServiceImpl: smart staging ─────────────────────────────────────

  console.log("\n=== GitServiceImpl: smart staging ===");

  {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Create runtime files (should be excluded from staging)
    createFile(repo, ".gsd/activity/log.jsonl", "log data");
    createFile(repo, ".gsd/runtime/state.json", '{"state":true}');
    createFile(repo, ".gsd/STATE.md", "# State");
    createFile(repo, ".gsd/auto.lock", "lock");
    createFile(repo, ".gsd/metrics.json", "{}");
    createFile(repo, ".gsd/worktrees/wt/file.txt", "wt data");

    // Create a real file (should be staged)
    createFile(repo, "src/code.ts", 'console.log("hello");');

    const result = svc.commit({ message: "test: smart staging" });

    assertEq(result, "test: smart staging", "commit returns the commit message");

    // Verify only src/code.ts is in the commit
    const showStat = run("git show --stat --format='' HEAD", repo);
    assert(showStat.includes("src/code.ts"), "src/code.ts is in the commit");
    assert(!showStat.includes(".gsd/activity"), ".gsd/activity/ excluded from commit");
    assert(!showStat.includes(".gsd/runtime"), ".gsd/runtime/ excluded from commit");
    assert(!showStat.includes("STATE.md"), ".gsd/STATE.md excluded from commit");
    assert(!showStat.includes("auto.lock"), ".gsd/auto.lock excluded from commit");
    assert(!showStat.includes("metrics.json"), ".gsd/metrics.json excluded from commit");
    assert(!showStat.includes(".gsd/worktrees"), ".gsd/worktrees/ excluded from commit");

    // Verify runtime files are still untracked
    // git status --short may collapse to "?? .gsd/" or show individual files
    // Use --untracked-files=all to force individual listing
    const statusOut = run("git status --short --untracked-files=all", repo);
    assert(statusOut.includes(".gsd/activity/"), "activity still untracked after commit");
    assert(statusOut.includes(".gsd/runtime/"), "runtime still untracked after commit");
    assert(statusOut.includes(".gsd/STATE.md"), "STATE.md still untracked after commit");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── GitServiceImpl: smart staging excludes tracked runtime files ──────

  console.log("\n=== GitServiceImpl: smart staging excludes tracked runtime files ===");

  {
    // Reproduces the real bug: .gsd/ runtime files that are already tracked
    // (in the git index) must be excluded from staging even when .gsd/ is
    // in .gitignore. The old pathspec-exclude approach failed silently in
    // this case and fell back to `git add -A`, staging everything.
    //
    // The fix has three layers:
    // 1. Auto-cleanup: git rm --cached removes tracked runtime files from index
    // 2. Stage-then-unstage: git add -A + git reset HEAD replaces pathspec excludes
    // 3. Pre-checkout discard: git checkout -- .gsd/ clears dirty runtime files

    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Simulate a repo where .gsd/ files were previously force-added
    createFile(repo, ".gsd/metrics.json", '{"version":1}');
    createFile(repo, ".gsd/completed-units.json", '["unit1"]');
    createFile(repo, ".gsd/activity/log.jsonl", '{"ts":1}');
    createFile(repo, "src/real.ts", "real code");
    // Force-add .gsd/ files to simulate historical tracking
    runGit(repo, ["add", "-f", ".gsd/metrics.json", ".gsd/completed-units.json", ".gsd/activity/log.jsonl", "src/real.ts"]);
    runGit(repo, ["commit", "-F", "-"], { input: "init with tracked runtime files" });

    // Add .gitignore with .gsd/ (matches real-world setup from ensureGitignore)
    createFile(repo, ".gitignore", ".gsd/\n");
    runGit(repo, ["add", ".gitignore"]);
    runGit(repo, ["commit", "-F", "-"], { input: "add gitignore" });

    // Verify runtime files are tracked (precondition)
    const tracked = run("git ls-files .gsd/", repo);
    assert(tracked.includes("metrics.json"), "precondition: metrics.json tracked");
    assert(tracked.includes("completed-units.json"), "precondition: completed-units.json tracked");
    assert(tracked.includes("activity/log.jsonl"), "precondition: activity log tracked");

    // Now modify both runtime and real files
    createFile(repo, ".gsd/metrics.json", '{"version":2}');
    createFile(repo, ".gsd/completed-units.json", '["unit1","unit2"]');
    createFile(repo, ".gsd/activity/log.jsonl", '{"ts":2}');
    createFile(repo, "src/real.ts", "updated code");

    // autoCommit should commit real.ts. The first call also runs auto-cleanup
    // which removes runtime files from the index via a dedicated commit.
    const msg = svc.autoCommit("execute-task", "M001/S01/T01");
    assert(msg !== null, "autoCommit produces a commit");

    const show = run("git show --stat HEAD", repo);
    assert(show.includes("src/real.ts"), "real files are committed");

    // After the commit, runtime files must no longer be in the git index.
    // They remain on disk but are untracked (protected by .gitignore).
    const trackedAfter = run("git ls-files .gsd/", repo);
    assertEq(trackedAfter, "", "no .gsd/ runtime files remain in the index");

    // Verify a second autoCommit with changed runtime files does NOT stage them
    createFile(repo, ".gsd/metrics.json", '{"version":3}');
    createFile(repo, ".gsd/completed-units.json", '["unit1","unit2","unit3"]');
    createFile(repo, "src/real.ts", "third version");

    const msg2 = svc.autoCommit("execute-task", "M001/S01/T02");
    assert(msg2 !== null, "second autoCommit produces a commit");

    const show2 = run("git show --stat HEAD", repo);
    assert(show2.includes("src/real.ts"), "real files committed in second commit");
    assert(!show2.includes("metrics"), "metrics.json not in second commit");
    assert(!show2.includes("completed-units"), "completed-units.json not in second commit");
    assert(!show2.includes("activity"), "activity not in second commit");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── GitServiceImpl: autoCommit on clean repo ──────────────────────────

  console.log("\n=== GitServiceImpl: autoCommit ===");

  {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Clean repo — autoCommit should return null
    const cleanResult = svc.autoCommit("task", "T01");
    assertEq(cleanResult, null, "autoCommit on clean repo returns null");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── GitServiceImpl: autoCommit on dirty repo ──────────────────────────

  console.log("\n=== GitServiceImpl: autoCommit on dirty repo ===");

  {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    createFile(repo, "src/new-feature.ts", "export const x = 1;");
    const msg = svc.autoCommit("task", "T01");

    assertEq(msg, "chore(T01): auto-commit after task", "autoCommit returns correct message format");

    // Verify the commit exists
    const log = run("git log --oneline -1", repo);
    assert(log.includes("chore(T01): auto-commit after task"), "commit message is in git log");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── GitServiceImpl: empty-after-staging guard ─────────────────────────

  console.log("\n=== GitServiceImpl: empty-after-staging guard ===");

  {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Create only runtime files
    createFile(repo, ".gsd/activity/x.jsonl", "data");

    const result = svc.autoCommit("task", "T02");
    assertEq(result, null, "autoCommit returns null when only runtime files are dirty");

    // Verify no new commit was created (should still be at init commit)
    const logCount = run("git rev-list --count HEAD", repo);
    assertEq(logCount, "1", "no new commit created when only runtime files changed");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── GitServiceImpl: autoCommit with extraExclusions ───────────────────

  console.log("\n=== GitServiceImpl: autoCommit with extraExclusions ===");

  {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Create both a .gsd/ planning file and a regular source file
    createFile(repo, ".gsd/milestones/M001/M001-ROADMAP.md", "- [x] S01");
    createFile(repo, "src/feature.ts", "export const y = 2;");

    // Auto-commit with .gsd/ excluded (simulates pre-switch)
    const msg = svc.autoCommit("pre-switch", "main", [".gsd/"]);
    assertEq(msg, "chore(main): auto-commit after pre-switch", "pre-switch autoCommit with .gsd/ exclusion commits");

    // Verify .gsd/ file was NOT committed
    const show = run("git show --stat HEAD", repo);
    assert(!show.includes("ROADMAP"), ".gsd/ files excluded from pre-switch auto-commit");
    assert(show.includes("feature.ts"), "non-.gsd/ files included in pre-switch auto-commit");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── GitServiceImpl: autoCommit extraExclusions — only .gsd/ dirty ────

  console.log("\n=== GitServiceImpl: autoCommit extraExclusions — only .gsd/ dirty ===");

  {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Create only .gsd/ planning files
    createFile(repo, ".gsd/milestones/M001/M001-ROADMAP.md", "- [x] S01");
    createFile(repo, ".gsd/STATE.md", "state content");

    // Auto-commit with .gsd/ excluded — nothing else to commit
    const result = svc.autoCommit("pre-switch", "main", [".gsd/"]);
    assertEq(result, null, "autoCommit returns null when only .gsd/ files are dirty and excluded");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── GitServiceImpl: commit returns null when nothing staged ───────────

  console.log("\n=== GitServiceImpl: commit empty ===");

  {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Nothing dirty, commit should return null
    const result = svc.commit({ message: "should not commit" });
    assertEq(result, null, "commit returns null when nothing to stage");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── Helper: create repo for branch tests ────────────────────────────

  function initBranchTestRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "gsd-git-t03-"));
    run("git init -b main", dir);
    run("git config user.name 'Pi Test'", dir);
    run("git config user.email 'pi@example.com'", dir);
    createFile(dir, ".gitkeep", "");
    run("git add -A", dir);
    run("git commit -m 'init'", dir);
    return dir;
  }

  // ─── getCurrentBranch / isOnSliceBranch / getActiveSliceBranch ─────────

  console.log("\n=== Branch queries ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // On main
    assertEq(svc.getCurrentBranch(), "main", "getCurrentBranch returns main on main branch");
    assertEq(svc.isOnSliceBranch(), false, "isOnSliceBranch returns false on main");
    assertEq(svc.getActiveSliceBranch(), null, "getActiveSliceBranch returns null on main");

    // Create and checkout a slice branch manually
    run("git checkout -b gsd/M001/S01", repo);
    assertEq(svc.getCurrentBranch(), "gsd/M001/S01", "getCurrentBranch returns slice branch name");
    assertEq(svc.isOnSliceBranch(), true, "isOnSliceBranch returns true on slice branch");
    assertEq(svc.getActiveSliceBranch(), "gsd/M001/S01", "getActiveSliceBranch returns branch name on slice branch");

    // Non-slice feature branch
    run("git checkout -b feature/foo", repo);
    assertEq(svc.isOnSliceBranch(), false, "isOnSliceBranch returns false on non-slice branch");
    assertEq(svc.getActiveSliceBranch(), null, "getActiveSliceBranch returns null on non-slice branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── getMainBranch ────────────────────────────────────────────────────

  console.log("\n=== getMainBranch ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Basic case: repo has "main" branch
    assertEq(svc.getMainBranch(), "main", "getMainBranch returns main when main exists");

    rmSync(repo, { recursive: true, force: true });
  }

  {
    // master-only repo
    const repo = mkdtempSync(join(tmpdir(), "gsd-git-t03-master-"));
    run("git init -b master", repo);
    run("git config user.name 'Pi Test'", repo);
    run("git config user.email 'pi@example.com'", repo);
    createFile(repo, ".gitkeep", "");
    run("git add -A", repo);
    run("git commit -m 'init'", repo);

    const svc = new GitServiceImpl(repo);
    assertEq(svc.getMainBranch(), "master", "getMainBranch returns master when only master exists");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── ensureSliceBranch: creates and checks out ────────────────────────

  console.log("\n=== ensureSliceBranch ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    const created = svc.ensureSliceBranch("M001", "S01");
    assertEq(created, true, "ensureSliceBranch returns true on first call (branch created)");
    assertEq(svc.getCurrentBranch(), "gsd/M001/S01", "ensureSliceBranch checks out the slice branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── ensureSliceBranch: idempotent ────────────────────────────────────

  console.log("\n=== ensureSliceBranch: idempotent ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    svc.ensureSliceBranch("M001", "S01");
    const secondCall = svc.ensureSliceBranch("M001", "S01");
    assertEq(secondCall, false, "ensureSliceBranch returns false when already on the branch");
    assertEq(svc.getCurrentBranch(), "gsd/M001/S01", "still on slice branch after idempotent call");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── ensureSliceBranch: from non-main working branch inherits artifacts ──

  console.log("\n=== ensureSliceBranch: from non-main inherits artifacts ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Create a feature branch with planning artifacts
    run("git checkout -b developer", repo);
    createFile(repo, ".gsd/milestones/M001/M001-ROADMAP.md", "# Roadmap");
    run("git add -A", repo);
    run("git commit -m 'add roadmap'", repo);

    // ensureSliceBranch from this non-main, non-slice branch
    const created = svc.ensureSliceBranch("M001", "S01");
    assertEq(created, true, "branch created from non-main working branch");
    assertEq(svc.getCurrentBranch(), "gsd/M001/S01", "checked out to slice branch");

    // The roadmap from developer branch should be present
    const logOutput = run("git log --oneline", repo);
    assert(logOutput.includes("add roadmap"), "slice branch inherits artifacts from working branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── ensureSliceBranch: from another slice branch falls back to main ──

  console.log("\n=== ensureSliceBranch: from slice branch falls back to main ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Create file only on main
    createFile(repo, "main-only.txt", "from main");
    run("git add -A", repo);
    run("git commit -m 'main-only file'", repo);

    // Create and check out S01
    svc.ensureSliceBranch("M001", "S01");
    // Add a file only on S01
    createFile(repo, "s01-only.txt", "from s01");
    run("git add -A", repo);
    run("git commit -m 'S01 work'", repo);

    // Now create S02 from S01 — should fall back to main
    const created = svc.ensureSliceBranch("M001", "S02");
    assertEq(created, true, "S02 branch created from S01 (fell back to main)");
    assertEq(svc.getCurrentBranch(), "gsd/M001/S02", "on S02 branch");

    // S02 should NOT have the S01-only file (it branched from main)
    const showFiles = run("git ls-files", repo);
    assert(!showFiles.includes("s01-only.txt"), "S02 does not have S01-only files (branched from main)");
    assert(showFiles.includes("main-only.txt"), "S02 has main files");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── ensureSliceBranch: auto-commits dirty files via smart staging ────

  console.log("\n=== ensureSliceBranch: auto-commits with smart staging ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Create dirty files: both real and runtime
    createFile(repo, "src/feature.ts", "export const y = 2;");
    createFile(repo, ".gsd/activity/session.jsonl", "session data");
    createFile(repo, ".gsd/STATE.md", "# Current State");
    createFile(repo, ".gsd/metrics.json", '{"tasks":1}');

    // ensureSliceBranch should auto-commit before checkout
    svc.ensureSliceBranch("M001", "S01");

    // The auto-commit on main should have src/feature.ts but NOT runtime files
    run("git checkout main", repo);
    const showStat = run("git show --stat --format='' HEAD", repo);
    assert(showStat.includes("src/feature.ts"), "auto-commit includes real files");
    assert(!showStat.includes(".gsd/activity"), "auto-commit excludes .gsd/activity/ (smart staging)");
    assert(!showStat.includes("STATE.md"), "auto-commit excludes .gsd/STATE.md (smart staging)");
    assert(!showStat.includes("metrics.json"), "auto-commit excludes .gsd/metrics.json (smart staging)");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── switchToMain ─────────────────────────────────────────────────────

  console.log("\n=== switchToMain ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Switch to a slice branch first
    svc.ensureSliceBranch("M001", "S01");
    assertEq(svc.getCurrentBranch(), "gsd/M001/S01", "on slice branch before switchToMain");

    // Create dirty files
    createFile(repo, "src/work.ts", "work in progress");
    createFile(repo, ".gsd/activity/log.jsonl", "activity log");
    createFile(repo, ".gsd/runtime/state.json", '{"running":true}');

    svc.switchToMain();
    assertEq(svc.getCurrentBranch(), "main", "switchToMain switches to main");

    // Verify the auto-commit on the slice branch used smart staging
    const sliceLog = run("git log gsd/M001/S01 --oneline -1", repo);
    assert(sliceLog.includes("pre-switch"), "auto-commit message includes pre-switch");

    // Check that the auto-commit on the slice branch excluded runtime files
    const showStat = run("git log gsd/M001/S01 -1 --format='' --stat", repo);
    assert(showStat.includes("src/work.ts"), "switchToMain auto-commit includes real files");
    assert(!showStat.includes(".gsd/activity"), "switchToMain auto-commit excludes .gsd/activity/");
    assert(!showStat.includes(".gsd/runtime"), "switchToMain auto-commit excludes .gsd/runtime/");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── switchToMain: idempotent when already on main ─────────────────────

  console.log("\n=== switchToMain: idempotent ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    assertEq(svc.getCurrentBranch(), "main", "already on main");
    svc.switchToMain(); // Should not throw
    assertEq(svc.getCurrentBranch(), "main", "still on main after idempotent switchToMain");

    // Verify no extra commits were created
    const logCount = run("git rev-list --count HEAD", repo);
    assertEq(logCount, "1", "no extra commits from idempotent switchToMain");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── mergeSliceToMain: full lifecycle with feat ─────────────────────────

  console.log("\n=== mergeSliceToMain: full lifecycle ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Create and switch to slice branch
    svc.ensureSliceBranch("M001", "S01");
    assertEq(svc.getCurrentBranch(), "gsd/M001/S01", "on slice branch for merge test");

    // Do work on the slice branch
    createFile(repo, "src/feature.ts", "export const feature = true;");
    svc.commit({ message: "add feature module" });

    // Switch to main and merge
    svc.switchToMain();
    const result = svc.mergeSliceToMain("M001", "S01", "Implement user authentication");

    assertEq(result.mergedCommitMessage, "feat(M001/S01): Implement user authentication", "merge commit message uses feat type");
    assertEq(result.deletedBranch, true, "branch was deleted");
    assertEq(result.branch, "gsd/M001/S01", "result includes branch name");

    // Verify commit is on main
    const log = run("git log --oneline -1", repo);
    assert(log.includes("feat(M001/S01): Implement user authentication"), "merge commit visible in git log");

    // Verify the file is on main
    const files = run("git ls-files", repo);
    assert(files.includes("src/feature.ts"), "merged file exists on main");

    // Verify slice branch is deleted
    const branches = run("git branch", repo);
    assert(!branches.includes("gsd/M001/S01"), "slice branch deleted after merge");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── mergeSliceToMain: fix type ───────────────────────────────────────

  console.log("\n=== mergeSliceToMain: fix type ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    svc.ensureSliceBranch("M001", "S02");
    createFile(repo, "src/bugfix.ts", "// fixed");
    svc.commit({ message: "fix the bug" });

    svc.switchToMain();
    const result = svc.mergeSliceToMain("M001", "S02", "Fix broken config");

    assert(result.mergedCommitMessage.startsWith("fix("), "merge commit starts with fix(");
    assertEq(result.mergedCommitMessage, "fix(M001/S02): Fix broken config", "fix merge commit message correct");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── mergeSliceToMain: docs type ──────────────────────────────────────

  console.log("\n=== mergeSliceToMain: docs type ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    svc.ensureSliceBranch("M001", "S03");
    createFile(repo, "docs/guide.md", "# Guide");
    svc.commit({ message: "write docs" });

    svc.switchToMain();
    const result = svc.mergeSliceToMain("M001", "S03", "Docs update");

    assert(result.mergedCommitMessage.startsWith("docs("), "merge commit starts with docs(");
    assertEq(result.mergedCommitMessage, "docs(M001/S03): Docs update", "docs merge commit message correct");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── mergeSliceToMain: refactor type ──────────────────────────────────

  console.log("\n=== mergeSliceToMain: refactor type ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    svc.ensureSliceBranch("M001", "S04");
    createFile(repo, "src/refactored.ts", "// cleaner");
    svc.commit({ message: "restructure modules" });

    svc.switchToMain();
    const result = svc.mergeSliceToMain("M001", "S04", "Refactor state management");

    assert(result.mergedCommitMessage.startsWith("refactor("), "merge commit starts with refactor(");
    assertEq(result.mergedCommitMessage, "refactor(M001/S04): Refactor state management", "refactor merge commit message correct");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── mergeSliceToMain: error — not on main ────────────────────────────

  console.log("\n=== mergeSliceToMain: error cases ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Create a slice branch with a commit
    svc.ensureSliceBranch("M001", "S01");
    createFile(repo, "src/work.ts", "work");
    svc.commit({ message: "slice work" });

    // Try to merge while still on the slice branch
    let threw = false;
    try {
      svc.mergeSliceToMain("M001", "S01", "Some feature");
    } catch (e) {
      threw = true;
      const msg = (e as Error).message;
      assert(msg.includes("must be called from the main branch"), "error mentions main branch requirement");
      assert(msg.includes("gsd/M001/S01"), "error includes current branch name");
    }
    assert(threw, "mergeSliceToMain throws when not on main");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── mergeSliceToMain: error — branch doesn't exist ───────────────────

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    let threw = false;
    try {
      svc.mergeSliceToMain("M001", "S99", "Nonexistent");
    } catch (e) {
      threw = true;
      const msg = (e as Error).message;
      assert(msg.includes("does not exist"), "error mentions branch does not exist");
      assert(msg.includes("gsd/M001/S99"), "error includes missing branch name");
    }
    assert(threw, "mergeSliceToMain throws when branch doesn't exist");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── mergeSliceToMain: error — no commits ahead ───────────────────────

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Create slice branch but don't add any commits
    svc.ensureSliceBranch("M001", "S01");
    // Switch back to main without committing anything on the slice branch
    svc.switchToMain();

    let threw = false;
    try {
      svc.mergeSliceToMain("M001", "S01", "Empty slice");
    } catch (e) {
      threw = true;
      const msg = (e as Error).message;
      assert(msg.includes("no commits ahead"), "error mentions no commits ahead");
      assert(msg.includes("gsd/M001/S01"), "error includes branch name");
    }
    assert(threw, "mergeSliceToMain throws when no commits ahead");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── mergeSliceToMain: auto-resolve .gsd/ planning artifact conflicts ──

  console.log("\n=== mergeSliceToMain: auto-resolve .gsd/ planning conflicts ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Create a .gsd/ planning artifact on main (simulates reassess-roadmap)
    createFile(repo, ".gsd/DECISIONS.md", "# Decisions\n\n- D001: Original decision\n");
    run("git add -A", repo);
    run("git commit -m 'add decisions on main'", repo);

    // Create slice branch and modify the same .gsd/ file differently
    svc.ensureSliceBranch("M001", "S01");
    createFile(repo, ".gsd/DECISIONS.md", "# Decisions\n\n- D001: Original decision\n- D002: New decision from slice\n");
    createFile(repo, "src/feature.ts", "export const x = 1;");
    run("git add -A", repo);
    run("git commit -m 'slice work with .gsd/ changes'", repo);

    // Back on main, modify the same .gsd/ file to create a conflict
    svc.switchToMain();
    createFile(repo, ".gsd/DECISIONS.md", "# Decisions\n\n- D001: Updated decision on main\n");
    run("git add -A", repo);
    run("git commit -m 'update decisions on main'", repo);

    // Merge should auto-resolve .gsd/ conflicts by taking theirs (slice branch)
    const result = svc.mergeSliceToMain("M001", "S01", "Feature with .gsd/ conflicts");
    assertEq(result.deletedBranch, true, ".gsd/ conflict auto-resolved: branch deleted");

    // Verify the merge succeeded and src file is present
    assert(existsSync(join(repo, "src/feature.ts")), ".gsd/ conflict auto-resolved: src file merged");

    rmSync(repo, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // S05: Enhanced features — merge guards, snapshots, auto-push, rich commits
  // ═══════════════════════════════════════════════════════════════════════

  // ─── createSnapshot: prefs enabled ─────────────────────────────────────

  console.log("\n=== createSnapshot: enabled ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { snapshots: true });

    // Create a slice branch with a commit
    svc.ensureSliceBranch("M001", "S01");
    createFile(repo, "src/snap.ts", "snapshot me");
    svc.commit({ message: "snapshot test commit" });

    // Create snapshot ref for this slice branch
    svc.createSnapshot("gsd/M001/S01");

    // Verify ref exists under refs/gsd/snapshots/
    const refs = run("git for-each-ref refs/gsd/snapshots/", repo);
    assert(refs.includes("refs/gsd/snapshots/gsd/M001/S01/"), "snapshot ref created under refs/gsd/snapshots/");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── createSnapshot: prefs disabled ────────────────────────────────────

  console.log("\n=== createSnapshot: disabled ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { snapshots: false });

    svc.ensureSliceBranch("M001", "S01");
    createFile(repo, "src/no-snap.ts", "no snapshot");
    svc.commit({ message: "no snapshot commit" });

    // createSnapshot should be a no-op when disabled
    svc.createSnapshot("gsd/M001/S01");

    const refs = run("git for-each-ref refs/gsd/snapshots/", repo);
    assertEq(refs, "", "no snapshot ref created when prefs.snapshots is false");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── runPreMergeCheck: pass ────────────────────────────────────────────

  console.log("\n=== runPreMergeCheck: pass ===");

  {
    const repo = initBranchTestRepo();
    // Create package.json with passing test script
    createFile(repo, "package.json", JSON.stringify({
      name: "test-pass",
      scripts: { test: "node -e 'process.exit(0)'" },
    }));
    run("git add -A", repo);
    run("git commit -m 'add package.json'", repo);

    const svc = new GitServiceImpl(repo, { pre_merge_check: true });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assertEq(result.passed, true, "runPreMergeCheck returns passed:true when tests pass");
    assert(!result.skipped, "runPreMergeCheck is not skipped when enabled");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── runPreMergeCheck: fail ────────────────────────────────────────────

  console.log("\n=== runPreMergeCheck: fail ===");

  {
    const repo = initBranchTestRepo();
    // Create package.json with failing test script
    createFile(repo, "package.json", JSON.stringify({
      name: "test-fail",
      scripts: { test: "node -e 'process.exit(1)'" },
    }));
    run("git add -A", repo);
    run("git commit -m 'add failing package.json'", repo);

    const svc = new GitServiceImpl(repo, { pre_merge_check: true });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assertEq(result.passed, false, "runPreMergeCheck returns passed:false when tests fail");
    assert(!result.skipped, "runPreMergeCheck is not skipped when enabled");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── runPreMergeCheck: disabled ────────────────────────────────────────

  console.log("\n=== runPreMergeCheck: disabled ===");

  {
    const repo = initBranchTestRepo();
    createFile(repo, "package.json", JSON.stringify({
      name: "test-disabled",
      scripts: { test: "node -e 'process.exit(1)'" },
    }));
    run("git add -A", repo);
    run("git commit -m 'add package.json'", repo);

    const svc = new GitServiceImpl(repo, { pre_merge_check: false });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assertEq(result.skipped, true, "runPreMergeCheck skipped when pre_merge_check is false");
    assertEq(result.passed, true, "runPreMergeCheck returns passed:true when skipped (no block)");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── runPreMergeCheck: custom command ──────────────────────────────────

  console.log("\n=== runPreMergeCheck: custom command ===");

  {
    const repo = initBranchTestRepo();
    // Custom command string overrides auto-detection
    const svc = new GitServiceImpl(repo, { pre_merge_check: "node -e 'process.exit(0)'" });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assertEq(result.passed, true, "runPreMergeCheck passes with custom command that exits 0");
    assert(!result.skipped, "custom command is not skipped");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── Rich commit message ──────────────────────────────────────────────

  console.log("\n=== mergeSliceToMain: rich commit message ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { pre_merge_check: false });

    svc.ensureSliceBranch("M001", "S01");

    // Make 3 distinct commits on the slice branch
    createFile(repo, "src/auth.ts", "export const auth = true;");
    svc.commit({ message: "add auth module" });

    createFile(repo, "src/login.ts", "export const login = true;");
    svc.commit({ message: "add login page" });

    createFile(repo, "src/session.ts", "export const session = true;");
    svc.commit({ message: "add session handling" });

    svc.switchToMain();
    const result = svc.mergeSliceToMain("M001", "S01", "Implement user authentication");

    // Inspect the full commit body on main
    const commitBody = run("git log -1 --format=%B", repo);

    // Rich commit should have the subject line
    assert(commitBody.includes("feat(M001/S01): Implement user authentication"),
      "rich commit has conventional subject line");

    // Rich commit body should include task list with commit subjects
    assert(commitBody.includes("add auth module"),
      "rich commit body includes first commit subject");
    assert(commitBody.includes("add login page"),
      "rich commit body includes second commit subject");
    assert(commitBody.includes("add session handling"),
      "rich commit body includes third commit subject");

    // Rich commit body should include Branch: line for forensics
    assert(commitBody.includes("Branch:"),
      "rich commit body includes Branch: line");
    assert(commitBody.includes("gsd/M001/S01"),
      "rich commit body Branch: line includes slice branch name");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── Auto-push: enabled ───────────────────────────────────────────────

  console.log("\n=== Auto-push: enabled ===");

  {
    // Create a bare remote repo
    const bareDir = mkdtempSync(join(tmpdir(), "gsd-git-bare-"));
    run("git init --bare -b main", bareDir);

    // Create local repo and add the bare as remote
    const repo = initBranchTestRepo();
    run(`git remote add origin ${bareDir}`, repo);
    run("git push -u origin main", repo);

    const svc = new GitServiceImpl(repo, { auto_push: true, pre_merge_check: false });

    svc.ensureSliceBranch("M001", "S01");
    createFile(repo, "src/pushed.ts", "export const pushed = true;");
    svc.commit({ message: "work to push" });

    svc.switchToMain();
    svc.mergeSliceToMain("M001", "S01", "Add pushed feature");

    // Verify the remote has the merge commit
    const remoteLog = run(`git --git-dir=${bareDir} log --oneline -1`, bareDir);
    assert(remoteLog.includes("Add pushed feature"),
      "auto-push: remote has the merge commit when auto_push is true");

    rmSync(repo, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  }

  // ─── Auto-push: disabled ──────────────────────────────────────────────

  console.log("\n=== Auto-push: disabled ===");

  {
    const bareDir = mkdtempSync(join(tmpdir(), "gsd-git-bare-"));
    run("git init --bare -b main", bareDir);

    const repo = initBranchTestRepo();
    run(`git remote add origin ${bareDir}`, repo);
    run("git push -u origin main", repo);

    // auto_push explicitly false (or omitted — same behavior)
    const svc = new GitServiceImpl(repo, { auto_push: false, pre_merge_check: false });

    svc.ensureSliceBranch("M001", "S01");
    createFile(repo, "src/not-pushed.ts", "export const notPushed = true;");
    svc.commit({ message: "work not pushed" });

    svc.switchToMain();
    svc.mergeSliceToMain("M001", "S01", "Add unpushed feature");

    // Remote should NOT have the new merge commit — still at the initial push
    const remoteLog = run(`git --git-dir=${bareDir} log --oneline`, bareDir);
    assert(!remoteLog.includes("Add unpushed feature"),
      "auto-push: remote does NOT have merge commit when auto_push is false");

    rmSync(repo, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  }

  // ─── Remote fetch before branching: with remote ────────────────────────

  console.log("\n=== Remote fetch: with remote ===");

  {
    const bareDir = mkdtempSync(join(tmpdir(), "gsd-git-bare-"));
    run("git init --bare -b main", bareDir);

    const repo = initBranchTestRepo();
    run(`git remote add origin ${bareDir}`, repo);
    run("git push -u origin main", repo);

    // Add a commit to the remote via a temporary clone
    const cloneDir = mkdtempSync(join(tmpdir(), "gsd-git-clone-"));
    run(`git clone ${bareDir} ${cloneDir}`, cloneDir);
    run("git config user.name 'Remote Dev'", cloneDir);
    run("git config user.email 'remote@example.com'", cloneDir);
    createFile(cloneDir, "remote-file.txt", "from remote");
    run("git add -A", cloneDir);
    run("git commit -m 'remote commit'", cloneDir);
    run("git push origin main", cloneDir);

    // ensureSliceBranch should fetch before creating the branch — no crash
    const svc = new GitServiceImpl(repo);
    let noError = true;
    try {
      svc.ensureSliceBranch("M001", "S01");
    } catch {
      noError = false;
    }
    assert(noError, "ensureSliceBranch succeeds when remote has new commits (fetch runs)");

    rmSync(repo, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  }

  // ─── Remote fetch before branching: without remote ─────────────────────

  console.log("\n=== Remote fetch: without remote ===");

  {
    const repo = initBranchTestRepo();
    // No remote configured — ensureSliceBranch should not crash
    const svc = new GitServiceImpl(repo);

    let noError = true;
    try {
      svc.ensureSliceBranch("M001", "S01");
    } catch {
      noError = false;
    }
    assert(noError, "ensureSliceBranch succeeds when no remote is configured");
    assertEq(svc.getCurrentBranch(), "gsd/M001/S01", "branch created even without remote");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── Facade prefs: mergeSliceToMain creates snapshot when prefs set ────

  console.log("\n=== Facade prefs: snapshot via merge with prefs ===");

  {
    const repo = initBranchTestRepo();
    // Simulate facade behavior: GitServiceImpl with snapshots:true should
    // create a snapshot ref during mergeSliceToMain
    const svc = new GitServiceImpl(repo, { snapshots: true, pre_merge_check: false });

    svc.ensureSliceBranch("M001", "S01");
    createFile(repo, "src/facade-test.ts", "facade");
    svc.commit({ message: "facade test commit" });

    svc.switchToMain();
    svc.mergeSliceToMain("M001", "S01", "Facade snapshot test");

    // After merge, a snapshot ref should exist (created before merge)
    const refs = run("git for-each-ref refs/gsd/snapshots/", repo);
    assert(refs.includes("refs/gsd/snapshots/"), "mergeSliceToMain creates snapshot when prefs.snapshots is true");
    assert(refs.includes("gsd/M001/S01"), "snapshot ref references the slice branch name");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── Facade prefs: no snapshot when prefs omit snapshots ───────────────

  console.log("\n=== Facade prefs: no snapshot when prefs omit snapshots ===");

  {
    const repo = initBranchTestRepo();
    // Default prefs — snapshots not enabled
    const svc = new GitServiceImpl(repo, { pre_merge_check: false });

    svc.ensureSliceBranch("M001", "S01");
    createFile(repo, "src/no-facade-snap.ts", "no facade snap");
    svc.commit({ message: "no facade snapshot" });

    svc.switchToMain();
    svc.mergeSliceToMain("M001", "S01", "No snapshot test");

    // No snapshot ref should exist
    const refs = run("git for-each-ref refs/gsd/snapshots/", repo);
    assertEq(refs, "", "no snapshot ref when snapshots pref is not set");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── VALID_BRANCH_NAME regex ──────────────────────────────────────────

  console.log("\n=== VALID_BRANCH_NAME regex ===");

  {
    // Valid branch names
    assert(VALID_BRANCH_NAME.test("main"), "VALID_BRANCH_NAME accepts 'main'");
    assert(VALID_BRANCH_NAME.test("master"), "VALID_BRANCH_NAME accepts 'master'");
    assert(VALID_BRANCH_NAME.test("develop"), "VALID_BRANCH_NAME accepts 'develop'");
    assert(VALID_BRANCH_NAME.test("feature/foo"), "VALID_BRANCH_NAME accepts 'feature/foo'");
    assert(VALID_BRANCH_NAME.test("release-1.0"), "VALID_BRANCH_NAME accepts 'release-1.0'");
    assert(VALID_BRANCH_NAME.test("my_branch"), "VALID_BRANCH_NAME accepts 'my_branch'");
    assert(VALID_BRANCH_NAME.test("v2.0.1"), "VALID_BRANCH_NAME accepts 'v2.0.1'");

    // Invalid / injection attempts
    assert(!VALID_BRANCH_NAME.test("main; rm -rf /"), "VALID_BRANCH_NAME rejects shell injection");
    assert(!VALID_BRANCH_NAME.test("main && echo pwned"), "VALID_BRANCH_NAME rejects && injection");
    assert(!VALID_BRANCH_NAME.test(""), "VALID_BRANCH_NAME rejects empty string");
    assert(!VALID_BRANCH_NAME.test("branch name"), "VALID_BRANCH_NAME rejects spaces");
    assert(!VALID_BRANCH_NAME.test("branch`cmd`"), "VALID_BRANCH_NAME rejects backticks");
    assert(!VALID_BRANCH_NAME.test("branch$(cmd)"), "VALID_BRANCH_NAME rejects $() subshell");
  }

  // ─── getMainBranch: configured main_branch preference ──────────────────

  console.log("\n=== getMainBranch: configured main_branch ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { main_branch: "trunk" });

    assertEq(svc.getMainBranch(), "trunk", "getMainBranch returns configured main_branch preference");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── getMainBranch: falls back to auto-detection when not set ──────────

  console.log("\n=== getMainBranch: fallback to auto-detection ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, {});

    assertEq(svc.getMainBranch(), "main", "getMainBranch falls back to auto-detection when main_branch not set");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── getMainBranch: ignores invalid branch names ───────────────────────

  console.log("\n=== getMainBranch: ignores invalid branch name ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { main_branch: "main; rm -rf /" });

    assertEq(svc.getMainBranch(), "main", "getMainBranch ignores invalid branch name and falls back to auto-detection");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── PreMergeCheckResult type export compile check ─────────────────────

  console.log("\n=== PreMergeCheckResult type export ===");

  {
    const _checkResult: PreMergeCheckResult = { passed: true, skipped: false };
    assert(true, "PreMergeCheckResult type exported and usable");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Integration branch — feature-branch workflow support
  // ═══════════════════════════════════════════════════════════════════════

  // ─── writeIntegrationBranch / readIntegrationBranch: round-trip ────────

  console.log("\n=== Integration branch: write and read ===");

  {
    const repo = initBranchTestRepo();

    // Initially no integration branch
    assertEq(readIntegrationBranch(repo, "M001"), null, "readIntegrationBranch returns null when no metadata");

    // Write integration branch
    writeIntegrationBranch(repo, "M001", "f-123-new-thing");
    assertEq(readIntegrationBranch(repo, "M001"), "f-123-new-thing", "readIntegrationBranch returns written branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── writeIntegrationBranch: idempotent — doesn't overwrite ───────────

  console.log("\n=== Integration branch: idempotent write ===");

  {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "f-123-first");
    writeIntegrationBranch(repo, "M001", "f-456-second"); // should NOT overwrite

    assertEq(readIntegrationBranch(repo, "M001"), "f-123-first", "second write does not overwrite existing integration branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── writeIntegrationBranch: rejects slice branches ───────────────────

  console.log("\n=== Integration branch: rejects slice branches ===");

  {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "gsd/M001/S01");
    assertEq(readIntegrationBranch(repo, "M001"), null, "slice branches are not recorded as integration branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── writeIntegrationBranch: rejects invalid branch names ─────────────

  console.log("\n=== Integration branch: rejects invalid names ===");

  {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "bad; rm -rf /");
    assertEq(readIntegrationBranch(repo, "M001"), null, "invalid branch name is not recorded");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── getMainBranch: uses integration branch when milestone set ────────

  console.log("\n=== getMainBranch: integration branch from milestone metadata ===");

  {
    const repo = initBranchTestRepo();

    // Create a feature branch
    run("git checkout -b f-123-feature", repo);
    run("git checkout main", repo);

    // Write integration branch metadata
    writeIntegrationBranch(repo, "M001", "f-123-feature");

    // Without milestone set, getMainBranch returns "main"
    const svc = new GitServiceImpl(repo);
    assertEq(svc.getMainBranch(), "main", "getMainBranch returns main when no milestone set");

    // With milestone set, getMainBranch returns the integration branch
    svc.setMilestoneId("M001");
    assertEq(svc.getMainBranch(), "f-123-feature", "getMainBranch returns integration branch when milestone set");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── getMainBranch: main_branch pref still takes priority ─────────────

  console.log("\n=== getMainBranch: main_branch pref overrides integration branch ===");

  {
    const repo = initBranchTestRepo();

    run("git checkout -b f-123-feature", repo);
    run("git checkout -b trunk", repo);
    run("git checkout main", repo);

    writeIntegrationBranch(repo, "M001", "f-123-feature");

    // Explicit preference still wins
    const svc = new GitServiceImpl(repo, { main_branch: "trunk" });
    svc.setMilestoneId("M001");
    assertEq(svc.getMainBranch(), "trunk", "main_branch preference overrides integration branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── getMainBranch: falls back when integration branch deleted ────────

  console.log("\n=== getMainBranch: fallback when integration branch deleted ===");

  {
    const repo = initBranchTestRepo();

    // Write metadata pointing to a branch that doesn't exist
    writeIntegrationBranch(repo, "M001", "deleted-branch");

    const svc = new GitServiceImpl(repo);
    svc.setMilestoneId("M001");
    assertEq(svc.getMainBranch(), "main", "getMainBranch falls back to main when integration branch no longer exists");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── End-to-end: feature branch workflow ──────────────────────────────

  console.log("\n=== End-to-end: feature branch workflow ===");

  {
    const repo = initBranchTestRepo();

    // Simulate: user creates feature branch and starts GSD
    run("git checkout -b f-123-new-thing", repo);
    createFile(repo, "setup.txt", "initial setup");
    run("git add -A", repo);
    run("git commit -m 'initial feature setup'", repo);

    // Record integration branch (this is what auto.ts does at startup)
    writeIntegrationBranch(repo, "M001", "f-123-new-thing");

    // Create GitServiceImpl with milestone set
    const svc = new GitServiceImpl(repo);
    svc.setMilestoneId("M001");

    // Verify getMainBranch returns the feature branch, not "main"
    assertEq(svc.getMainBranch(), "f-123-new-thing", "e2e: getMainBranch returns feature branch");

    // Create slice branch — should branch from f-123-new-thing (current)
    svc.ensureSliceBranch("M001", "S01");
    assertEq(svc.getCurrentBranch(), "gsd/M001/S01", "e2e: slice branch created");

    // The slice branch should have the feature branch's commit
    const log = run("git log --oneline", repo);
    assert(log.includes("initial feature setup"), "e2e: slice branch inherits feature branch content");

    // Do work on the slice branch
    createFile(repo, "src/feature.ts", "export const feature = true;");
    svc.commit({ message: "feat: add feature module" });

    // switchToMain should go to feature branch
    svc.switchToMain();
    assertEq(svc.getCurrentBranch(), "f-123-new-thing", "e2e: switchToMain goes to feature branch, not main");

    // mergeSliceToMain should merge into feature branch
    const result = svc.mergeSliceToMain("M001", "S01", "Add feature module");
    assertEq(result.mergedCommitMessage, "feat(M001/S01): Add feature module", "e2e: merge commit message correct");
    assertEq(svc.getCurrentBranch(), "f-123-new-thing", "e2e: after merge, still on feature branch");

    // The feature branch should have the merged work
    const files = run("git ls-files", repo);
    assert(files.includes("src/feature.ts"), "e2e: merged file exists on feature branch");

    // Main should NOT have the merged work
    run("git checkout main", repo);
    const mainFiles = run("git ls-files", repo);
    assert(!mainFiles.includes("src/feature.ts"), "e2e: main does NOT have merged work — it stays on the feature branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── Per-milestone isolation: different milestones, different targets ──

  console.log("\n=== Integration branch: per-milestone isolation ===");

  {
    const repo = initBranchTestRepo();

    run("git checkout -b feature-a", repo);
    run("git checkout -b feature-b", repo);
    run("git checkout main", repo);

    writeIntegrationBranch(repo, "M001", "feature-a");
    writeIntegrationBranch(repo, "M002", "feature-b");

    const svc = new GitServiceImpl(repo);

    svc.setMilestoneId("M001");
    assertEq(svc.getMainBranch(), "feature-a", "M001 integration branch is feature-a");

    svc.setMilestoneId("M002");
    assertEq(svc.getMainBranch(), "feature-b", "M002 integration branch is feature-b");

    svc.setMilestoneId(null);
    assertEq(svc.getMainBranch(), "main", "no milestone set → falls back to main");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── Backward compatibility: no metadata → existing behavior ──────────

  console.log("\n=== Integration branch: backward compat ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Set milestone but no metadata file exists
    svc.setMilestoneId("M001");
    assertEq(svc.getMainBranch(), "main", "backward compat: no metadata file → falls back to main");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── untrackRuntimeFiles: removes tracked runtime files from index ───

  console.log("\n=== untrackRuntimeFiles ===");

  {
    const { untrackRuntimeFiles } = await import("../gitignore.ts");
    const repo = mkdtempSync(join(tmpdir(), "gsd-untrack-"));
    run("git init -b main", repo);
    run("git config user.email test@test.com", repo);
    run("git config user.name Test", repo);

    // Create and track runtime files (simulates pre-.gitignore state)
    mkdirSync(join(repo, ".gsd", "activity"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "completed-units.json"), '["u1"]');
    writeFileSync(join(repo, ".gsd", "metrics.json"), '{}');
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State");
    writeFileSync(join(repo, ".gsd", "activity", "log.jsonl"), "{}");
    writeFileSync(join(repo, ".gsd", "runtime", "data.json"), "{}");
    writeFileSync(join(repo, "src.ts"), "code");
    run("git add -A", repo);
    run("git commit -m init", repo);

    // Precondition: runtime files are tracked
    const trackedBefore = run("git ls-files .gsd/", repo);
    assert(trackedBefore.includes("completed-units.json"), "untrack: precondition — completed-units tracked");
    assert(trackedBefore.includes("metrics.json"), "untrack: precondition — metrics tracked");

    // Run untrackRuntimeFiles
    untrackRuntimeFiles(repo);

    // Runtime files should be removed from the index
    const trackedAfter = run("git ls-files .gsd/", repo);
    assertEq(trackedAfter, "", "untrack: all runtime files removed from index");

    // Non-runtime files remain tracked
    const srcTracked = run("git ls-files src.ts", repo);
    assert(srcTracked.includes("src.ts"), "untrack: non-runtime files remain tracked");

    // Files still exist on disk
    assert(existsSync(join(repo, ".gsd", "completed-units.json")),
      "untrack: completed-units.json still on disk");
    assert(existsSync(join(repo, ".gsd", "metrics.json")),
      "untrack: metrics.json still on disk");

    // Idempotent — running again doesn't error
    untrackRuntimeFiles(repo);
    assert(true, "untrack: second call is idempotent (no error)");

    rmSync(repo, { recursive: true, force: true });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("All tests passed ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
