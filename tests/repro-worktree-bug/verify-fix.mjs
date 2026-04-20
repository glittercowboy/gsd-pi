/**
 * Verification: Fix for worktree path resolution escaping to home directory
 *
 * Tests the FIXED resolveProjectRoot() against the same scenarios that
 * reproduced the bug. Copies the fixed function logic from worktree.ts.
 */

import {
  mkdirSync,
  symlinkSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

// ── Fixed functions (copied from worktree.ts after fix) ─────────────────

function findWorktreeSegment(normalizedPath) {
  const directMarker = "/.gsd/worktrees/";
  const idx = normalizedPath.indexOf(directMarker);
  if (idx !== -1) {
    return { gsdIdx: idx, afterWorktrees: idx + directMarker.length };
  }
  const symlinkRe = /\/\.gsd\/projects\/[a-f0-9]+\/worktrees\//;
  const match = normalizedPath.match(symlinkRe);
  if (match && match.index !== undefined) {
    return {
      gsdIdx: match.index,
      afterWorktrees: match.index + match[0].length,
    };
  }
  return null;
}

function resolveProjectRootFromGitFile(worktreePath) {
  try {
    let dir = worktreePath;
    for (let i = 0; i < 10; i++) {
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) {
        const content = readFileSync(gitPath, "utf8").trim();
        if (content.startsWith("gitdir: ")) {
          const gitDir = resolve(dir, content.slice(8));
          const dotGitDir = resolve(gitDir, "..", "..");
          if (
            dotGitDir.endsWith(".git") ||
            dotGitDir.endsWith(".git/") ||
            dotGitDir.endsWith(".git\\")
          ) {
            return resolve(dotGitDir, "..");
          }
          const commonDirPath = join(gitDir, "commondir");
          if (existsSync(commonDirPath)) {
            const commonDir = readFileSync(commonDirPath, "utf8").trim();
            const resolvedCommonDir = resolve(gitDir, commonDir);
            return resolve(resolvedCommonDir, "..");
          }
        }
        break;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

function normalizePathForCompare(path) {
  let normalized;
  try {
    normalized = realpathSync(path);
  } catch {
    normalized = resolve(path);
  }
  const slashed = normalized.replaceAll("\\", "/");
  const trimmed = slashed.replace(/\/+$/, "");
  return trimmed || "/";
}

function resolveProjectRoot(basePath) {
  // Layer 1: If the coordinator passed the real project root, use it.
  if (process.env.GSD_PROJECT_ROOT) {
    return process.env.GSD_PROJECT_ROOT;
  }

  const normalizedPath = basePath.replaceAll("\\", "/");
  const seg = findWorktreeSegment(normalizedPath);
  if (!seg) return basePath;

  const sepChar = basePath.includes("\\") ? "\\" : "/";
  const gsdMarker = `${sepChar}.gsd${sepChar}`;
  const gsdIdx = basePath.indexOf(gsdMarker);
  const candidate =
    gsdIdx !== -1 ? basePath.slice(0, gsdIdx) : basePath.slice(0, seg.gsdIdx);

  // Layer 2: Guard against resolving to the user's home directory.
  const gsdHome = normalizePathForCompare(
    process.env.GSD_HOME || join(homedir(), ".gsd"),
  );
  const candidateGsdPath = normalizePathForCompare(join(candidate, ".gsd"));

  if (
    candidateGsdPath === gsdHome ||
    candidateGsdPath.startsWith(gsdHome + "/")
  ) {
    const realRoot = resolveProjectRootFromGitFile(basePath);
    if (realRoot) return realRoot;
    return basePath;
  }

  return candidate;
}

// ── Set up filesystem layout ────────────────────────────────────────────

const HASH = "abc123def456";
const TEST_ROOT = mkdtempSync(join(tmpdir(), "gsd-verify-fix-"));
const USER_GSD = process.env.GSD_HOME || join(TEST_ROOT, ".gsd");
const USER_HOME = homedir();
const PROJECT_GSD_STORAGE = `${USER_GSD}/projects/${HASH}`;
const PROJECT_DIR = mkdtempSync(join(tmpdir(), "myproject-"));
const PROJECT_GSD_LINK = `${PROJECT_DIR}/.gsd`;
const PROJECT_REAL = normalizePathForCompare(PROJECT_DIR);
const EXPECTED_BUGGY_ROOT = normalizePathForCompare(resolve(USER_GSD, ".."));

process.env.GSD_HOME = USER_GSD;

console.log("=== Setting up filesystem layout ===\n");

mkdirSync(`${PROJECT_GSD_STORAGE}/worktrees`, { recursive: true });
mkdirSync(`${PROJECT_GSD_STORAGE}/milestones`, { recursive: true });
mkdirSync(PROJECT_DIR, { recursive: true });
symlinkSync(PROJECT_GSD_STORAGE, PROJECT_GSD_LINK);

// Init git in project dir
execSync("git init -b main", { cwd: PROJECT_DIR, stdio: "pipe" });
execSync('git config user.name "Test"', { cwd: PROJECT_DIR, stdio: "pipe" });
execSync('git config user.email "test@test.com"', {
  cwd: PROJECT_DIR,
  stdio: "pipe",
});
writeFileSync(join(PROJECT_DIR, "README.md"), "hello\n");
execSync("git add -A && git commit -m init", {
  cwd: PROJECT_DIR,
  stdio: "pipe",
});

// Create a REAL git worktree (so .git file exists with gitdir pointer)
execSync("git worktree add .gsd/worktrees/M001 -b worktree/M001", {
  cwd: PROJECT_DIR,
  stdio: "pipe",
});
console.log("Created real git worktree at .gsd/worktrees/M001\n");

let passed = 0;
let failed = 0;

function test(name, actual, expected) {
  if (actual === expected) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    console.log(`     Expected: ${expected}`);
    console.log(`     Got:      ${actual}`);
    failed++;
  }
}

// ── Test 1: GSD_PROJECT_ROOT env var (Layer 1) ──────────────────────────

console.log("=== Layer 1: GSD_PROJECT_ROOT env var ===\n");

process.env.GSD_PROJECT_ROOT = PROJECT_DIR;
const resolvedPath = realpathSync(`${PROJECT_DIR}/.gsd/worktrees/M001`);
test(
  "GSD_PROJECT_ROOT overrides path resolution",
  resolveProjectRoot(resolvedPath),
  PROJECT_DIR,
);
delete process.env.GSD_PROJECT_ROOT;

// ── Test 2: Direct layout still works ────────────────────────────────────

console.log("\n=== Direct layout (no symlink collision) ===\n");

test(
  "Direct layout resolves correctly",
  resolveProjectRoot("/foo/.gsd/worktrees/M001"),
  "/foo",
);

test(
  "Non-worktree path unchanged",
  resolveProjectRoot("/some/repo"),
  "/some/repo",
);

// ── Test 3: Symlink-resolved path with git fallback (Layer 2) ────────────

console.log("\n=== Layer 2: Symlink-resolved path with git fallback ===\n");

// chdir into worktree via symlink — process.cwd() resolves symlinks
process.chdir(`${PROJECT_DIR}/.gsd/worktrees/M001`);
const workerCwd = process.cwd();
console.log(`  Worker cwd (resolved): ${workerCwd}`);
console.log(`  Expected project root: ${PROJECT_DIR}`);

const result = resolveProjectRoot(workerCwd);
console.log(`  resolveProjectRoot():  ${result}`);
test(
  "Symlink-resolved worktree path resolves to REAL project (not ~)",
  result,
  PROJECT_REAL,
);

// Verify it's NOT the home directory
test("Result is not the home directory", result !== USER_HOME, true);

// ── Test 4: Verify the git file fallback works ──────────────────────────

console.log("\n=== Git file fallback detail ===\n");

const gitFileContent = readFileSync(join(workerCwd, ".git"), "utf8").trim();
console.log(`  .git file content: ${gitFileContent}`);
const gitDirResolved = resolve(workerCwd, gitFileContent.slice(8));
console.log(`  Resolved gitdir:   ${gitDirResolved}`);
const projectFromGit = resolve(gitDirResolved, "..", "..");
console.log(`  Project from git:  ${resolve(projectFromGit, "..")}`);

const gitFallback = resolveProjectRootFromGitFile(workerCwd);
test(
  "resolveProjectRootFromGitFile returns real project",
  gitFallback,
  PROJECT_REAL,
);

// ── Test 5: Old buggy path would have returned ~ ────────────────────────

console.log("\n=== Regression guard ===\n");

// Simulate what the OLD code did:
function oldResolveProjectRoot(basePath) {
  const normalizedPath = basePath.replaceAll("\\", "/");
  const seg = findWorktreeSegment(normalizedPath);
  if (!seg) return basePath;
  const sepChar = basePath.includes("\\") ? "\\" : "/";
  const gsdMarker = `${sepChar}.gsd${sepChar}`;
  const gsdIdx = basePath.indexOf(gsdMarker);
  if (gsdIdx !== -1) return basePath.slice(0, gsdIdx);
  return basePath.slice(0, seg.gsdIdx);
}

const oldResult = oldResolveProjectRoot(workerCwd);
console.log(`  Old (buggy) code returns: ${oldResult}`);
test(
  "Old code returns parent of GSD home (confirming bug existed)",
  oldResult,
  EXPECTED_BUGGY_ROOT,
);

test("New code does NOT return home directory", result !== USER_HOME, true);

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n🔴 FIX VERIFICATION FAILED");
  process.exit(1);
} else {
  console.log("\n✅ ALL TESTS PASSED — Fix verified!");
  process.exit(0);
}
