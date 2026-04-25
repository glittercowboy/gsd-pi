import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  inferCommitType,
  buildTaskCommitMessage,
  GitServiceImpl,
  MergeConflictError,
  RUNTIME_EXCLUSION_PATHS,
  VALID_BRANCH_NAME,
  runGit,
  readIntegrationBranch,
  resolveMilestoneIntegrationBranch,
  writeIntegrationBranch,
  type GitPreferences,
  type CommitOptions,
  type PreMergeCheckResult,
  type TaskCommitContext,
} from "../../git-service.ts";
import { nativeAddAllWithExclusions } from "../../native-git-bridge.ts";
function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

describe('git-service', async () => {
  // ─── inferCommitType ───────────────────────────────────────────────────


  assert.deepStrictEqual(
    inferCommitType("Implement user authentication"),
    "feat",
    "generic feature title → feat"
  );

  assert.deepStrictEqual(
    inferCommitType("Add dashboard page"),
    "feat",
    "add-style title → feat"
  );

  assert.deepStrictEqual(
    inferCommitType("Fix login redirect bug"),
    "fix",
    "title with 'fix' → fix"
  );

  assert.deepStrictEqual(
    inferCommitType("Bug in session handling"),
    "fix",
    "title with 'bug' → fix"
  );

  assert.deepStrictEqual(
    inferCommitType("Hotfix for production crash"),
    "fix",
    "title with 'hotfix' → fix"
  );

  assert.deepStrictEqual(
    inferCommitType("Patch memory leak"),
    "fix",
    "title with 'patch' → fix"
  );

  assert.deepStrictEqual(
    inferCommitType("Refactor state management"),
    "refactor",
    "title with 'refactor' → refactor"
  );

  assert.deepStrictEqual(
    inferCommitType("Restructure project layout"),
    "refactor",
    "title with 'restructure' → refactor"
  );

  assert.deepStrictEqual(
    inferCommitType("Reorganize module imports"),
    "refactor",
    "title with 'reorganize' → refactor"
  );

  assert.deepStrictEqual(
    inferCommitType("Update API documentation"),
    "docs",
    "title with 'documentation' → docs"
  );

  assert.deepStrictEqual(
    inferCommitType("Add doc for setup guide"),
    "docs",
    "title with 'doc' → docs"
  );

  assert.deepStrictEqual(
    inferCommitType("Add unit tests for auth"),
    "test",
    "title with 'tests' → test"
  );

  assert.deepStrictEqual(
    inferCommitType("Testing infrastructure setup"),
    "test",
    "title with 'testing' → test"
  );

  assert.deepStrictEqual(
    inferCommitType("Chore: update dependencies"),
    "chore",
    "title with 'chore' → chore"
  );

  assert.deepStrictEqual(
    inferCommitType("Cleanup unused imports"),
    "chore",
    "title with 'cleanup' → chore"
  );

  assert.deepStrictEqual(
    inferCommitType("Clean up stale branches"),
    "chore",
    "title with 'clean up' → chore"
  );

  assert.deepStrictEqual(
    inferCommitType("Archive old milestones"),
    "chore",
    "title with 'archive' → chore"
  );

  assert.deepStrictEqual(
    inferCommitType("Remove deprecated endpoints"),
    "chore",
    "title with 'remove' → chore"
  );

  assert.deepStrictEqual(
    inferCommitType("Delete temp files"),
    "chore",
    "title with 'delete' → chore"
  );

  // Mixed keywords — first match wins
  assert.deepStrictEqual(
    inferCommitType("Fix and refactor the login module"),
    "fix",
    "mixed keywords → first match wins (fix before refactor)"
  );

  assert.deepStrictEqual(
    inferCommitType("Refactor test utilities"),
    "refactor",
    "mixed keywords → first match wins (refactor before test)"
  );

  // Unknown / unrecognized title → feat
  assert.deepStrictEqual(
    inferCommitType("Build the new pipeline"),
    "feat",
    "unrecognized title → feat"
  );

  assert.deepStrictEqual(
    inferCommitType(""),
    "feat",
    "empty title → feat"
  );

  // Word boundary: "testify" should NOT match "test"
  assert.deepStrictEqual(
    inferCommitType("Testify integration"),
    "feat",
    "'testify' does not match 'test' — word boundary prevents partial match"
  );

  // "documentary" should NOT match "doc" (word boundary)
  assert.deepStrictEqual(
    inferCommitType("Documentary style UI"),
    "feat",
    "'documentary' does not match 'doc' — word boundary prevents partial match"
  );

  // "prefix" should NOT match "fix" (word boundary)
  assert.deepStrictEqual(
    inferCommitType("Add prefix to all IDs"),
    "feat",
    "'prefix' does not match 'fix' — word boundary prevents partial match"
  );

  // ─── inferCommitType with oneLiner ──────────────────────────────────────


  assert.deepStrictEqual(
    inferCommitType("implement dashboard", "Fixed rendering bug in sidebar"),
    "fix",
    "one-liner with 'fixed' overrides generic title → fix"
  );

  assert.deepStrictEqual(
    inferCommitType("add search", "Optimized query performance with caching"),
    "perf",
    "one-liner with 'performance' and 'caching' → perf"
  );

  // ─── buildTaskCommitMessage ─────────────────────────────────────────────

  test('buildTaskCommitMessage', () => {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T02",
      taskTitle: "implement user authentication",
      oneLiner: "Added JWT-based auth with refresh token rotation",
      keyFiles: ["src/auth.ts", "src/middleware/jwt.ts"],
    });
    assert.ok(msg.startsWith("feat:"), "message starts with type: (no scope)");
    assert.ok(!msg.includes("(S01/T02)"), "no GSD ID in subject line");
    assert.ok(msg.includes("JWT-based auth"), "message includes one-liner content");
    assert.ok(msg.includes("- src/auth.ts"), "message body includes key files");
    assert.ok(msg.includes("- src/middleware/jwt.ts"), "message body includes second key file");
    assert.ok(msg.includes("GSD-Task: S01/T02"), "GSD-Task trailer in body");
  });

  {
    const msg = buildTaskCommitMessage({
      taskId: "S02/T01",
      taskTitle: "fix login redirect bug",
    });
    assert.ok(msg.startsWith("fix:"), "infers fix type from title");
    assert.ok(msg.includes("fix login redirect bug"), "uses task title when no one-liner");
    assert.ok(msg.includes("GSD-Task: S02/T01"), "GSD-Task trailer present");
  }

  {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T03",
      taskTitle: "add tests",
      oneLiner: "Unit tests for auth module with coverage",
    });
    assert.ok(msg.startsWith("test:"), "infers test type");
    assert.ok(msg.includes("GSD-Task: S01/T03"), "GSD-Task trailer present");
  }

  // ─── RUNTIME_EXCLUSION_PATHS ───────────────────────────────────────────


  assert.deepStrictEqual(
    RUNTIME_EXCLUSION_PATHS.length,
    16,
    "exactly 16 runtime exclusion paths"
  );

  const expectedPaths = [
    ".gsd/activity/",
    ".gsd/audit/",
    ".gsd/forensics/",
    ".gsd/runtime/",
    ".gsd/worktrees/",
    ".gsd/parallel/",
    ".gsd/auto.lock",
    ".gsd/metrics.json",
    ".gsd/completed-units*.json",
    ".gsd/state-manifest.json",
    ".gsd/STATE.md",
    ".gsd/gsd.db*",
    ".gsd/journal/",
    ".gsd/doctor-history.jsonl",
    ".gsd/event-log.jsonl",
    ".gsd/DISCUSSION-MANIFEST.json",
  ];

  assert.deepStrictEqual(
    [...RUNTIME_EXCLUSION_PATHS],
    expectedPaths,
    "paths match expected set in order"
  );

  assert.ok(
    RUNTIME_EXCLUSION_PATHS.includes(".gsd/activity/"),
    "includes .gsd/activity/"
  );
  assert.ok(
    RUNTIME_EXCLUSION_PATHS.includes(".gsd/STATE.md"),
    "includes .gsd/STATE.md"
  );

  // ─── runGit ────────────────────────────────────────────────────────────


  const tempDir = mkdtempSync(join(tmpdir(), "gsd-git-service-test-"));
  runGit(tempDir, ["init", "-b", "main"]);
  runGit(tempDir, ["config", "user.name", "Pi Test"]);
  runGit(tempDir, ["config", "user.email", "pi@example.com"]);

  // runGit should work on a valid repo
  const branch = runGit(tempDir, ["branch", "--show-current"]);
  assert.deepStrictEqual(branch, "main", "runGit returns current branch");

  // runGit allowFailure returns empty string on failure
  const result = runGit(tempDir, ["log", "--oneline"], { allowFailure: true });
  assert.deepStrictEqual(result, "", "runGit allowFailure returns empty on error (no commits yet)");

  // runGit throws on failure without allowFailure
  let threw = false;
  try {
    runGit(tempDir, ["log", "--oneline"]);
  } catch (e) {
    threw = true;
    assert.ok(
      (e as Error).message.includes("git log --oneline failed"),
      "error message includes command and path"
    );
  }
  assert.ok(threw, "runGit throws without allowFailure on error");

  // ─── Type exports compile check ────────────────────────────────────────


  // These are compile-time checks — if we got here, the types import fine
  const _prefs: GitPreferences = { auto_push: true, remote: "origin" };
  const _opts: CommitOptions = { message: "test" };
  assert.ok(true, "GitPreferences type exported and usable");
  assert.ok(true, "CommitOptions type exported and usable");

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
    runGit(dir, ["init", "-b", "main"]);
    runGit(dir, ["config", "user.name", "Pi Test"]);
    runGit(dir, ["config", "user.email", "pi@example.com"]);
    // Need an initial commit so HEAD exists
    createFile(dir, ".gitkeep", "");
    runGit(dir, ["add", "-A"]);
    runGit(dir, ["commit", "-m", "init"]);
    return dir;
  }

  // ─── GitServiceImpl: smart staging ─────────────────────────────────────

  test('GitServiceImpl: smart staging', () => {
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

    assert.deepStrictEqual(result, "test: smart staging", "commit returns the commit message");

    // Verify only src/code.ts is in the commit
    const showStat = run("git show --stat --format= HEAD", repo);
    assert.ok(showStat.includes("src/code.ts"), "src/code.ts is in the commit");
    assert.ok(!showStat.includes(".gsd/activity"), ".gsd/activity/ excluded from commit");
    assert.ok(!showStat.includes(".gsd/runtime"), ".gsd/runtime/ excluded from commit");
    assert.ok(!showStat.includes("STATE.md"), ".gsd/STATE.md excluded from commit");
    assert.ok(!showStat.includes("auto.lock"), ".gsd/auto.lock excluded from commit");
    assert.ok(!showStat.includes("metrics.json"), ".gsd/metrics.json excluded from commit");
    assert.ok(!showStat.includes(".gsd/worktrees"), ".gsd/worktrees/ excluded from commit");

    // Verify runtime files are still untracked
    // git status --short may collapse to "?? .gsd/" or show individual files
    // Use --untracked-files=all to force individual listing
    const statusOut = run("git status --short --untracked-files=all", repo);
    assert.ok(statusOut.includes(".gsd/activity/"), "activity still untracked after commit");
    assert.ok(statusOut.includes(".gsd/runtime/"), "runtime still untracked after commit");
    assert.ok(statusOut.includes(".gsd/STATE.md"), "STATE.md still untracked after commit");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── GitServiceImpl: smart staging excludes tracked runtime files ──────

  test('GitServiceImpl: smart staging excludes tracked runtime files', () => {
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
    assert.ok(tracked.includes("metrics.json"), "precondition: metrics.json tracked");
    assert.ok(tracked.includes("completed-units.json"), "precondition: completed-units.json tracked");
    assert.ok(tracked.includes("activity/log.jsonl"), "precondition: activity log tracked");

    // Now modify both runtime and real files
    createFile(repo, ".gsd/metrics.json", '{"version":2}');
    createFile(repo, ".gsd/completed-units.json", '["unit1","unit2"]');
    createFile(repo, ".gsd/activity/log.jsonl", '{"ts":2}');
    createFile(repo, "src/real.ts", "updated code");

    // autoCommit should commit real.ts. The first call also runs auto-cleanup
    // which removes runtime files from the index via a dedicated commit.
    const msg = svc.autoCommit("execute-task", "M001/S01/T01");
    assert.ok(msg !== null, "autoCommit produces a commit");

    const show = run("git show --stat HEAD", repo);
    assert.ok(show.includes("src/real.ts"), "real files are committed");

    // After the commit, runtime files must no longer be in the git index.
    // They remain on disk but are untracked (protected by .gitignore).
    const trackedAfter = run("git ls-files .gsd/", repo);
    assert.deepStrictEqual(trackedAfter, "", "no .gsd/ runtime files remain in the index");

    // Verify a second autoCommit with changed runtime files does NOT stage them
    createFile(repo, ".gsd/metrics.json", '{"version":3}');
    createFile(repo, ".gsd/completed-units.json", '["unit1","unit2","unit3"]');
    createFile(repo, "src/real.ts", "third version");

    const msg2 = svc.autoCommit("execute-task", "M001/S01/T02");
    assert.ok(msg2 !== null, "second autoCommit produces a commit");

    const show2 = run("git show --stat HEAD", repo);
    assert.ok(show2.includes("src/real.ts"), "real files committed in second commit");
    assert.ok(!show2.includes("metrics"), "metrics.json not in second commit");
    assert.ok(!show2.includes("completed-units"), "completed-units.json not in second commit");
    assert.ok(!show2.includes("activity"), "activity not in second commit");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── GitServiceImpl: autoCommit on clean repo ──────────────────────────

  test('GitServiceImpl: autoCommit', () => {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Clean repo — autoCommit should return null
    const cleanResult = svc.autoCommit("task", "T01");
    assert.deepStrictEqual(cleanResult, null, "autoCommit on clean repo returns null");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── GitServiceImpl: autoCommit on dirty repo ──────────────────────────

  test('GitServiceImpl: autoCommit on dirty repo', () => {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    createFile(repo, "src/new-feature.ts", "export const x = 1;");

    // Without task context, autoCommit uses generic chore message
    const msg = svc.autoCommit("task", "T01");
    assert.deepStrictEqual(msg, "chore: auto-commit after task\n\nGSD-Unit: T01", "autoCommit returns generic format with trailer");

    const log = run("git log --oneline -1", repo);
    assert.ok(log.includes("chore: auto-commit after task"), "generic commit message is in git log");

    // With task context, autoCommit uses meaningful message
    createFile(repo, "src/auth.ts", "export function login() {}");
    const msg2 = svc.autoCommit("task", "S01/T02", [], {
      taskId: "S01/T02",
      taskTitle: "implement user authentication endpoint",
      oneLiner: "Added JWT-based auth with refresh token rotation",
      keyFiles: ["src/auth.ts"],
    });
    assert.ok(msg2 !== null, "autoCommit with task context returns a message");
    assert.ok(msg2!.startsWith("feat:"), "meaningful commit uses feat type without scope");
    assert.ok(msg2!.includes("JWT-based auth"), "meaningful commit includes one-liner content");
    assert.ok(msg2!.includes("GSD-Task: S01/T02"), "meaningful commit has GSD-Task trailer");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── GitServiceImpl: empty-after-staging guard ─────────────────────────

  test('GitServiceImpl: empty-after-staging guard', () => {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Create only runtime files
    createFile(repo, ".gsd/activity/x.jsonl", "data");

    const result = svc.autoCommit("task", "T02");
    assert.deepStrictEqual(result, null, "autoCommit returns null when only runtime files are dirty");

    // Verify no new commit was created (should still be at init commit)
    const logCount = run("git rev-list --count HEAD", repo);
    assert.deepStrictEqual(logCount, "1", "no new commit created when only runtime files changed");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── GitServiceImpl: autoCommit with extraExclusions ───────────────────

  test('GitServiceImpl: autoCommit with extraExclusions', () => {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Create both a .gsd/ planning file and a regular source file
    createFile(repo, ".gsd/milestones/M001/M001-ROADMAP.md", "- [x] S01");
    createFile(repo, "src/feature.ts", "export const y = 2;");

    // Auto-commit with .gsd/ excluded (simulates pre-switch)
    const msg = svc.autoCommit("pre-switch", "main", [".gsd/"]);
    assert.deepStrictEqual(msg, "chore: auto-commit after pre-switch\n\nGSD-Unit: main", "pre-switch autoCommit with .gsd/ exclusion commits");

    // Verify .gsd/ file was NOT committed
    const show = run("git show --stat HEAD", repo);
    assert.ok(!show.includes("ROADMAP"), ".gsd/ files excluded from pre-switch auto-commit");
    assert.ok(show.includes("feature.ts"), "non-.gsd/ files included in pre-switch auto-commit");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── GitServiceImpl: autoCommit extraExclusions — only .gsd/ dirty ────

  test('GitServiceImpl: autoCommit extraExclusions — only .gsd/ dirty', () => {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Create only .gsd/ planning files
    createFile(repo, ".gsd/milestones/M001/M001-ROADMAP.md", "- [x] S01");
    createFile(repo, ".gsd/STATE.md", "state content");

    // Auto-commit with .gsd/ excluded — nothing else to commit
    const result = svc.autoCommit("pre-switch", "main", [".gsd/"]);
    assert.deepStrictEqual(result, null, "autoCommit returns null when only .gsd/ files are dirty and excluded");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── GitServiceImpl: commit returns null when nothing staged ───────────

  test('GitServiceImpl: commit empty', () => {
    const repo = initTempRepo();
    const svc = new GitServiceImpl(repo);

    // Nothing dirty, commit should return null
    const result = svc.commit({ message: "should not commit" });
    assert.deepStrictEqual(result, null, "commit returns null when nothing to stage");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── Helper: create repo for branch tests ────────────────────────────

  function initBranchTestRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "gsd-git-t03-"));
    runGit(dir, ["init", "-b", "main"]);
    runGit(dir, ["config", "user.name", "Pi Test"]);
    runGit(dir, ["config", "user.email", "pi@example.com"]);
    createFile(dir, ".gitkeep", "");
    runGit(dir, ["add", "-A"]);
    runGit(dir, ["commit", "-m", "init"]);
    return dir;
  }

  // ─── getCurrentBranch ────────────────────────────────────────────────

  test('Branch queries', () => {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    assert.deepStrictEqual(svc.getCurrentBranch(), "main", "getCurrentBranch returns main on main branch");

    run("git checkout -b gsd/M001/S01", repo);
    assert.deepStrictEqual(svc.getCurrentBranch(), "gsd/M001/S01", "getCurrentBranch returns slice branch name");

    run("git checkout -b feature/foo", repo);
    assert.deepStrictEqual(svc.getCurrentBranch(), "feature/foo", "getCurrentBranch returns feature branch name");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── getMainBranch ────────────────────────────────────────────────────

  test('getMainBranch', () => {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Basic case: repo has "main" branch
    assert.deepStrictEqual(svc.getMainBranch(), "main", "getMainBranch returns main when main exists");

    rmSync(repo, { recursive: true, force: true });
  });

  {
    // master-only repo
    const repo = mkdtempSync(join(tmpdir(), "gsd-git-t03-master-"));
    runGit(repo, ["init", "-b", "master"]);
    runGit(repo, ["config", "user.name", "Pi Test"]);
    runGit(repo, ["config", "user.email", "pi@example.com"]);
    createFile(repo, ".gitkeep", "");
    runGit(repo, ["add", "-A"]);
    runGit(repo, ["commit", "-m", "init"]);

    const svc = new GitServiceImpl(repo);
    assert.deepStrictEqual(svc.getMainBranch(), "master", "getMainBranch returns master when only master exists");

    rmSync(repo, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // S05: Enhanced features — snapshots, pre-merge checks
  // ═══════════════════════════════════════════════════════════════════════

  // ─── createSnapshot: default (enabled) ─────────────────────────────────

  test('createSnapshot: enabled by default when prefs omitted', () => {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Create a branch with a commit
    run("git checkout -b gsd/M001/S01", repo);
    createFile(repo, "src/snap.ts", "snapshot me");
    svc.commit({ message: "snapshot test commit" });

    // Create snapshot ref for this branch
    svc.createSnapshot("gsd/M001/S01");

    // Verify ref exists under refs/gsd/snapshots/
    const refs = run("git for-each-ref refs/gsd/snapshots/", repo);
    assert.ok(refs.includes("refs/gsd/snapshots/gsd/M001/S01/"), "snapshot ref created under refs/gsd/snapshots/");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── createSnapshot: prefs disabled ────────────────────────────────────

  test('createSnapshot: disabled', () => {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { snapshots: false });

    run("git checkout -b gsd/M001/S01", repo);
    createFile(repo, "src/no-snap.ts", "no snapshot");
    svc.commit({ message: "no snapshot commit" });

    // createSnapshot should be a no-op when disabled
    svc.createSnapshot("gsd/M001/S01");

    const refs = run("git for-each-ref refs/gsd/snapshots/", repo);
    assert.deepStrictEqual(refs, "", "no snapshot ref created when prefs.snapshots is false");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── runPreMergeCheck: default (auto-detect) ──────────────────────────

  test('runPreMergeCheck: auto-detects when prefs omitted', () => {
    const repo = initBranchTestRepo();
    createFile(repo, "package.json", JSON.stringify({
      name: "test-default",
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    run("git add -A", repo);
    run('git commit -m "add package.json"', repo);

    // No pre_merge_check pref set — should auto-detect and run
    const svc = new GitServiceImpl(repo);
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assert.deepStrictEqual(result.passed, true, "runPreMergeCheck auto-detects and passes when prefs omitted");
    assert.ok(!result.skipped, "runPreMergeCheck is not skipped when prefs omitted and package.json exists");

    rmSync(repo, { recursive: true, force: true });
  });

  test('runPreMergeCheck: gracefully skips when prefs omitted and no package.json', () => {
    const repo = initBranchTestRepo();
    // No package.json — auto-detect should skip gracefully
    const svc = new GitServiceImpl(repo);
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assert.deepStrictEqual(result.passed, true, "runPreMergeCheck passes when no package.json (skip)");
    assert.deepStrictEqual(result.skipped, true, "runPreMergeCheck skips when no test runner detected");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── runPreMergeCheck: pass ────────────────────────────────────────────

  test('runPreMergeCheck: pass', () => {
    const repo = initBranchTestRepo();
    // Create package.json with passing test script
    createFile(repo, "package.json", JSON.stringify({
      name: "test-pass",
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    run("git add -A", repo);
    run('git commit -m "add package.json"', repo);

    const svc = new GitServiceImpl(repo, { pre_merge_check: true });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assert.deepStrictEqual(result.passed, true, "runPreMergeCheck returns passed:true when tests pass");
    assert.ok(!result.skipped, "runPreMergeCheck is not skipped when enabled");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── runPreMergeCheck: fail ────────────────────────────────────────────

  test('runPreMergeCheck: fail', () => {
    const repo = initBranchTestRepo();
    // Create package.json with failing test script
    createFile(repo, "package.json", JSON.stringify({
      name: "test-fail",
      scripts: { test: 'node -e "process.exit(1)"' },
    }));
    run("git add -A", repo);
    run('git commit -m "add failing package.json"', repo);

    const svc = new GitServiceImpl(repo, { pre_merge_check: true });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assert.deepStrictEqual(result.passed, false, "runPreMergeCheck returns passed:false when tests fail");
    assert.ok(!result.skipped, "runPreMergeCheck is not skipped when enabled");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── runPreMergeCheck: disabled ────────────────────────────────────────

  test('runPreMergeCheck: disabled', () => {
    const repo = initBranchTestRepo();
    createFile(repo, "package.json", JSON.stringify({
      name: "test-disabled",
      scripts: { test: 'node -e "process.exit(1)"' },
    }));
    run("git add -A", repo);
    run('git commit -m "add package.json"', repo);

    const svc = new GitServiceImpl(repo, { pre_merge_check: false });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assert.deepStrictEqual(result.skipped, true, "runPreMergeCheck skipped when pre_merge_check is false");
    assert.deepStrictEqual(result.passed, true, "runPreMergeCheck returns passed:true when skipped (no block)");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── runPreMergeCheck: custom command ──────────────────────────────────

  test('runPreMergeCheck: custom command', () => {
    const repo = initBranchTestRepo();
    // Custom command string overrides auto-detection
    const svc = new GitServiceImpl(repo, { pre_merge_check: 'node -e "process.exit(0)"' });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assert.deepStrictEqual(result.passed, true, "runPreMergeCheck passes with custom command that exits 0");
    assert.ok(!result.skipped, "custom command is not skipped");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── VALID_BRANCH_NAME regex ──────────────────────────────────────────

  test('VALID_BRANCH_NAME regex', () => {
    // Valid branch names
    assert.ok(VALID_BRANCH_NAME.test("main"), "VALID_BRANCH_NAME accepts 'main'");
    assert.ok(VALID_BRANCH_NAME.test("master"), "VALID_BRANCH_NAME accepts 'master'");
    assert.ok(VALID_BRANCH_NAME.test("develop"), "VALID_BRANCH_NAME accepts 'develop'");
    assert.ok(VALID_BRANCH_NAME.test("feature/foo"), "VALID_BRANCH_NAME accepts 'feature/foo'");
    assert.ok(VALID_BRANCH_NAME.test("release-1.0"), "VALID_BRANCH_NAME accepts 'release-1.0'");
    assert.ok(VALID_BRANCH_NAME.test("my_branch"), "VALID_BRANCH_NAME accepts 'my_branch'");
    assert.ok(VALID_BRANCH_NAME.test("v2.0.1"), "VALID_BRANCH_NAME accepts 'v2.0.1'");

    // Invalid / injection attempts
    assert.ok(!VALID_BRANCH_NAME.test("main; rm -rf /"), "VALID_BRANCH_NAME rejects shell injection");
    assert.ok(!VALID_BRANCH_NAME.test("main && echo pwned"), "VALID_BRANCH_NAME rejects && injection");
    assert.ok(!VALID_BRANCH_NAME.test(""), "VALID_BRANCH_NAME rejects empty string");
    assert.ok(!VALID_BRANCH_NAME.test("branch name"), "VALID_BRANCH_NAME rejects spaces");
    assert.ok(!VALID_BRANCH_NAME.test("branch`cmd`"), "VALID_BRANCH_NAME rejects backticks");
    assert.ok(!VALID_BRANCH_NAME.test("branch$(cmd)"), "VALID_BRANCH_NAME rejects $() subshell");
  });

  // ─── getMainBranch: configured main_branch preference ──────────────────

  test('getMainBranch: configured main_branch', () => {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { main_branch: "trunk" });

    assert.deepStrictEqual(svc.getMainBranch(), "trunk", "getMainBranch returns configured main_branch preference");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── getMainBranch: falls back to auto-detection when not set ──────────

  test('getMainBranch: fallback to auto-detection', () => {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, {});

    assert.deepStrictEqual(svc.getMainBranch(), "main", "getMainBranch falls back to auto-detection when main_branch not set");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── getMainBranch: ignores invalid branch names ───────────────────────

  test('getMainBranch: ignores invalid branch name', () => {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { main_branch: "main; rm -rf /" });

    assert.deepStrictEqual(svc.getMainBranch(), "main", "getMainBranch ignores invalid branch name and falls back to auto-detection");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── PreMergeCheckResult type export compile check ─────────────────────

  test('PreMergeCheckResult type export', () => {
    const _checkResult: PreMergeCheckResult = { passed: true, skipped: false };
    assert.ok(true, "PreMergeCheckResult type exported and usable");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Integration branch — feature-branch workflow support
  // ═══════════════════════════════════════════════════════════════════════

  // ─── writeIntegrationBranch / readIntegrationBranch: round-trip ────────

  test('Integration branch: write and read', () => {
    const repo = initBranchTestRepo();

    // Initially no integration branch
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "readIntegrationBranch returns null when no metadata");

    // Write integration branch
    writeIntegrationBranch(repo, "M001", "f-123-new-thing");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "f-123-new-thing", "readIntegrationBranch returns written branch");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── writeIntegrationBranch: updates when branch changes (#300) ──────

  test('Integration branch: updates on branch change', () => {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "f-123-first");
    writeIntegrationBranch(repo, "M001", "f-456-second"); // updates to new branch (#300)

    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "f-456-second", "second write updates integration branch to new value");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── writeIntegrationBranch: same branch is idempotent ─────────────────

  test('Integration branch: same branch is idempotent', () => {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "f-123-first");
    writeIntegrationBranch(repo, "M001", "f-123-first"); // same branch — no-op

    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "f-123-first", "same branch write is idempotent");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── writeIntegrationBranch: rejects slice branches ───────────────────

  test('Integration branch: rejects slice branches', () => {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "gsd/M001/S01");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "slice branches are not recorded as integration branch");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── writeIntegrationBranch: rejects workflow-template branches (#2498) ─

  test('Integration branch: rejects workflow-template branches', () => {
    const repo = initBranchTestRepo();

    // All 8 registered workflow templates should be rejected
    writeIntegrationBranch(repo, "M001", "gsd/hotfix/fix-login");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "hotfix branch is not recorded");

    writeIntegrationBranch(repo, "M001", "gsd/bugfix/null-pointer");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "bugfix branch is not recorded");

    writeIntegrationBranch(repo, "M001", "gsd/small-feature/add-button");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "small-feature branch is not recorded");

    writeIntegrationBranch(repo, "M001", "gsd/refactor/rename-module");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "refactor branch is not recorded");

    writeIntegrationBranch(repo, "M001", "gsd/spike/evaluate-lib");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "spike branch is not recorded");

    writeIntegrationBranch(repo, "M001", "gsd/security-audit/owasp-scan");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "security-audit branch is not recorded");

    writeIntegrationBranch(repo, "M001", "gsd/dep-upgrade/bump-react");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "dep-upgrade branch is not recorded");

    writeIntegrationBranch(repo, "M001", "gsd/full-project/new-app");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "full-project branch is not recorded");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── writeIntegrationBranch: still records legitimate branches ────────

  test('Integration branch: records non-ephemeral gsd branches', () => {
    const repo = initBranchTestRepo();

    // A normal feature branch should still be recorded
    writeIntegrationBranch(repo, "M001", "feature/new-thing");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "feature/new-thing", "normal branches are recorded");

    // The main branch should be recorded
    writeIntegrationBranch(repo, "M002", "main");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M002"), "main", "main branch is recorded");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── writeIntegrationBranch: rejects invalid branch names ─────────────

  test('Integration branch: rejects invalid names', () => {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "bad; rm -rf /");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "invalid branch name is not recorded");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── getMainBranch: uses integration branch when milestone set ────────

  test('getMainBranch: integration branch from milestone metadata', () => {
    const repo = initBranchTestRepo();

    // Create a feature branch
    run("git checkout -b f-123-feature", repo);
    run("git checkout main", repo);

    // Write integration branch metadata
    writeIntegrationBranch(repo, "M001", "f-123-feature");

    // Without milestone set, getMainBranch returns "main"
    const svc = new GitServiceImpl(repo);
    assert.deepStrictEqual(svc.getMainBranch(), "main", "getMainBranch returns main when no milestone set");

    // With milestone set, getMainBranch returns the integration branch
    svc.setMilestoneId("M001");
    assert.deepStrictEqual(svc.getMainBranch(), "f-123-feature", "getMainBranch returns integration branch when milestone set");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── getMainBranch: main_branch pref still takes priority ─────────────

  test('getMainBranch: main_branch pref overrides integration branch', () => {
    const repo = initBranchTestRepo();

    run("git checkout -b f-123-feature", repo);
    run("git checkout -b trunk", repo);
    run("git checkout main", repo);

    writeIntegrationBranch(repo, "M001", "f-123-feature");

    // Explicit preference still wins
    const svc = new GitServiceImpl(repo, { main_branch: "trunk" });
    svc.setMilestoneId("M001");
    assert.deepStrictEqual(svc.getMainBranch(), "trunk", "main_branch preference overrides integration branch");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── getMainBranch: falls back when integration branch deleted ────────

  test('getMainBranch: fallback when integration branch deleted', () => {
    const repo = initBranchTestRepo();

    // Write metadata pointing to a branch that doesn't exist
    writeIntegrationBranch(repo, "M001", "deleted-branch");

    const svc = new GitServiceImpl(repo);
    svc.setMilestoneId("M001");
    assert.deepStrictEqual(svc.getMainBranch(), "main", "getMainBranch falls back to main when integration branch no longer exists");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── resolveMilestoneIntegrationBranch: recorded branch wins when it exists ───

  test('Integration branch: resolver prefers recorded branch', () => {
    const repo = initBranchTestRepo();
    run("git checkout -b feature/live", repo);
    run("git checkout main", repo);
    writeIntegrationBranch(repo, "M001", "feature/live");

    const resolved = resolveMilestoneIntegrationBranch(repo, "M001");
    assert.deepStrictEqual(resolved.status, "recorded", "resolver reports recorded branch when metadata branch exists");
    assert.deepStrictEqual(resolved.recordedBranch, "feature/live", "resolver includes recorded branch");
    assert.deepStrictEqual(resolved.effectiveBranch, "feature/live", "resolver uses recorded branch as effective branch");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── resolveMilestoneIntegrationBranch: falls back to detected default ────────

  test('Integration branch: resolver falls back to detected default', () => {
    const repo = initBranchTestRepo();
    writeIntegrationBranch(repo, "M001", "deleted-branch");

    const resolved = resolveMilestoneIntegrationBranch(repo, "M001");
    assert.deepStrictEqual(resolved.status, "fallback", "resolver reports fallback when recorded branch is stale");
    assert.deepStrictEqual(resolved.recordedBranch, "deleted-branch", "resolver preserves stale recorded branch for diagnostics");
    assert.deepStrictEqual(resolved.effectiveBranch, "main", "resolver falls back to detected default branch");
    assert.ok(
      resolved.reason.includes("deleted-branch") && resolved.reason.includes("main"),
      "resolver reason mentions stale recorded branch and fallback branch",
    );

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── resolveMilestoneIntegrationBranch: configured main_branch is fallback ─────

  test('Integration branch: resolver uses configured fallback branch', () => {
    const repo = initBranchTestRepo();
    run("git checkout -b trunk", repo);
    run("git checkout main", repo);
    writeIntegrationBranch(repo, "M001", "deleted-branch");

    const resolved = resolveMilestoneIntegrationBranch(repo, "M001", { main_branch: "trunk" });
    assert.deepStrictEqual(resolved.status, "fallback", "resolver reports fallback when using configured main_branch");
    assert.deepStrictEqual(resolved.effectiveBranch, "trunk", "resolver prefers configured main_branch as fallback");
    assert.ok(
      resolved.reason.includes("deleted-branch") && resolved.reason.includes("trunk"),
      "configured fallback reason mentions stale branch and configured branch",
    );

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── Per-milestone isolation: different milestones, different targets ──

  test('Integration branch: per-milestone isolation', () => {
    const repo = initBranchTestRepo();

    run("git checkout -b feature-a", repo);
    run("git checkout -b feature-b", repo);
    run("git checkout main", repo);

    writeIntegrationBranch(repo, "M001", "feature-a");
    writeIntegrationBranch(repo, "M002", "feature-b");

    const svc = new GitServiceImpl(repo);

    svc.setMilestoneId("M001");
    assert.deepStrictEqual(svc.getMainBranch(), "feature-a", "M001 integration branch is feature-a");

    svc.setMilestoneId("M002");
    assert.deepStrictEqual(svc.getMainBranch(), "feature-b", "M002 integration branch is feature-b");

    svc.setMilestoneId(null);
    assert.deepStrictEqual(svc.getMainBranch(), "main", "no milestone set → falls back to main");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── Backward compatibility: no metadata → existing behavior ──────────

  test('Integration branch: backward compat', () => {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    // Set milestone but no metadata file exists
    svc.setMilestoneId("M001");
    assert.deepStrictEqual(svc.getMainBranch(), "main", "backward compat: no metadata file → falls back to main");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── untrackRuntimeFiles: removes tracked runtime files from index ───

  test('untrackRuntimeFiles', async () => {
    const { untrackRuntimeFiles } = await import("../../gitignore.ts");
    const repo = mkdtempSync(join(tmpdir(), "gsd-untrack-"));
    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.email", "test@test.com"]);
    runGit(repo, ["config", "user.name", "Test"]);

    // Create and track runtime files (simulates pre-.gitignore state)
    mkdirSync(join(repo, ".gsd", "activity"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "completed-units.json"), '["u1"]');
    writeFileSync(join(repo, ".gsd", "metrics.json"), '{}');
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State");
    writeFileSync(join(repo, ".gsd", "activity", "log.jsonl"), "{}");
    writeFileSync(join(repo, ".gsd", "runtime", "data.json"), "{}");
    writeFileSync(join(repo, "src.ts"), "code");
    runGit(repo, ["add", "-A"]);
    runGit(repo, ["commit", "-m", "init"]);

    // Precondition: runtime files are tracked
    const trackedBefore = run("git ls-files .gsd/", repo);
    assert.ok(trackedBefore.includes("completed-units.json"), "untrack: precondition — completed-units tracked");
    assert.ok(trackedBefore.includes("metrics.json"), "untrack: precondition — metrics tracked");

    // Run untrackRuntimeFiles
    untrackRuntimeFiles(repo);

    // Runtime files should be removed from the index
    const trackedAfter = run("git ls-files .gsd/", repo);
    assert.deepStrictEqual(trackedAfter, "", "untrack: all runtime files removed from index");

    // Non-runtime files remain tracked
    const srcTracked = run("git ls-files src.ts", repo);
    assert.ok(srcTracked.includes("src.ts"), "untrack: non-runtime files remain tracked");

    // Files still exist on disk
    assert.ok(existsSync(join(repo, ".gsd", "completed-units.json")),
      "untrack: completed-units.json still on disk");
    assert.ok(existsSync(join(repo, ".gsd", "metrics.json")),
      "untrack: metrics.json still on disk");

    // Idempotent — running again doesn't error
    untrackRuntimeFiles(repo);
    assert.ok(true, "untrack: second call is idempotent (no error)");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── smartStage excludes runtime files but allows milestone artifacts ──

  test('smartStage excludes runtime files, allows milestone artifacts', () => {
    const repo = mkdtempSync(join(tmpdir(), "gsd-smart-stage-excludes-"));
    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.email", "test@test.com"]);
    runGit(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "init");
    runGit(repo, ["add", "-A"]);
    runGit(repo, ["commit", "-m", "init"]);

    // Create .gsd/ runtime files + milestone artifacts + a normal source file
    mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "activity"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M001", "ROADMAP.md"), "# Roadmap");
    writeFileSync(join(repo, ".gsd", "PREFERENCES.md"), "---\nversion: 1\n---");
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State");
    writeFileSync(join(repo, ".gsd", "runtime", "units.json"), "{}");
    writeFileSync(join(repo, ".gsd", "activity", "log.jsonl"), "{}");
    writeFileSync(join(repo, "src.ts"), "const x = 1;");

    // smartStage excludes only runtime paths, not all of .gsd/ (#1326)
    const svc = new GitServiceImpl(repo);
    const msg = svc.commit({ message: "test commit" });
    assert.ok(msg !== null, "smartStage: commit succeeds");

    const committed = run("git show --name-only HEAD", repo);
    assert.ok(committed.includes("src.ts"), "smartStage: source files ARE in commit");
    // Runtime files should NOT be committed
    assert.ok(!committed.includes(".gsd/STATE.md"), "smartStage: STATE.md excluded (runtime)");
    assert.ok(!committed.includes(".gsd/runtime/"), "smartStage: runtime/ excluded");
    assert.ok(!committed.includes(".gsd/activity/"), "smartStage: activity/ excluded");
    // Milestone artifacts SHOULD be committed when not gitignored (#1326)
    assert.ok(committed.includes(".gsd/milestones/"), "smartStage: milestone artifacts ARE committed");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── writeIntegrationBranch: no commit (metadata in external storage) ──

  test('writeIntegrationBranch: no commit', () => {
    const repo = initBranchTestRepo();
    const commitsBefore = run("git rev-list --count HEAD", repo);

    writeIntegrationBranch(repo, "M001", "f-123-new-thing");

    // File should still be written to disk
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), "f-123-new-thing",
      "writeIntegrationBranch: metadata file exists on disk");

    // No commit — .gsd/ is managed externally
    const commitsAfter = run("git rev-list --count HEAD", repo);
    assert.deepStrictEqual(commitsBefore, commitsAfter,
      "writeIntegrationBranch: no git commit created for integration branch");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── ensureGitignore: always adds .gsd to gitignore ──────────────────

  test('ensureGitignore: adds .gsd entry', async () => {
    const { ensureGitignore } = await import("../../gitignore.ts");
    const repo = mkdtempSync(join(tmpdir(), "gsd-gitignore-external-state-"));

    // Should add .gsd to gitignore (external state dir is a symlink)
    const modified = ensureGitignore(repo);
    assert.ok(modified, "ensureGitignore: gitignore was modified");

    const { readFileSync } = await import("node:fs");
    const content = readFileSync(join(repo, ".gitignore"), "utf-8");
    const lines = content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    assert.ok(lines.includes(".gsd"), "ensureGitignore: .gitignore contains .gsd");
    assert.ok(lines.includes(".mcp.json"), "ensureGitignore: .gitignore contains .mcp.json");

    // Idempotent — calling again doesn't add duplicates
    const modified2 = ensureGitignore(repo);
    assert.ok(!modified2, "ensureGitignore: second call is idempotent");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── nativeAddAllWithExclusions: symlinked .gsd fallback ───────────────

  test('nativeAddAllWithExclusions: symlinked .gsd fallback', () => {
    // When .gsd is a symlink, git rejects `:!.gsd/...` pathspecs with
    // "fatal: pathspec '...' is beyond a symbolic link". When `.gsd` is
    // already gitignored, the fallback should still stage untracked real files.
    const repo = initTempRepo();

    // Create the real .gsd directory outside the repo, then symlink it
    const externalGsd = mkdtempSync(join(tmpdir(), "gsd-external-"));
    mkdirSync(join(externalGsd, "activity"), { recursive: true });
    writeFileSync(join(externalGsd, "activity", "log.jsonl"), "log data");
    writeFileSync(join(externalGsd, "STATE.md"), "# State");

    // Symlink .gsd -> external directory
    symlinkSync(externalGsd, join(repo, ".gsd"));

    // Add .gitignore so .gsd/ is ignored
    writeFileSync(join(repo, ".gitignore"), ".gsd\n");

    // Create a tracked file and commit it, then modify it
    createFile(repo, "src/app.ts", "export const x = 1;");
    run("git add -A", repo);
    run('git commit -m "add app"', repo);
    writeFileSync(join(repo, "src/app.ts"), "export const x = 2;");

    // Create an untracked file that should still be staged by the fallback
    // because `.gsd` itself is already protected by .gitignore.
    createFile(repo, "src/new-feature.ts", "export const fresh = true;");

    // nativeAddAllWithExclusions should NOT throw despite .gsd being a symlink
    let threw = false;
    try {
      nativeAddAllWithExclusions(repo, RUNTIME_EXCLUSION_PATHS);
    } catch (e) {
      threw = true;
      console.error("  unexpected error:", e);
    }
    assert.ok(!threw, "nativeAddAllWithExclusions does not throw with symlinked .gsd");

    // Verify the tracked modified file was staged
    const staged = run("git diff --cached --name-only", repo);
    assert.ok(staged.includes("src/app.ts"), "modified tracked file staged despite symlinked .gsd");

    assert.ok(staged.includes("src/new-feature.ts"),
      "symlink fallback should still stage new real files when .gsd is gitignored");
    assert.ok(!staged.includes(".gsd"), ".gsd content not staged");

    rmSync(repo, { recursive: true, force: true });
    rmSync(externalGsd, { recursive: true, force: true });
  });

  test('nativeAddAllWithExclusions: self-heals symlinked .gsd when .gitignore lacks it (#4423)', () => {
    // When `.gsd` is a symlink AND not listed in `.gitignore`, the staging
    // fallback must self-heal by appending `.gsd` to `.gitignore` and retrying
    // `git add -A`. Without this, new user files are silently dropped.
    const repo = initTempRepo();

    const externalGsd = mkdtempSync(join(tmpdir(), "gsd-external-unignored-"));
    mkdirSync(join(externalGsd, "activity"), { recursive: true });
    writeFileSync(join(externalGsd, "activity", "log.jsonl"), "log data");
    writeFileSync(join(externalGsd, "STATE.md"), "# State");

    symlinkSync(externalGsd, join(repo, ".gsd"));

    createFile(repo, "src/app.ts", "export const x = 1;");
    run("git add -A", repo);
    run('git commit -m "add app"', repo);
    writeFileSync(join(repo, "src/app.ts"), "export const x = 2;");
    createFile(repo, "src/new-feature.ts", "export const fresh = true;");

    let threw = false;
    try {
      nativeAddAllWithExclusions(repo, RUNTIME_EXCLUSION_PATHS);
    } catch (e) {
      threw = true;
      console.error("  unexpected error:", e);
    }
    assert.ok(!threw, "nativeAddAllWithExclusions does not throw with symlinked .gsd when .gsd is not gitignored");

    const staged = run("git diff --cached --name-only", repo);
    assert.ok(staged.includes("src/app.ts"), "tracked modifications stage");
    assert.ok(
      staged.includes("src/new-feature.ts"),
      "self-heal adds .gsd to .gitignore so new user files are staged",
    );
    assert.ok(!staged.includes(".gsd"), ".gsd contents stay unstaged after self-heal");

    // Verify the self-heal actually wrote to .gitignore
    const gitignore = readFileSync(join(repo, ".gitignore"), "utf-8");
    assert.ok(/^\.gsd\/?$/m.test(gitignore), ".gitignore contains .gsd entry after self-heal");

    rmSync(repo, { recursive: true, force: true });
    rmSync(externalGsd, { recursive: true, force: true });
  });

  test('nativeAddAllWithExclusions: explicit staging protects work when manage_gitignore:false (#4423)', () => {
    // When `git.manage_gitignore: false` is set in PREFERENCES.md, the
    // self-heal path is disabled. The fallback must still protect user work
    // by explicitly staging untracked real files while skipping `.gsd`.
    const repo = initTempRepo();

    const externalGsd = mkdtempSync(join(tmpdir(), "gsd-external-optout-"));
    mkdirSync(join(externalGsd, "activity"), { recursive: true });
    writeFileSync(join(externalGsd, "activity", "log.jsonl"), "log data");
    writeFileSync(join(externalGsd, "STATE.md"), "# State");

    symlinkSync(externalGsd, join(repo, ".gsd"));

    // Create PREFERENCES.md inside the symlink target (the linked .gsd dir)
    // with the opt-out flag. The regex matches a top-level occurrence.
    writeFileSync(
      join(repo, ".gsd", "PREFERENCES.md"),
      "---\nversion: 1\ngit:\n  manage_gitignore: false\n---\n",
    );

    createFile(repo, "src/app.ts", "export const x = 1;");
    run("git add -A", repo);
    run('git commit -m "add app"', repo);
    writeFileSync(join(repo, "src/app.ts"), "export const x = 2;");
    createFile(repo, "src/new-feature.ts", "export const fresh = true;");

    let threw = false;
    try {
      nativeAddAllWithExclusions(repo, RUNTIME_EXCLUSION_PATHS);
    } catch (e) {
      threw = true;
      console.error("  unexpected error:", e);
    }
    assert.ok(!threw, "nativeAddAllWithExclusions does not throw under manage_gitignore:false");

    const staged = run("git diff --cached --name-only", repo);
    assert.ok(staged.includes("src/app.ts"), "tracked modifications stage");
    assert.ok(
      staged.includes("src/new-feature.ts"),
      "explicit staging protects new files even when self-heal is disabled",
    );
    assert.ok(!staged.includes(".gsd"), ".gsd contents stay unstaged");

    // Self-heal must NOT have written to .gitignore
    const gitignoreExists = existsSync(join(repo, ".gitignore"));
    if (gitignoreExists) {
      const gitignore = readFileSync(join(repo, ".gitignore"), "utf-8");
      assert.ok(
        !/^\.gsd\/?$/m.test(gitignore),
        "manage_gitignore:false must prevent writes to .gitignore",
      );
    }

    rmSync(repo, { recursive: true, force: true });
    rmSync(externalGsd, { recursive: true, force: true });
  });

  // ─── nativeAddAllWithExclusions: non-symlinked .gsd still works ───────

  test('nativeAddAllWithExclusions: non-symlinked .gsd still works', () => {
    // Verify the normal (non-symlink) case still works with pathspec exclusions
    const repo = initTempRepo();

    createFile(repo, ".gsd/activity/log.jsonl", "log data");
    createFile(repo, ".gsd/STATE.md", "# State");
    createFile(repo, "src/code.ts", "export const y = 2;");

    let threw = false;
    try {
      nativeAddAllWithExclusions(repo, RUNTIME_EXCLUSION_PATHS);
    } catch {
      threw = true;
    }
    assert.ok(!threw, "nativeAddAllWithExclusions works with normal .gsd directory");

    const staged = run("git diff --cached --name-only", repo);
    assert.ok(staged.includes("src/code.ts"), "real file staged with normal .gsd");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── MergeConflictError: constructor fields ───────────────────────────────

  test('MergeConflictError: constructor fields', () => {
    const err = new MergeConflictError(
      ["src/foo.ts", "src/bar.ts"],
      "squash",
      "gsd/M001/S01",
      "main",
    );
    assert.deepStrictEqual(err.conflictedFiles, ["src/foo.ts", "src/bar.ts"], "MergeConflictError.conflictedFiles populated");
    assert.deepStrictEqual(err.strategy, "squash", "MergeConflictError.strategy set");
    assert.deepStrictEqual(err.branch, "gsd/M001/S01", "MergeConflictError.branch set");
    assert.deepStrictEqual(err.mainBranch, "main", "MergeConflictError.mainBranch set");
    assert.deepStrictEqual(err.name, "MergeConflictError", "MergeConflictError.name is MergeConflictError");
    assert.ok(err.message.includes("src/foo.ts"), "MergeConflictError message lists conflicted files");
    assert.ok(err.message.toLowerCase().includes("squash"), "MergeConflictError message mentions strategy");
    assert.ok(err instanceof MergeConflictError, "MergeConflictError is an instanceof MergeConflictError");
    assert.ok(err instanceof Error, "MergeConflictError is an Error instance");
  });

  // ─── Integration branch: rejects gsd/quick/* branches ────────────────────

  test('Integration branch: rejects gsd/quick/* branches', () => {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "gsd/quick/1234-some-task");
    assert.deepStrictEqual(readIntegrationBranch(repo, "M001"), null, "gsd/quick/* branches are not recorded as integration branch");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── Integration branch: resolver returns missing when no metadata ────────

  test('Integration branch: resolver returns missing when no metadata', () => {
    const repo = initBranchTestRepo();

    // No writeIntegrationBranch call — no metadata file exists
    const resolved = resolveMilestoneIntegrationBranch(repo, "M999");
    assert.deepStrictEqual(resolved.status, "missing", "resolver reports missing when no metadata file");
    assert.deepStrictEqual(resolved.recordedBranch, null, "resolver recordedBranch is null when no metadata");
    assert.deepStrictEqual(resolved.effectiveBranch, null, "resolver effectiveBranch is null when no metadata");
    assert.ok(resolved.reason.includes("M999"), "resolver reason mentions the milestone ID");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── Integration branch: resolver missing when both recorded and configured branches gone ───

  test('Integration branch: resolver missing when both recorded and configured branches gone', () => {
    const repo = initBranchTestRepo();

    // Record a branch that doesn't exist
    writeIntegrationBranch(repo, "M001", "deleted-feature");
    // configured main_branch also doesn't exist
    const resolved = resolveMilestoneIntegrationBranch(repo, "M001", { main_branch: "nonexistent-branch" });
    assert.deepStrictEqual(resolved.status, "missing", "resolver reports missing when recorded branch and configured main_branch both absent");
    assert.deepStrictEqual(resolved.recordedBranch, "deleted-feature", "resolver preserves stale recorded branch");
    assert.deepStrictEqual(resolved.effectiveBranch, null, "resolver effectiveBranch is null when no safe fallback");
    assert.ok(
      resolved.reason.includes("deleted-feature") && resolved.reason.includes("nonexistent-branch"),
      "reason mentions both stale branch and unavailable configured branch",
    );

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── buildTaskCommitMessage: issueNumber appends Resolves trailer ─────────

  test('buildTaskCommitMessage: issueNumber appends Resolves trailer', () => {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T03",
      taskTitle: "fix login redirect",
      issueNumber: 42,
    });
    assert.ok(msg.includes("Resolves #42"), "buildTaskCommitMessage includes Resolves #N trailer when issueNumber is set");
    assert.ok(msg.startsWith("fix:"), "buildTaskCommitMessage infers fix type");
    assert.ok(msg.includes("GSD-Task: S01/T03"), "GSD-Task trailer present");
    // GSD-Task should come before Resolves
    const taskIdx = msg.indexOf("GSD-Task: S01/T03");
    const resolvesIdx = msg.indexOf("Resolves #42");
    assert.ok(taskIdx < resolvesIdx, "GSD-Task trailer before Resolves trailer");
  });

  {
    // No issueNumber — no Resolves trailer
    const msg = buildTaskCommitMessage({
      taskId: "S01/T04",
      taskTitle: "add dashboard widget",
    });
    assert.ok(!msg.includes("Resolves"), "buildTaskCommitMessage omits Resolves trailer when issueNumber is absent");
    assert.ok(msg.includes("GSD-Task: S01/T04"), "GSD-Task trailer still present");
  }

  // ─── runPreMergeCheck: skips when no package.json ────────────────────────

  test('runPreMergeCheck: skips when no package.json', () => {
    const repo = initBranchTestRepo();
    // No package.json created — auto-detect should skip gracefully
    const svc = new GitServiceImpl(repo, { pre_merge_check: true });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assert.deepStrictEqual(result.passed, true, "runPreMergeCheck passes when no package.json (skip)");
    assert.deepStrictEqual(result.skipped, true, "runPreMergeCheck skips when no package.json found");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── autoCommit: symlinked .gsd does NOT stage milestone artifacts (#2247) ──

  test('autoCommit: symlinked .gsd does NOT stage milestone artifacts (#2247)', () => {
    // When .gsd is a symlink (external state project), .gsd/ files live outside
    // the repo by design. smartStage() must NOT force-stage them into git — the
    // .gitignore exclusion is correct and intentional.
    const repo = initTempRepo();

    // Create an external .gsd directory and symlink it into the repo
    const externalGsd = mkdtempSync(join(tmpdir(), "gsd-external-symlink-"));
    mkdirSync(join(externalGsd, "milestones", "M009"), { recursive: true });
    mkdirSync(join(externalGsd, "activity"), { recursive: true });
    mkdirSync(join(externalGsd, "runtime"), { recursive: true });

    symlinkSync(externalGsd, join(repo, ".gsd"));

    // .gitignore blocks .gsd (as ensureGitignore would do for symlink projects)
    writeFileSync(join(repo, ".gitignore"), ".gsd\n");
    run('git add .gitignore', repo);
    run('git commit -m "add gitignore"', repo);

    // Pre-commit a tracked source file so git add -u can stage modifications.
    // The symlink fallback uses git add -u (tracked files only), so the file
    // must be tracked before the autoCommit scenario runs.
    createFile(repo, "src/feature.ts", "export const feature = true;");
    run('git add src/feature.ts', repo);
    run('git commit -m "add feature"', repo);

    // Simulate new milestone artifacts created during execution
    writeFileSync(join(externalGsd, "milestones", "M009", "M009-SUMMARY.md"), "# M009 Summary");
    writeFileSync(join(externalGsd, "milestones", "M009", "S01-SUMMARY.md"), "# S01 Summary");
    writeFileSync(join(externalGsd, "milestones", "M009", "T01-VERIFY.json"), '{"passed":true}');

    // Modify the tracked source file — git add -u will stage this change
    writeFileSync(join(repo, "src/feature.ts"), "export const feature = false; // updated");

    const svc = new GitServiceImpl(repo);
    const msg = svc.autoCommit("complete-milestone", "M009");
    assert.ok(msg !== null, "symlink autoCommit: commit succeeds");

    const committed = run("git show --name-only HEAD", repo);
    assert.ok(committed.includes("src/feature.ts"), "symlink autoCommit: source file committed");
    assert.ok(!committed.includes(".gsd/milestones/"),
      "symlink autoCommit: .gsd/milestones/ files are NOT staged (external state stays external)");

    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(externalGsd, { recursive: true, force: true }); } catch {}
  });

  // ─── autoCommit: absorbs preceding gsd snapshot commits ─────────────────

  test('autoCommit: absorbs preceding gsd snapshot commits', () => {
    const repo = initTempRepo();

    // Simulate 2 gsd snapshot commits
    createFile(repo, "file1.ts", "v1");
    run("git add -A", repo);
    run('git commit -m "gsd snapshot: uncommitted changes after 35m inactivity"', repo);

    createFile(repo, "file2.ts", "v2");
    run("git add -A", repo);
    run('git commit -m "gsd snapshot: pre-dispatch, uncommitted changes after 40m inactivity"', repo);

    // Verify we have 3 commits (init + 2 snapshots)
    const countBefore = run("git rev-list --count HEAD", repo);
    assert.deepStrictEqual(countBefore, "3", "precondition: 3 commits before autoCommit");

    // Now make a real change and autoCommit
    createFile(repo, "feature.ts", "real work");

    const svc = new GitServiceImpl(repo);
    const msg = svc.autoCommit("execute-task", "S01/T01");
    assert.ok(msg !== null, "autoCommit succeeds");

    // Should be 2 commits: init + squashed real commit (snapshots absorbed)
    const countAfter = run("git rev-list --count HEAD", repo);
    assert.deepStrictEqual(countAfter, "2", "snapshot commits absorbed into real commit");

    // All files should be present
    const files = run("git show --name-only HEAD", repo);
    assert.ok(files.includes("file1.ts"), "file1.ts from snapshot 1 preserved");
    assert.ok(files.includes("file2.ts"), "file2.ts from snapshot 2 preserved");
    assert.ok(files.includes("feature.ts"), "feature.ts from real commit preserved");

    // No gsd snapshot commits in log
    const log = run("git log --oneline", repo);
    assert.ok(!log.includes("gsd snapshot"), "no gsd snapshot commits remain in history");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── autoCommit: does not absorb non-snapshot commits ───────────────────

  test('autoCommit: does not absorb non-snapshot commits', () => {
    const repo = initTempRepo();

    // Create a normal (non-snapshot) commit
    createFile(repo, "earlier.ts", "earlier work");
    run("git add -A", repo);
    run('git commit -m "feat: earlier work"', repo);

    const countBefore = run("git rev-list --count HEAD", repo);
    assert.deepStrictEqual(countBefore, "2", "precondition: 2 commits before autoCommit");

    // Make a real change and autoCommit
    createFile(repo, "feature.ts", "new work");

    const svc = new GitServiceImpl(repo);
    svc.autoCommit("execute-task", "S01/T02");

    // Should be 3 commits — earlier commit not absorbed
    const countAfter = run("git rev-list --count HEAD", repo);
    assert.deepStrictEqual(countAfter, "3", "non-snapshot commits NOT absorbed");

    rmSync(repo, { recursive: true, force: true });
  });
});
