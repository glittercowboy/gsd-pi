/**
 * GSD Repo Identity — external state directory primitives.
 *
 * Computes a stable per-repo identity hash, resolves the external
 * `~/.gsd/projects/<hash>/` state directory, and manages the
 * `<project>/.gsd → external` symlink.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

// ─── Repo Identity ──────────────────────────────────────────────────────────

/**
 * Get the git remote URL for "origin", or "" if no remote is configured.
 * Uses `git config` rather than `git remote get-url` for broader compat.
 */
function getRemoteUrl(basePath: string): string {
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Resolve the git toplevel (real root) for the given path.
 * For worktrees this returns the main repo root, not the worktree path.
 */
function resolveGitRoot(basePath: string): string {
  try {
    // In a worktree, --show-toplevel returns the worktree path, not the main
    // repo root. Use --git-common-dir to find the shared .git directory,
    // then derive the main repo root from it (#1288).
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();

    // If commonDir ends with .git/worktrees/<name>, the main repo is two
    // levels up from the worktrees dir. If it's just .git, resolve normally.
    if (commonDir.includes(`${sep}worktrees${sep}`) || commonDir.includes("/worktrees/")) {
      // e.g., /path/to/project/.gsd/worktrees/M001/.git → /path/to/project
      // or /path/to/project/.git/worktrees/M001 → /path/to/project
      const gitDir = commonDir.replace(/[/\\]worktrees[/\\][^/\\]+$/, "");
      const mainRoot = resolve(gitDir, "..");
      return mainRoot;
    }

    // Not in a worktree — use --show-toplevel as usual
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return resolve(basePath);
  }
}

/**
 * Compute a stable identity for a repository.
 *
 * SHA-256 of `${remoteUrl}\n${resolvedRoot}`, truncated to 12 hex chars.
 * Deterministic: same repo always produces the same hash regardless of
 * which worktree the caller is inside.
 */
export function repoIdentity(basePath: string): string {
  const remoteUrl = getRemoteUrl(basePath);
  const root = resolveGitRoot(basePath);
  const input = `${remoteUrl}\n${root}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

// ─── External State Directory ───────────────────────────────────────────────

/**
 * Compute the external GSD state directory for a repository.
 *
 * Returns `$GSD_STATE_DIR/projects/<hash>` if `GSD_STATE_DIR` is set,
 * otherwise `~/.gsd/projects/<hash>`.
 */
export function externalGsdRoot(basePath: string): string {
  const base = process.env.GSD_STATE_DIR || join(homedir(), ".gsd");
  return join(base, "projects", repoIdentity(basePath));
}

// ─── Symlink Management ─────────────────────────────────────────────────────

/**
 * Ensure the `<project>/.gsd` symlink points to the external state directory.
 *
 * 1. mkdir -p the external dir
 * 2. If `<project>/.gsd` doesn't exist → create symlink
 * 3. If `<project>/.gsd` is already the correct symlink → no-op
 * 4. If `<project>/.gsd` is a real directory → return as-is (migration handles later)
 *
 * Returns the resolved external path.
 */
export function ensureGsdSymlink(projectPath: string): string {
  const externalPath = externalGsdRoot(projectPath);
  const localGsd = join(projectPath, ".gsd");

  // Ensure external directory exists
  mkdirSync(externalPath, { recursive: true });

  if (!existsSync(localGsd)) {
    // Nothing exists yet — create symlink
    symlinkSync(externalPath, localGsd, "junction");
    return externalPath;
  }

  try {
    const stat = lstatSync(localGsd);

    if (stat.isSymbolicLink()) {
      // Already a symlink — verify it points to the right place
      const target = realpathSync(localGsd);
      if (target === externalPath) {
        return externalPath; // correct symlink, no-op
      }
      // Symlink exists but points elsewhere — leave it for now
      // (could be a custom override or stale symlink)
      return target;
    }

    if (stat.isDirectory()) {
      // Real directory — migration will handle this later.
      // Return the local path so existing code still works.
      return localGsd;
    }
  } catch {
    // lstat failed — path exists but we can't stat it
  }

  return localGsd;
}

// ─── Worktree Detection ─────────────────────────────────────────────────────

/**
 * Check if the given directory is a git worktree (not the main repo).
 *
 * Git worktrees have a `.git` *file* (not directory) containing a
 * `gitdir:` pointer. This is git's native worktree indicator — no
 * string marker parsing needed.
 */
export function isInsideWorktree(cwd: string): boolean {
  const gitPath = join(cwd, ".git");
  try {
    const stat = lstatSync(gitPath);
    if (!stat.isFile()) return false;
    const content = readFileSync(gitPath, "utf-8").trim();
    return content.startsWith("gitdir:");
  } catch {
    return false;
  }
}
