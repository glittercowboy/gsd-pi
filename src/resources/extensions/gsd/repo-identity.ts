/**
 * GSD Repo Identity — external state directory primitives.
 *
 * Computes a stable per-repo identity hash, resolves the external
 * `~/.gsd/projects/<hash>/` state directory, and manages the
 * `<project>/.gsd → external` symlink.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");

// ─── Repo Metadata ───────────────────────────────────────────────────────────

export interface RepoMeta {
  version: number;
  hash: string;
  gitRoot: string;
  remoteUrl: string;
  createdAt: string;
}

function isRepoMeta(value: unknown): value is RepoMeta {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === "number"
    && typeof v.hash === "string"
    && typeof v.gitRoot === "string"
    && typeof v.remoteUrl === "string"
    && typeof v.createdAt === "string";
}

/**
 * Write (or refresh) repo metadata into the external state directory.
 * Called on open so metadata tracks repo path moves while keeping createdAt stable.
 * Non-fatal: a metadata write failure must never block project setup.
 */
function writeRepoMeta(externalPath: string, remoteUrl: string, gitRoot: string): void {
  const metaPath = join(externalPath, "repo-meta.json");
  try {
    let createdAt = new Date().toISOString();
    let existing: RepoMeta | null = null;
    if (existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(readFileSync(metaPath, "utf-8"));
        if (isRepoMeta(parsed)) {
          existing = parsed;
          createdAt = parsed.createdAt;
          // Fast path: nothing changed.
          if (
            parsed.version === 1
            && parsed.hash === basename(externalPath)
            && parsed.gitRoot === gitRoot
            && parsed.remoteUrl === remoteUrl
          ) {
            return;
          }
        }
      } catch {
        // Fall through and rewrite invalid metadata.
      }
    }

    const meta: RepoMeta = {
      version: 1,
      hash: basename(externalPath),
      gitRoot,
      remoteUrl,
      createdAt,
    };
    // Keep file format stable even when refreshing.
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  } catch {
    // Non-fatal — metadata write failure should not block project setup
  }
}

/**
 * Read repo metadata from the external state directory.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readRepoMeta(externalPath: string): RepoMeta | null {
  const metaPath = join(externalPath, "repo-meta.json");
  try {
    if (!existsSync(metaPath)) return null;
    const raw = readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw);
    return isRepoMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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

function resolveGitCommonDir(basePath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return resolve(basePath, raw);
  }
}

function resolveGitRoot(basePath: string): string {
  try {
    const commonDir = resolveGitCommonDir(basePath);
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
 * Validate a GSD_PROJECT_ID value.
 *
 * Must contain only alphanumeric characters, hyphens, and underscores.
 * Call this once at startup so the user gets immediate feedback on bad values.
 */
export function validateProjectId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Compute a stable identity for a repository.
 *
 * If `GSD_PROJECT_ID` is set, returns it directly (validation is expected
 * to have already happened at startup via `validateProjectId`).
 *
 * Otherwise returns SHA-256 of `${remoteUrl}\n${resolvedRoot}`, truncated
 * to 12 hex chars. Deterministic: same repo always produces the same hash
 * regardless of which worktree the caller is inside.
 */
export function repoIdentity(basePath: string): string {
  const projectId = process.env.GSD_PROJECT_ID;
  if (projectId) {
    return projectId;
  }
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
  const base = process.env.GSD_STATE_DIR || gsdHome;
  return join(base, "projects", repoIdentity(basePath));
}

/**
 * Resolve the root directory that stores project-scoped external state.
 * Honors GSD_STATE_DIR override before falling back to GSD_HOME.
 */
export function externalProjectsRoot(): string {
  const base = process.env.GSD_STATE_DIR || gsdHome;
  return join(base, "projects");
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

  // Write repo metadata once so cleanup commands can identify this directory later.
  writeRepoMeta(externalPath, getRemoteUrl(projectPath), resolveGitRoot(projectPath));

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
