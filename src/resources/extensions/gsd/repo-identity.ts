/**
 * GSD Repo Identity — external state directory primitives.
 *
 * Computes a stable per-repo identity hash, resolves the external
 * `~/.gsd/projects/<hash>/` state directory, and manages the
 * `<project>/.gsd → external` symlink.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

// ─── Inherited-Repo Detection ───────────────────────────────────────────────

/**
 * Check whether `basePath` is inheriting a parent directory's git repo
 * rather than being the git root itself.
 *
 * Returns true when ALL of:
 *   1. basePath is inside a git repo (git rev-parse succeeds)
 *   2. The resolved git root is a proper ancestor of basePath
 *   3. There is no *project* `.gsd` directory at the git root or any
 *      intermediate ancestor (the parent project has not been
 *      initialised with GSD)
 *
 * When true, the caller should run `git init` at basePath so that
 * `repoIdentity()` produces a hash unique to this directory, preventing
 * cross-project state leaks (#1639).
 *
 * When the git root already has a project `.gsd`, the directory is a
 * legitimate subdirectory of an existing GSD project — `cd src/ && /gsd`
 * should still load the parent project's milestones.
 */
export function isInheritedRepo(basePath: string): boolean {
  try {
    const root = resolveGitRoot(basePath);
    const normalizedBase = canonicalizeExistingPath(basePath);
    const normalizedRoot = canonicalizeExistingPath(root);
    if (normalizedBase === normalizedRoot) return false; // basePath IS the root

    // The git root is a proper ancestor. Check whether it already has .gsd
    // (i.e. the parent project was initialised with GSD).
    if (isProjectGsd(join(root, ".gsd"))) return false;

    // Walk up from basePath's parent to the git root checking for .gsd.
    // Start at dirname(normalizedBase), NOT normalizedBase itself — finding
    // .gsd at basePath means GSD state is set up for THIS project, which
    // says nothing about whether the git repo is inherited from an ancestor.
    let dir = dirname(normalizedBase);
    while (dir !== normalizedRoot && dir !== dirname(dir)) {
      if (isProjectGsd(join(dir, ".gsd"))) return false;
      dir = dirname(dir);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Distinguish a *project* `.gsd` from the global `~/.gsd` state directory.
 *
 * A project `.gsd` is either:
 *   - A symlink to an external state directory (normal post-migration layout)
 *   - A legacy real directory that is NOT the global GSD home
 *
 * When the user's home directory is itself a git repo (e.g. dotfile managers),
 * `~/.gsd` exists but is the global state directory — not a project `.gsd`.
 * Treating it as a project `.gsd` would cause isInheritedRepo() to wrongly
 * conclude that subdirectories are part of the home "project" (#2393).
 */
function isProjectGsd(gsdPath: string): boolean {
  if (!existsSync(gsdPath)) return false;

  try {
    const stat = lstatSync(gsdPath);

    // Symlinks are always project .gsd (created by ensureGsdSymlink).
    if (stat.isSymbolicLink()) return true;

    // For real directories, check that this isn't the global GSD home.
    // Recompute gsdHome dynamically so env overrides (GSD_HOME) are
    // picked up at call time, not just at module load time.
    if (stat.isDirectory()) {
      const currentGsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
      const normalizedGsdPath = canonicalizeExistingPath(gsdPath);
      const normalizedGsdHome = canonicalizeExistingPath(currentGsdHome);
      if (normalizedGsdPath === normalizedGsdHome) return false;
      return true;
    }
  } catch {
    // lstat failed — treat as no .gsd present
  }

  return false;
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
    // Use native realpath on Windows to resolve 8.3 short paths (e.g. RUNNER~1)
    return process.platform === "win32" ? realpathSync.native(path) : realpathSync(path);
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
 * For repos with a remote URL, returns SHA-256 of the remote URL only —
 * this makes the identity stable across directory moves/renames (#2750).
 *
 * For local-only repos (no remote), includes the git root in the hash.
 * Local repos use a `.gsd-id` marker file for recovery after moves.
 *
 * Deterministic: same repo always produces the same hash regardless of
 * which worktree the caller is inside.
 */
export function repoIdentity(basePath: string): string {
  const projectId = process.env.GSD_PROJECT_ID;
  if (projectId) {
    return projectId;
  }
  const remoteUrl = getRemoteUrl(basePath);
  if (remoteUrl) {
    // Remote URL alone uniquely identifies the repo — path is redundant.
    // This makes moves transparent for repos with remotes (#2750).
    return createHash("sha256").update(remoteUrl).digest("hex").slice(0, 12);
  }
  // Local-only repo: include git root since there's no remote to anchor identity.
  const root = resolveGitRoot(basePath);
  const input = `\n${root}`;
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

// ─── Numbered Variant Cleanup ────────────────────────────────────────────────

/**
 * macOS collision pattern: `.gsd 2`, `.gsd 3`, `.gsd 4`, etc.
 *
 * When `symlinkSync` (or Finder) tries to create `.gsd` but a real directory
 * already exists at that path, macOS APFS silently renames the new entry to
 * `.gsd 2`, then `.gsd 3`, and so on. These numbered variants confuse GSD
 * because the canonical `.gsd` path no longer resolves to the external state
 * directory, making tracked planning files appear deleted.
 *
 * This helper scans the project root for entries matching `.gsd <digits>` and
 * removes them. It is called early in `ensureGsdSymlink()` so that the
 * canonical `.gsd` path is always the one in use.
 */
const GSD_NUMBERED_VARIANT_RE = /^\.gsd \d+$/;

export function cleanNumberedGsdVariants(projectPath: string): string[] {
  const removed: string[] = [];
  try {
    const entries = readdirSync(projectPath);
    for (const entry of entries) {
      if (GSD_NUMBERED_VARIANT_RE.test(entry)) {
        const fullPath = join(projectPath, entry);
        try {
          rmSync(fullPath, { recursive: true, force: true });
          removed.push(entry);
        } catch {
          // Best-effort: if removal fails (e.g. permissions), continue with next
        }
      }
    }
  } catch {
    // Non-fatal: readdir failure should not block symlink creation
  }
  return removed;
}

// ─── .gsd-id Marker ─────────────────────────────────────────────────────────

/**
 * Write a `.gsd-id` marker file in the project root.
 *
 * This file records the identity hash used for the external state directory.
 * For local-only repos (no remote), this marker survives directory moves and
 * enables automatic recovery of orphaned state (#2750).
 *
 * The marker is gitignored by ensureGitignore(). Non-fatal: failure to write
 * the marker must never block project setup.
 */
function writeGsdIdMarker(projectPath: string, identity: string): void {
  try {
    const markerPath = join(projectPath, ".gsd-id");
    // Only write if content differs to avoid unnecessary disk writes.
    if (existsSync(markerPath)) {
      try {
        if (readFileSync(markerPath, "utf-8").trim() === identity) return;
      } catch { /* fall through and overwrite */ }
    }
    writeFileSync(markerPath, identity + "\n", "utf-8");
  } catch {
    // Non-fatal — marker write failure should not block project setup
  }
}

/**
 * Read the `.gsd-id` marker from the project root.
 * Returns the identity hash, or null if the marker doesn't exist or is unreadable.
 */
function readGsdIdMarker(projectPath: string): string | null {
  try {
    const markerPath = join(projectPath, ".gsd-id");
    if (!existsSync(markerPath)) return null;
    const content = readFileSync(markerPath, "utf-8").trim();
    return /^[a-zA-Z0-9_-]+$/.test(content) ? content : null;
  } catch {
    return null;
  }
}

/**
 * Check whether an external state directory has meaningful content.
 * Returns true if the directory contains any files or subdirectories
 * beyond just repo-meta.json.
 */
function hasProjectState(externalPath: string): boolean {
  try {
    if (!existsSync(externalPath)) return false;
    const entries = readdirSync(externalPath);
    return entries.some(e => e !== "repo-meta.json");
  } catch {
    return false;
  }
}

/**
 * Resolve the external state directory, with recovery for relocated projects.
 *
 * For local-only repos where the computed identity produces an empty state dir,
 * checks the `.gsd-id` marker for the original identity hash and recovers
 * the old state directory if it still exists and contains data (#2750).
 *
 * Returns the resolved external path (may differ from the computed identity).
 */
function resolveExternalPathWithRecovery(projectPath: string): string {
  const computedPath = externalGsdRoot(projectPath);
  const computedId = repoIdentity(projectPath);

  // Check if computed path already has state — fast path, no recovery needed.
  if (hasProjectState(computedPath)) {
    return computedPath;
  }

  // Check for .gsd-id marker from a previous location.
  const markerId = readGsdIdMarker(projectPath);
  if (markerId && markerId !== computedId) {
    // The marker points to a different identity — the repo was likely moved.
    const base = process.env.GSD_STATE_DIR || gsdHome;
    const markerPath = join(base, "projects", markerId);
    if (hasProjectState(markerPath)) {
      // Recover: use the old state directory and update the marker to the new identity.
      // Move the state from the old hash dir to the new one so future lookups work
      // without the marker.
      try {
        mkdirSync(computedPath, { recursive: true });
        const entries = readdirSync(markerPath);
        for (const entry of entries) {
          try {
            const src = join(markerPath, entry);
            const dst = join(computedPath, entry);
            // Use rename for same-filesystem (fast) or fall back to copy.
            try {
              renameSync(src, dst);
            } catch {
              cpSync(src, dst, { recursive: true, force: true });
            }
          } catch { /* continue with remaining entries */ }
        }
        // Clean up old directory after successful migration.
        try { rmSync(markerPath, { recursive: true, force: true }); } catch { /* non-fatal */ }
      } catch {
        // If migration fails, just point at the old directory.
        return markerPath;
      }
    }
  }

  return computedPath;
}

// ─── Symlink Management ─────────────────────────────────────────────────────

/**
 * Ensure the `<project>/.gsd` symlink points to the external state directory.
 *
 * 1. Clean up any macOS numbered collision variants (`.gsd 2`, `.gsd 3`, etc.)
 * 2. Resolve external dir (with relocation recovery via `.gsd-id` marker)
 * 3. mkdir -p the external dir
 * 4. If `<project>/.gsd` doesn't exist → create symlink
 * 5. If `<project>/.gsd` is already the correct symlink → no-op
 * 6. If `<project>/.gsd` is a real directory → return as-is (migration handles later)
 * 7. Write `.gsd-id` marker for future relocation recovery
 *
 * Returns the resolved external path.
 */
export function ensureGsdSymlink(projectPath: string): string {
  const result = ensureGsdSymlinkCore(projectPath);

  // Write .gsd-id marker so future relocations can recover this state (#2750).
  // Only write for the project root (not subdirectories or worktrees that
  // delegate to a parent .gsd).
  if (!isInsideWorktree(projectPath)) {
    writeGsdIdMarker(projectPath, repoIdentity(projectPath));
  }

  return result;
}

function ensureGsdSymlinkCore(projectPath: string): string {
  const externalPath = resolveExternalPathWithRecovery(projectPath);
  const localGsd = join(projectPath, ".gsd");
  const inWorktree = isInsideWorktree(projectPath);

  // Guard: Never create a symlink at ~/.gsd — that's the user-level GSD home,
  // not a project .gsd. This can happen if resolveProjectRoot() or
  // escapeStaleWorktree() returned ~ as the project root (#1676).
  const localGsdNormalized = localGsd.replaceAll("\\", "/");
  const gsdHomePath = gsdHome.replaceAll("\\", "/");
  if (localGsdNormalized === gsdHomePath) {
    return localGsd;
  }

  // Guard: If projectPath is a plain subdirectory (not a worktree) of a git
  // repo that already has a .gsd at the git root, do not create a duplicate
  // symlink in the subdirectory — that causes `.gsd 2` collision variants on
  // macOS (#2380). Worktrees are excluded because they legitimately need their
  // own .gsd symlink pointing at the shared external state dir.
  if (!inWorktree) {
    try {
      const gitRoot = resolveGitRoot(projectPath);
      const normalizedProject = canonicalizeExistingPath(projectPath);
      const normalizedRoot = canonicalizeExistingPath(gitRoot);
      if (normalizedProject !== normalizedRoot) {
        const rootGsd = join(gitRoot, ".gsd");
        if (existsSync(rootGsd)) {
          try {
            const rootStat = lstatSync(rootGsd);
            if (rootStat.isSymbolicLink() || rootStat.isDirectory()) {
              return rootStat.isSymbolicLink() ? realpathSync(rootGsd) : rootGsd;
            }
          } catch {
            // Fall through to normal logic if we can't stat root .gsd
          }
        }
      }
    } catch {
      // If git root detection fails, fall through to normal logic
    }
  }

  // Clean up macOS numbered collision variants (.gsd 2, .gsd 3, etc.) before
  // any existence checks — otherwise they accumulate and confuse state (#2205).
  cleanNumberedGsdVariants(projectPath);

  // Ensure external directory exists
  mkdirSync(externalPath, { recursive: true });

  // Write repo metadata once so cleanup commands can identify this directory later.
  writeRepoMeta(externalPath, getRemoteUrl(projectPath), resolveGitRoot(projectPath));

  const replaceWithSymlink = (): string => {
    rmSync(localGsd, { recursive: true, force: true });
    // Defensive: remove any residual entry (e.g. dangling symlink) before creating.
    try { unlinkSync(localGsd); } catch { /* already gone */ }
    symlinkSync(externalPath, localGsd, "junction");
    return externalPath;
  };

  // Check for dangling symlinks (e.g. after relocation recovery removed the old
  // state dir). existsSync follows symlinks, so it returns false for dangling ones.
  // lstatSync does NOT follow, so we can detect the dangling symlink and replace it.
  if (!existsSync(localGsd)) {
    try {
      const stat = lstatSync(localGsd);
      if (stat.isSymbolicLink()) {
        // Dangling symlink — replace with correct one (#2750).
        return replaceWithSymlink();
      }
    } catch {
      // lstat also failed — nothing exists at this path
    }
    // Nothing exists yet — create symlink.
    // Defensive: remove any residual entry to avoid EEXIST race (#2750).
    try { unlinkSync(localGsd); } catch { /* nothing to remove */ }
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
      // After identity hash change (e.g. upgrade from path-based to remote-only
      // hash, or relocation recovery), migrate data from old target to new path
      // and update the symlink (#2750).
      if (!hasProjectState(externalPath) && hasProjectState(target)) {
        try {
          mkdirSync(externalPath, { recursive: true });
          const oldEntries = readdirSync(target);
          for (const entry of oldEntries) {
            try {
              const src = join(target, entry);
              const dst = join(externalPath, entry);
              try { renameSync(src, dst); } catch { cpSync(src, dst, { recursive: true, force: true }); }
            } catch { /* continue */ }
          }
          try { rmSync(target, { recursive: true, force: true }); } catch { /* non-fatal */ }
          return replaceWithSymlink();
        } catch {
          // Migration failed — preserve old symlink
          return target;
        }
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
