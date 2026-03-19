/**
 * GSD Repo Identity — external state directory primitives.
 *
 * Computes a stable per-repo identity hash, resolves the external
 * `~/.gsd/projects/<hash>/` state directory, and manages the
 * `<project>/.gsd → external` symlink.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
function canonicalizeExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function resolveGitRoot(basePath: string): string {
  try {
    // First: inspect the local .git entry directly. In git worktrees this is
    // a file with a `gitdir:` pointer to <repo>/.git/worktrees/<name>, which
    // lets us recover the main repo root without depending on git's path
    // formatting behavior across platforms.
    const gitPath = join(basePath, ".git");
    try {
      const stat = lstatSync(gitPath);
      if (stat.isFile()) {
        const content = readFileSync(gitPath, "utf-8").trim();
        if (content.startsWith("gitdir:")) {
          const gitdir = resolve(basePath, content.slice(7).trim());
          const normalized = gitdir.replaceAll("\\", "/");
          const marker = "/.git/worktrees/";
          if (normalized.includes(marker)) {
            return canonicalizeExistingPath(resolve(gitdir, "..", "..", ".."));
          }
        }
      }
    } catch {
      // Fall through to git-based detection.
    }

    // Prefer the shared git directory because it identifies the main repo root
    // for both normal repos and worktrees. Git may return this as a relative
    // path (e.g. ".git" or "../../.git") or as an absolute path.
    const commonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    const commonDir = resolve(basePath, commonDirRaw);
    const normalizedCommonDir = commonDir.replaceAll("\\", "/");

    // Normal repo or worktree with shared common dir pointing at <repo>/.git.
    if (normalizedCommonDir.endsWith("/.git")) {
      return canonicalizeExistingPath(resolve(commonDir, ".."));
    }

    // Some git setups may still expose <repo>/.git/worktrees/<name>.
    const worktreeMarker = "/.git/worktrees/";
    if (normalizedCommonDir.includes(worktreeMarker)) {
      return canonicalizeExistingPath(resolve(commonDir, "..", ".."));
    }

    // Fallback for unusual layouts.
    return canonicalizeExistingPath(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim());
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
  const inWorktree = isInsideWorktree(projectPath);

  // Ensure external directory exists
  mkdirSync(externalPath, { recursive: true });

  const replaceWithSymlink = (): string => {
    rmSync(localGsd, { recursive: true, force: true });
    symlinkSync(externalPath, localGsd, "junction");
    return externalPath;
  };

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
      // In a worktree, mismatched symlinks are always stale. Heal them so
      // the worktree points at the same external state dir as the main repo.
      if (inWorktree) {
        return replaceWithSymlink();
      }
      // Outside worktrees, preserve custom overrides or legacy symlinks.
      return target;
    }

    if (stat.isDirectory()) {
      // Real directory in the main repo — migration will handle this later.
      // In worktrees, keep the directory in place and let syncGsdStateToWorktree
      // refresh its contents. Replacing a git-tracked .gsd directory with a
      // symlink makes git think tracked planning files were deleted.
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
