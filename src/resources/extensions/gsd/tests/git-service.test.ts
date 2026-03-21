import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
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
} from "../git-service.ts";
import { nativeAddAllWithExclusions } from "../native-git-bridge.ts";
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();
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

  // ─── inferCommitType with oneLiner ──────────────────────────────────────

  console.log("\n=== inferCommitType with oneLiner ===");

  assertEq(
    inferCommitType("implement dashboard", "Fixed rendering bug in sidebar"),
    "fix",
    "one-liner with 'fixed' overrides generic title → fix"
  );

  assertEq(
    inferCommitType("add search", "Optimized query performance with caching"),
    "perf",
    "one-liner with 'performance' and 'caching' → perf"
  );

  // ─── buildTaskCommitMessage ─────────────────────────────────────────────

  console.log("\n=== buildTaskCommitMessage ===");

  {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T02",
      taskTitle: "implement user authentication",
      oneLiner: "Added JWT-based auth with refresh token rotation",
      keyFiles: ["src/auth.ts", "src/middleware/jwt.ts"],
    });
    assertTrue(msg.startsWith("feat(S01/T02):"), "message starts with type(scope)");
    assertTrue(msg.includes("JWT-based auth"), "message includes one-liner content");
    assertTrue(msg.includes("- src/auth.ts"), "message body includes key files");
    assertTrue(msg.includes("- src/middleware/jwt.ts"), "message body includes second key file");
  }

  {
    const msg = buildTaskCommitMessage({
      taskId: "S02/T01",
      taskTitle: "fix login redirect bug",
    });
    assertTrue(msg.startsWith("fix(S02/T01):"), "infers fix type from title");
    assertTrue(msg.includes("fix login redirect bug"), "uses task title when no one-liner");
    assertTrue(!msg.includes("\n"), "no body when no key files");
  }

  {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T03",
      taskTitle: "add tests",
      oneLiner: "Unit tests for auth module with coverage",
    });
    assertTrue(msg.startsWith("test(S01/T03):"), "infers test type");
  }

  // ─── RUNTIME_EXCLUSION_PATHS ───────────────────────────────────────────

  console.log("\n=== RUNTIME_EXCLUSION_PATHS ===");

  assertEq(
    RUNTIME_EXCLUSION_PATHS.length,
    9,
    "exactly 9 runtime exclusion paths"
  );

  const expectedPaths = [
    ".gsd/activity/",
    ".gsd/runtime/",
    ".gsd/worktrees/",
    ".gsd/auto.lock",
    ".gsd/metrics.json",
    ".gsd/completed-units.json",
    ".gsd/STATE.md",
    ".gsd/gsd.db",
    ".gsd/DISCUSSION-MANIFEST.json",
  ];

  assertEq(
    [...RUNTIME_EXCLUSION_PATHS],
    expectedPaths,
    "paths match expected set in order"
  );

  assertTrue(
    RUNTIME_EXCLUSION_PATHS.includes(".gsd/activity/"),
    "includes .gsd/activity/"
  );
  assertTrue(
    RUNTIME_EXCLUSION_PATHS.includes(".gsd/STATE.md"),
    "includes .gsd/STATE.md"
  );

  // ─── runGit ────────────────────────────────────────────────────────────

  console.log("\n=== runGit ===");

  const tempDir = mkdtempSync(join(tmpdir(), "gsd-git-service-test-"));
  run("git init -b main", tempDir);
  run('git config user.name "Pi Test"', tempDir);
  run('git config user.email "pi@example.com"', tempDir);

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
    assertTrue(
      (e as Error).message.includes("git log --oneline failed"),
      "error message includes command and path"
    );
  }
  assertTrue(threw, "runGit throws without allowFailure on error");

  // ─── Type exports compile check ────────────────────────────────────────

  console.log("\n=== Type exports ===");

  // These are compile-time checks — if we got here, the types import fine
  const _prefs: GitPreferences = { auto_push: true, remote: "origin" };
  const _opts: CommitOptions = { message: "test" };
  assertTrue(true, "GitPreferences type exported and usable");
  assertTrue(true, "CommitOptions type exported and usable");

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
    run('git config user.name "Pi Test"', dir);
    run('git config user.email "pi@example.com"', dir);
    // Need an initial commit so HEAD exists
    createFile(dir, ".gitkeep", "");
    run("git add -A", dir);
    run('git commit -m "init"', dir);
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
    const showStat = run("git show --stat --format= HEAD", repo);
    assertTrue(showStat.includes("src/code.ts"), "src/code.ts is in the commit");
    assertTrue(!showStat.includes(".gsd/activity"), ".gsd/activity/ excluded from commit");
    assertTrue(!showStat.includes(".gsd/runtime"), ".gsd/runtime/ excluded from commit");
    assertTrue(!showStat.includes("STATE.md"), ".gsd/STATE.md excluded from commit");
    assertTrue(!showStat.includes("auto.lock"), ".gsd/auto.lock excluded from commit");
    assertTrue(!showStat.includes("metrics.json"), ".gsd/metrics.json excluded from commit");
    assertTrue(!showStat.includes(".gsd/worktrees"), ".gsd/worktrees/ excluded from commit");

    // Verify runtime files are still untracked
    // git status --short may collapse to "?? .gsd/" or show individual files
    // Use --untracked-files=all to force individual listing
    const statusOut = run("git status --short --untracked-files=all", repo);
    assertTrue(statusOut.includes(".gsd/activity/"), "activity still untracked after commit");
    assertTrue(statusOut.includes(".gsd/runtime/"), "runtime still untracked after commit");
    assertTrue(statusOut.includes(".gsd/STATE.md"), "STATE.md still untracked after commit");

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
    assertTrue(tracked.includes("metrics.json"), "precondition: metrics.json tracked");
    assertTrue(tracked.includes("completed-units.json"), "precondition: completed-units.json tracked");
    assertTrue(tracked.includes("activity/log.jsonl"), "precondition: activity log tracked");

    // Now modify both runtime and real files
    createFile(repo, ".gsd/metrics.json", '{"version":2}');
    createFile(repo, ".gsd/completed-units.json", '["unit1","unit2"]');
    createFile(repo, ".gsd/activity/log.jsonl", '{"ts":2}');
    createFile(repo, "src/real.ts", "updated code");

    // autoCommit should commit real.ts. The first call also runs auto-cleanup
    // which removes runtime files from the index via a dedicated commit.
    const msg = svc.autoCommit("execute-task", "M001/S01/T01");
    assertTrue(msg !== null, "autoCommit produces a commit");

    const show = run("git show --stat HEAD", repo);
    assertTrue(show.includes("src/real.ts"), "real files are committed");

    // After the commit, runtime files must no longer be in the git index.
    // They remain on disk but are untracked (protected by .gitignore).
    const trackedAfter = run("git ls-files .gsd/", repo);
    assertEq(trackedAfter, "", "no .gsd/ runtime files remain in the index");

    // Verify a second autoCommit with changed runtime files does NOT stage them
    createFile(repo, ".gsd/metrics.json", '{"version":3}');
    createFile(repo, ".gsd/completed-units.json", '["unit1","unit2","unit3"]');
    createFile(repo, "src/real.ts", "third version");

    const msg2 = svc.autoCommit("execute-task", "M001/S01/T02");
    assertTrue(msg2 !== null, "second autoCommit produces a commit");

    const show2 = run("git show --stat HEAD", repo);
    assertTrue(show2.includes("src/real.ts"), "real files committed in second commit");
    assertTrue(!show2.includes("metrics"), "metrics.json not in second commit");
    assertTrue(!show2.includes("completed-units"), "completed-units.json not in second commit");
    assertTrue(!show2.includes("activity"), "activity not in second commit");

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

    // Without task context, autoCommit uses generic chore message
    const msg = svc.autoCommit("task", "T01");
    assertEq(msg, "chore(T01): auto-commit after task", "autoCommit returns generic format without task context");

    const log = run("git log --oneline -1", repo);
    assertTrue(log.includes("chore(T01): auto-commit after task"), "generic commit message is in git log");

    // With task context, autoCommit uses meaningful message
    createFile(repo, "src/auth.ts", "export function login() {}");
    const msg2 = svc.autoCommit("task", "S01/T02", [], {
      taskId: "S01/T02",
      taskTitle: "implement user authentication endpoint",
      oneLiner: "Added JWT-based auth with refresh token rotation",
      keyFiles: ["src/auth.ts"],
    });
    assertTrue(msg2 !== null, "autoCommit with task context returns a message");
    assertTrue(msg2!.startsWith("feat(S01/T02):"), "meaningful commit uses feat type and scope");
    assertTrue(msg2!.includes("JWT-based auth"), "meaningful commit includes one-liner content");

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
    assertTrue(!show.includes("ROADMAP"), ".gsd/ files excluded from pre-switch auto-commit");
    assertTrue(show.includes("feature.ts"), "non-.gsd/ files included in pre-switch auto-commit");

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
    run('git config user.name "Pi Test"', dir);
    run('git config user.email "pi@example.com"', dir);
    createFile(dir, ".gitkeep", "");
    run("git add -A", dir);
    run('git commit -m "init"', dir);
    return dir;
  }

  // ─── getCurrentBranch ────────────────────────────────────────────────

  console.log("\n=== Branch queries ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo);

    assertEq(svc.getCurrentBranch(), "main", "getCurrentBranch returns main on main branch");

    run("git checkout -b gsd/M001/S01", repo);
    assertEq(svc.getCurrentBranch(), "gsd/M001/S01", "getCurrentBranch returns slice branch name");

    run("git checkout -b feature/foo", repo);
    assertEq(svc.getCurrentBranch(), "feature/foo", "getCurrentBranch returns feature branch name");

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
    run('git config user.name "Pi Test"', repo);
    run('git config user.email "pi@example.com"', repo);
    createFile(repo, ".gitkeep", "");
    run("git add -A", repo);
    run('git commit -m "init"', repo);

    const svc = new GitServiceImpl(repo);
    assertEq(svc.getMainBranch(), "master", "getMainBranch returns master when only master exists");

    rmSync(repo, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // S05: Enhanced features — snapshots, pre-merge checks
  // ═══════════════════════════════════════════════════════════════════════

  // ─── createSnapshot: prefs enabled ─────────────────────────────────────

  console.log("\n=== createSnapshot: enabled ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { snapshots: true });

    // Create a branch with a commit
    run("git checkout -b gsd/M001/S01", repo);
    createFile(repo, "src/snap.ts", "snapshot me");
    svc.commit({ message: "snapshot test commit" });

    // Create snapshot ref for this branch
    svc.createSnapshot("gsd/M001/S01");

    // Verify ref exists under refs/gsd/snapshots/
    const refs = run("git for-each-ref refs/gsd/snapshots/", repo);
    assertTrue(refs.includes("refs/gsd/snapshots/gsd/M001/S01/"), "snapshot ref created under refs/gsd/snapshots/");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── createSnapshot: prefs disabled ────────────────────────────────────

  console.log("\n=== createSnapshot: disabled ===");

  {
    const repo = initBranchTestRepo();
    const svc = new GitServiceImpl(repo, { snapshots: false });

    run("git checkout -b gsd/M001/S01", repo);
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
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    run("git add -A", repo);
    run('git commit -m "add package.json"', repo);

    const svc = new GitServiceImpl(repo, { pre_merge_check: true });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assertEq(result.passed, true, "runPreMergeCheck returns passed:true when tests pass");
    assertTrue(!result.skipped, "runPreMergeCheck is not skipped when enabled");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── runPreMergeCheck: fail ────────────────────────────────────────────

  console.log("\n=== runPreMergeCheck: fail ===");

  {
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

    assertEq(result.passed, false, "runPreMergeCheck returns passed:false when tests fail");
    assertTrue(!result.skipped, "runPreMergeCheck is not skipped when enabled");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── runPreMergeCheck: disabled ────────────────────────────────────────

  console.log("\n=== runPreMergeCheck: disabled ===");

  {
    const repo = initBranchTestRepo();
    createFile(repo, "package.json", JSON.stringify({
      name: "test-disabled",
      scripts: { test: 'node -e "process.exit(1)"' },
    }));
    run("git add -A", repo);
    run('git commit -m "add package.json"', repo);

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
    const svc = new GitServiceImpl(repo, { pre_merge_check: 'node -e "process.exit(0)"' });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assertEq(result.passed, true, "runPreMergeCheck passes with custom command that exits 0");
    assertTrue(!result.skipped, "custom command is not skipped");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── VALID_BRANCH_NAME regex ──────────────────────────────────────────

  console.log("\n=== VALID_BRANCH_NAME regex ===");

  {
    // Valid branch names
    assertTrue(VALID_BRANCH_NAME.test("main"), "VALID_BRANCH_NAME accepts 'main'");
    assertTrue(VALID_BRANCH_NAME.test("master"), "VALID_BRANCH_NAME accepts 'master'");
    assertTrue(VALID_BRANCH_NAME.test("develop"), "VALID_BRANCH_NAME accepts 'develop'");
    assertTrue(VALID_BRANCH_NAME.test("feature/foo"), "VALID_BRANCH_NAME accepts 'feature/foo'");
    assertTrue(VALID_BRANCH_NAME.test("release-1.0"), "VALID_BRANCH_NAME accepts 'release-1.0'");
    assertTrue(VALID_BRANCH_NAME.test("my_branch"), "VALID_BRANCH_NAME accepts 'my_branch'");
    assertTrue(VALID_BRANCH_NAME.test("v2.0.1"), "VALID_BRANCH_NAME accepts 'v2.0.1'");

    // Invalid / injection attempts
    assertTrue(!VALID_BRANCH_NAME.test("main; rm -rf /"), "VALID_BRANCH_NAME rejects shell injection");
    assertTrue(!VALID_BRANCH_NAME.test("main && echo pwned"), "VALID_BRANCH_NAME rejects && injection");
    assertTrue(!VALID_BRANCH_NAME.test(""), "VALID_BRANCH_NAME rejects empty string");
    assertTrue(!VALID_BRANCH_NAME.test("branch name"), "VALID_BRANCH_NAME rejects spaces");
    assertTrue(!VALID_BRANCH_NAME.test("branch`cmd`"), "VALID_BRANCH_NAME rejects backticks");
    assertTrue(!VALID_BRANCH_NAME.test("branch$(cmd)"), "VALID_BRANCH_NAME rejects $() subshell");
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
    assertTrue(true, "PreMergeCheckResult type exported and usable");
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

  // ─── writeIntegrationBranch: updates when branch changes (#300) ──────

  console.log("\n=== Integration branch: updates on branch change ===");

  {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "f-123-first");
    writeIntegrationBranch(repo, "M001", "f-456-second"); // updates to new branch (#300)

    assertEq(readIntegrationBranch(repo, "M001"), "f-456-second", "second write updates integration branch to new value");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── writeIntegrationBranch: same branch is idempotent ─────────────────

  console.log("\n=== Integration branch: same branch is idempotent ===");

  {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "f-123-first");
    writeIntegrationBranch(repo, "M001", "f-123-first"); // same branch — no-op

    assertEq(readIntegrationBranch(repo, "M001"), "f-123-first", "same branch write is idempotent");

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

  // ─── resolveMilestoneIntegrationBranch: recorded branch wins when it exists ───

  console.log("\n=== Integration branch: resolver prefers recorded branch ===");

  {
    const repo = initBranchTestRepo();
    run("git checkout -b feature/live", repo);
    run("git checkout main", repo);
    writeIntegrationBranch(repo, "M001", "feature/live");

    const resolved = resolveMilestoneIntegrationBranch(repo, "M001");
    assertEq(resolved.status, "recorded", "resolver reports recorded branch when metadata branch exists");
    assertEq(resolved.recordedBranch, "feature/live", "resolver includes recorded branch");
    assertEq(resolved.effectiveBranch, "feature/live", "resolver uses recorded branch as effective branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── resolveMilestoneIntegrationBranch: falls back to detected default ────────

  console.log("\n=== Integration branch: resolver falls back to detected default ===");

  {
    const repo = initBranchTestRepo();
    writeIntegrationBranch(repo, "M001", "deleted-branch");

    const resolved = resolveMilestoneIntegrationBranch(repo, "M001");
    assertEq(resolved.status, "fallback", "resolver reports fallback when recorded branch is stale");
    assertEq(resolved.recordedBranch, "deleted-branch", "resolver preserves stale recorded branch for diagnostics");
    assertEq(resolved.effectiveBranch, "main", "resolver falls back to detected default branch");
    assertTrue(
      resolved.reason.includes("deleted-branch") && resolved.reason.includes("main"),
      "resolver reason mentions stale recorded branch and fallback branch",
    );

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── resolveMilestoneIntegrationBranch: configured main_branch is fallback ─────

  console.log("\n=== Integration branch: resolver uses configured fallback branch ===");

  {
    const repo = initBranchTestRepo();
    run("git checkout -b trunk", repo);
    run("git checkout main", repo);
    writeIntegrationBranch(repo, "M001", "deleted-branch");

    const resolved = resolveMilestoneIntegrationBranch(repo, "M001", { main_branch: "trunk" });
    assertEq(resolved.status, "fallback", "resolver reports fallback when using configured main_branch");
    assertEq(resolved.effectiveBranch, "trunk", "resolver prefers configured main_branch as fallback");
    assertTrue(
      resolved.reason.includes("deleted-branch") && resolved.reason.includes("trunk"),
      "configured fallback reason mentions stale branch and configured branch",
    );

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
    assertTrue(trackedBefore.includes("completed-units.json"), "untrack: precondition — completed-units tracked");
    assertTrue(trackedBefore.includes("metrics.json"), "untrack: precondition — metrics tracked");

    // Run untrackRuntimeFiles
    untrackRuntimeFiles(repo);

    // Runtime files should be removed from the index
    const trackedAfter = run("git ls-files .gsd/", repo);
    assertEq(trackedAfter, "", "untrack: all runtime files removed from index");

    // Non-runtime files remain tracked
    const srcTracked = run("git ls-files src.ts", repo);
    assertTrue(srcTracked.includes("src.ts"), "untrack: non-runtime files remain tracked");

    // Files still exist on disk
    assertTrue(existsSync(join(repo, ".gsd", "completed-units.json")),
      "untrack: completed-units.json still on disk");
    assertTrue(existsSync(join(repo, ".gsd", "metrics.json")),
      "untrack: metrics.json still on disk");

    // Idempotent — running again doesn't error
    untrackRuntimeFiles(repo);
    assertTrue(true, "untrack: second call is idempotent (no error)");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── smartStage excludes runtime files but allows milestone artifacts ──

  console.log("\n=== smartStage excludes runtime files, allows milestone artifacts ===");

  {
    const repo = mkdtempSync(join(tmpdir(), "gsd-smart-stage-excludes-"));
    run("git init -b main", repo);
    run("git config user.email test@test.com", repo);
    run("git config user.name Test", repo);
    writeFileSync(join(repo, "README.md"), "init");
    run("git add -A && git commit -m init", repo);

    // Create .gsd/ runtime files + milestone artifacts + a normal source file
    mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "activity"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestones", "M001", "ROADMAP.md"), "# Roadmap");
    writeFileSync(join(repo, ".gsd", "preferences.md"), "---\nversion: 1\n---");
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# State");
    writeFileSync(join(repo, ".gsd", "runtime", "units.json"), "{}");
    writeFileSync(join(repo, ".gsd", "activity", "log.jsonl"), "{}");
    writeFileSync(join(repo, "src.ts"), "const x = 1;");

    // smartStage excludes only runtime paths, not all of .gsd/ (#1326)
    const svc = new GitServiceImpl(repo);
    const msg = svc.commit({ message: "test commit" });
    assertTrue(msg !== null, "smartStage: commit succeeds");

    const committed = run("git show --name-only HEAD", repo);
    assertTrue(committed.includes("src.ts"), "smartStage: source files ARE in commit");
    // Runtime files should NOT be committed
    assertTrue(!committed.includes(".gsd/STATE.md"), "smartStage: STATE.md excluded (runtime)");
    assertTrue(!committed.includes(".gsd/runtime/"), "smartStage: runtime/ excluded");
    assertTrue(!committed.includes(".gsd/activity/"), "smartStage: activity/ excluded");
    // Milestone artifacts SHOULD be committed when not gitignored (#1326)
    assertTrue(committed.includes(".gsd/milestones/"), "smartStage: milestone artifacts ARE committed");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── writeIntegrationBranch: no commit (metadata in external storage) ──

  console.log("\n=== writeIntegrationBranch: no commit ===");

  {
    const repo = initBranchTestRepo();
    const commitsBefore = run("git rev-list --count HEAD", repo);

    writeIntegrationBranch(repo, "M001", "f-123-new-thing");

    // File should still be written to disk
    assertEq(readIntegrationBranch(repo, "M001"), "f-123-new-thing",
      "writeIntegrationBranch: metadata file exists on disk");

    // No commit — .gsd/ is managed externally
    const commitsAfter = run("git rev-list --count HEAD", repo);
    assertEq(commitsBefore, commitsAfter,
      "writeIntegrationBranch: no git commit created for integration branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── ensureGitignore: always adds .gsd to gitignore ──────────────────

  console.log("\n=== ensureGitignore: adds .gsd entry ===");

  {
    const { ensureGitignore } = await import("../gitignore.ts");
    const repo = mkdtempSync(join(tmpdir(), "gsd-gitignore-external-state-"));

    // Should add .gsd to gitignore (external state dir is a symlink)
    const modified = ensureGitignore(repo);
    assertTrue(modified, "ensureGitignore: gitignore was modified");

    const { readFileSync } = await import("node:fs");
    const content = readFileSync(join(repo, ".gitignore"), "utf-8");
    const lines = content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    assertTrue(lines.includes(".gsd"), "ensureGitignore: .gitignore contains .gsd");

    // Idempotent — calling again doesn't add duplicates
    const modified2 = ensureGitignore(repo);
    assertTrue(!modified2, "ensureGitignore: second call is idempotent");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── nativeAddAllWithExclusions: symlinked .gsd fallback ───────────────

  console.log("\n=== nativeAddAllWithExclusions: symlinked .gsd fallback ===");

  {
    // When .gsd is a symlink, git rejects `:!.gsd/...` pathspecs with
    // "fatal: pathspec '...' is beyond a symbolic link". The fix falls
    // back to plain `git add -A`, which respects .gitignore.
    const repo = initTempRepo();

    // Create the real .gsd directory outside the repo, then symlink it
    const externalGsd = mkdtempSync(join(tmpdir(), "gsd-external-"));
    mkdirSync(join(externalGsd, "activity"), { recursive: true });
    writeFileSync(join(externalGsd, "activity", "log.jsonl"), "log data");
    writeFileSync(join(externalGsd, "STATE.md"), "# State");

    // Symlink .gsd -> external directory
    symlinkSync(externalGsd, join(repo, ".gsd"));

    // Add .gitignore so git add -A fallback skips .gsd/
    writeFileSync(join(repo, ".gitignore"), ".gsd\n");

    // Create a real file that should be staged
    createFile(repo, "src/app.ts", "export const x = 1;");

    // nativeAddAllWithExclusions should NOT throw despite .gsd being a symlink
    let threw = false;
    try {
      nativeAddAllWithExclusions(repo, RUNTIME_EXCLUSION_PATHS);
    } catch (e) {
      threw = true;
      console.error("  unexpected error:", e);
    }
    assertTrue(!threw, "nativeAddAllWithExclusions does not throw with symlinked .gsd");

    // Verify the real file was staged
    const staged = run("git diff --cached --name-only", repo);
    assertTrue(staged.includes("src/app.ts"), "real file staged despite symlinked .gsd");
    assertTrue(!staged.includes(".gsd"), ".gsd content not staged");

    rmSync(repo, { recursive: true, force: true });
    rmSync(externalGsd, { recursive: true, force: true });
  }

  // ─── nativeAddAllWithExclusions: non-symlinked .gsd still works ───────

  console.log("\n=== nativeAddAllWithExclusions: non-symlinked .gsd still works ===");

  {
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
    assertTrue(!threw, "nativeAddAllWithExclusions works with normal .gsd directory");

    const staged = run("git diff --cached --name-only", repo);
    assertTrue(staged.includes("src/code.ts"), "real file staged with normal .gsd");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── MergeConflictError: constructor fields ───────────────────────────────

  console.log("\n=== MergeConflictError: constructor fields ===");
  {
    const err = new MergeConflictError(
      ["src/foo.ts", "src/bar.ts"],
      "squash",
      "gsd/M001/S01",
      "main",
    );
    assertEq(err.conflictedFiles, ["src/foo.ts", "src/bar.ts"], "MergeConflictError.conflictedFiles populated");
    assertEq(err.strategy, "squash", "MergeConflictError.strategy set");
    assertEq(err.branch, "gsd/M001/S01", "MergeConflictError.branch set");
    assertEq(err.mainBranch, "main", "MergeConflictError.mainBranch set");
    assertEq(err.name, "MergeConflictError", "MergeConflictError.name is MergeConflictError");
    assertTrue(err.message.includes("src/foo.ts"), "MergeConflictError message lists conflicted files");
    assertTrue(err.message.toLowerCase().includes("squash"), "MergeConflictError message mentions strategy");
    assertTrue(err instanceof MergeConflictError, "MergeConflictError is an instanceof MergeConflictError");
    assertTrue(err instanceof Error, "MergeConflictError is an Error instance");
  }

  // ─── Integration branch: rejects gsd/quick/* branches ────────────────────

  console.log("\n=== Integration branch: rejects gsd/quick/* branches ===");
  {
    const repo = initBranchTestRepo();

    writeIntegrationBranch(repo, "M001", "gsd/quick/1234-some-task");
    assertEq(readIntegrationBranch(repo, "M001"), null, "gsd/quick/* branches are not recorded as integration branch");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── Integration branch: resolver returns missing when no metadata ────────

  console.log("\n=== Integration branch: resolver returns missing when no metadata ===");
  {
    const repo = initBranchTestRepo();

    // No writeIntegrationBranch call — no metadata file exists
    const resolved = resolveMilestoneIntegrationBranch(repo, "M999");
    assertEq(resolved.status, "missing", "resolver reports missing when no metadata file");
    assertEq(resolved.recordedBranch, null, "resolver recordedBranch is null when no metadata");
    assertEq(resolved.effectiveBranch, null, "resolver effectiveBranch is null when no metadata");
    assertTrue(resolved.reason.includes("M999"), "resolver reason mentions the milestone ID");

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── Integration branch: resolver missing when both recorded and configured branches gone ───

  console.log("\n=== Integration branch: resolver missing when both recorded and configured branches gone ===");
  {
    const repo = initBranchTestRepo();

    // Record a branch that doesn't exist
    writeIntegrationBranch(repo, "M001", "deleted-feature");
    // configured main_branch also doesn't exist
    const resolved = resolveMilestoneIntegrationBranch(repo, "M001", { main_branch: "nonexistent-branch" });
    assertEq(resolved.status, "missing", "resolver reports missing when recorded branch and configured main_branch both absent");
    assertEq(resolved.recordedBranch, "deleted-feature", "resolver preserves stale recorded branch");
    assertEq(resolved.effectiveBranch, null, "resolver effectiveBranch is null when no safe fallback");
    assertTrue(
      resolved.reason.includes("deleted-feature") && resolved.reason.includes("nonexistent-branch"),
      "reason mentions both stale branch and unavailable configured branch",
    );

    rmSync(repo, { recursive: true, force: true });
  }

  // ─── buildTaskCommitMessage: issueNumber appends Resolves trailer ─────────

  console.log("\n=== buildTaskCommitMessage: issueNumber appends Resolves trailer ===");
  {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T03",
      taskTitle: "fix login redirect",
      issueNumber: 42,
    });
    assertTrue(msg.includes("Resolves #42"), "buildTaskCommitMessage includes Resolves #N trailer when issueNumber is set");
    assertTrue(msg.startsWith("fix(S01/T03):"), "buildTaskCommitMessage infers fix type");
  }

  {
    // No issueNumber — no Resolves trailer
    const msg = buildTaskCommitMessage({
      taskId: "S01/T04",
      taskTitle: "add dashboard widget",
    });
    assertTrue(!msg.includes("Resolves"), "buildTaskCommitMessage omits Resolves trailer when issueNumber is absent");
  }

  // ─── runPreMergeCheck: skips when no package.json ────────────────────────

  console.log("\n=== runPreMergeCheck: skips when no package.json ===");
  {
    const repo = initBranchTestRepo();
    // No package.json created — auto-detect should skip gracefully
    const svc = new GitServiceImpl(repo, { pre_merge_check: true });
    const result: PreMergeCheckResult = svc.runPreMergeCheck();

    assertEq(result.passed, true, "runPreMergeCheck passes when no package.json (skip)");
    assertEq(result.skipped, true, "runPreMergeCheck skips when no package.json found");

    rmSync(repo, { recursive: true, force: true });
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
