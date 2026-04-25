/**
 * Post-unit file change validator for auto-mode safety harness.
 * Compares actual git diff against the task plan's expected output files.
 *
 * Uses tasks.expected_output (DB column, populated from per-task ## Expected Output)
 * and tasks.files (from slice PLAN.md - Files: subline) as the expected set.
 * Compares against `git diff-tree --root --no-commit-id -r --name-only HEAD` after auto-commit.
 * Using diff-tree --root handles initial commits, shallow clones, and merge commits correctly
 * (Bug #4385 — git diff HEAD~1 failed on initial commits).
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { normalizePlannedFileReference } from "../files.js";
import { logWarning } from "../workflow-logger.js";

const _require = createRequire(import.meta.url);
type PicomatchMatcher = (input: string) => boolean;
type PicomatchFn = (pattern: string, opts?: { dot?: boolean }) => PicomatchMatcher;
const picomatch = _require("picomatch") as PicomatchFn;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileViolation {
  severity: "info" | "warning";
  file: string;
  reason: string;
}

export interface FileChangeAudit {
  expectedFiles: string[];
  actualFiles: string[];
  unexpectedFiles: string[];
  missingFiles: string[];
  violations: FileViolation[];
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate file changes after auto-commit for an execute-task unit.
 * Returns null if task data is unavailable or DB is not loaded.
 *
 * @param basePath - Working directory (worktree or project root)
 * @param expectedOutput - JSON array from tasks.expected_output DB column
 * @param plannedFiles - JSON array from tasks.files DB column
 */
export function validateFileChanges(
  basePath: string,
  expectedOutput: string[],
  plannedFiles: string[],
  fileChangeAllowlist: string[] = [],
): FileChangeAudit | null {
  const allExpected = new Set([...expectedOutput, ...plannedFiles]);

  // If no expected files were planned, skip validation
  if (allExpected.size === 0) return null;

  // Get actual changed files from last commit
  const actualFiles = getChangedFilesFromLastCommit(basePath);
  if (!actualFiles) return null;

  // Filter out .gsd/ internal files — only validate project source files
  const projectFiles = actualFiles.filter(f => !f.startsWith(".gsd/") && !f.startsWith(".gsd\\"));

  // Normalize expected paths (strip leading ./ or /)
  const normalizedExpected = new Set(
    [...allExpected].map((f) =>
      normalizePlannedFileReference(f).replace(/^\.\//, "").replace(/^\//, ""),
    ),
  );

  // Build allowlist matchers once (dot: true so patterns like `**/.hidden` work).
  const allowlistMatchers = fileChangeAllowlist.map(p => picomatch(p, { dot: true }));
  const isAllowlisted = (f: string) => allowlistMatchers.some(m => m(f));

  // Compute symmetric difference, excluding allowlisted files
  const unexpectedFiles = projectFiles.filter(f => !normalizedExpected.has(f) && !isAllowlisted(f));
  const missingFiles = [...normalizedExpected].filter(f => !projectFiles.includes(f));

  const violations: FileViolation[] = [];

  for (const f of unexpectedFiles) {
    violations.push({
      severity: "warning",
      file: f,
      reason: "Modified but not in task plan's expected output",
    });
  }

  for (const f of missingFiles) {
    violations.push({
      severity: "info",
      file: f,
      reason: "Listed in task plan but not modified",
    });
  }

  return {
    expectedFiles: [...normalizedExpected],
    actualFiles: projectFiles,
    unexpectedFiles,
    missingFiles,
    violations,
  };
}

// ─── Internals ──────────────────────────────────────────────────────────────

function getChangedFilesFromLastCommit(basePath: string): string[] | null {
  try {
    const result = execFileSync(
      "git",
      ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();
    return result ? result.split("\n").filter(Boolean) : [];
  } catch (e) {
    logWarning("safety", `git diff failed in file-change-validator: ${(e as Error).message}`);
    return null;
  }
}
