/**
 * worktree-health-monorepo.test.ts — #2347
 *
 * The worktree health check in auto/phases.ts falsely rejects monorepos
 * where package.json (or other project markers) is in a parent directory.
 * This test verifies that the health check walks parent directories.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestContext } from "./test-helpers.ts";

const { assertTrue, report } = createTestContext();

const srcPath = join(import.meta.dirname, "..", "auto", "phases.ts");
const src = readFileSync(srcPath, "utf-8");

console.log("\n=== #2347: Worktree health check supports monorepos ===");

// ── Test 1: The health check region exists ──────────────────────────────

const healthCheckIdx = src.indexOf("Worktree health check");
assertTrue(healthCheckIdx > 0, "auto/phases.ts has worktree health check section");

const healthCheckRegion = src.slice(healthCheckIdx, healthCheckIdx + 2000);

// ── Test 2: The check walks parent directories for project markers ──────

// The fix should check parent directories for project files, not just s.basePath.
// Look for patterns like: walking up directories, dirname, parent, or a helper
// function that checks ancestors.
const checksParentDirs =
  healthCheckRegion.includes("dirname") ||
  healthCheckRegion.includes("parent") ||
  healthCheckRegion.includes("ancestor") ||
  healthCheckRegion.includes("walk") ||
  // Or a helper function that's called with the base path
  /hasProjectFileInAncestor|findProjectRoot|checkParent/i.test(healthCheckRegion);

assertTrue(
  checksParentDirs,
  "Health check should walk parent directories for project markers (monorepo support) (#2347)",
);

// ── Test 3: The parent walk stops at a .git boundary ──────────────────

// The parent directory walk must not escape the git repository root.
// Without this guard, ancestor directories like ~ or /usr/local that
// happen to contain package.json would cause false positive health checks.
const hasGitBoundary = healthCheckRegion.includes('.git') &&
  (healthCheckRegion.includes('break') || healthCheckRegion.includes('stop'));

assertTrue(
  hasGitBoundary,
  "Parent directory walk must stop at .git repository boundary to prevent false positives",
);

// ── Test 4: The greenfield warning should only trigger when no parent has markers ─

// The original code was:
//   const hasProjectFile = PROJECT_FILES.some((f) => deps.existsSync(join(s.basePath, f)));
// The fix should check parents too, so the greenfield warning only fires
// when NO ancestor directory has project markers either.
const hasParentCheck = healthCheckRegion.includes("parent") ||
  healthCheckRegion.includes("dirname") ||
  /ancestor|walk.*up/i.test(healthCheckRegion);

assertTrue(
  hasParentCheck,
  "Greenfield check should consider parent directories before warning (#2347)",
);

report();
