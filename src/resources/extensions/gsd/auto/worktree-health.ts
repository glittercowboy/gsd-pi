/**
 * Worktree health check — validates a working directory before dispatching work (#1833, #1843, #2347).
 *
 * A broken worktree causes agents to hallucinate summaries since they cannot
 * read or write any files. This check verifies the directory is a valid git
 * checkout with project files before dispatching work.
 */

import { join, dirname, parse as parsePath } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { PROJECT_FILES } from "../detection.js";

export type WorktreeHealthResult =
  | { status: "ok" }
  | { status: "no-git"; message: string }
  | { status: "greenfield"; message: string };

/**
 * Check whether a directory looks like a valid project worktree.
 *
 * @param basePath — the directory to check
 * @param exists — injectable existsSync for testing
 * @returns health status with message if problematic
 */
export function checkWorktreeHealth(
  basePath: string,
  exists: (p: string) => boolean = existsSync,
): WorktreeHealthResult {
  // Hard fail: no .git means this isn't a git checkout at all
  if (!exists(join(basePath, ".git"))) {
    return { status: "no-git", message: `${basePath} has no .git` };
  }

  // Check for project files in the directory itself
  const hasProjectFile = PROJECT_FILES.some((f) => exists(join(basePath, f)));
  if (hasProjectFile) return { status: "ok" };

  // Check for src/ directory
  if (exists(join(basePath, "src"))) return { status: "ok" };

  // Xcode bundles have project-specific names — scan by suffix
  try {
    const entries = exists(basePath) ? readdirSync(basePath) : [];
    if (entries.some((e: string) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"))) {
      return { status: "ok" };
    }
  } catch {
    // scan failed, continue
  }

  // Monorepo support (#2347): walk parent directories up to .git boundary
  let checkDir = dirname(basePath);
  const { root } = parsePath(checkDir);
  while (checkDir !== root) {
    if (exists(join(checkDir, ".git"))) break;
    if (PROJECT_FILES.some((f) => exists(join(checkDir, f)))) {
      return { status: "ok" };
    }
    checkDir = dirname(checkDir);
  }

  // Greenfield — no project files anywhere, but .git exists so it's a valid checkout
  return {
    status: "greenfield",
    message: `${basePath} has no recognized project files — proceeding as greenfield project`,
  };
}
