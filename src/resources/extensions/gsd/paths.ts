/**
 * GSD Paths — ID-based path resolution
 *
 * Directories use bare IDs: M001/, S01/, etc.
 * Files use ID-SUFFIX: M001-ROADMAP.md, S01-PLAN.md, T01-PLAN.md
 *
 * Resolvers still handle legacy descriptor-suffixed names
 * (e.g. M001-FLIGHT-SIMULATOR/, T03-INSTALL-PACKAGES-PLAN.md)
 * via prefix matching, so existing projects work without migration.
 */

import { readdirSync, existsSync, realpathSync, Dirent } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

// ─── Main Worktree Resolution ─────────────────────────────────────────────────

/**
 * Cache for resolveMainWorktreeRoot(). Keyed by basePath, stores the resolved
 * main worktree root (or basePath itself if not in a worktree).
 */
const mainWorktreeCache = new Map<string, string>();

/**
 * Resolve the main worktree root from any git worktree.
 *
 * When GSD runs inside a git worktree (e.g. `.gsd/worktrees/M001/`),
 * `basePath` points to the worktree root. `.gsd/` must resolve relative
 * to the **main** worktree so all worktrees share a single `.gsd/` state.
 *
 * Detects a linked worktree by comparing `git rev-parse --git-common-dir`
 * vs `--git-dir`; when they differ the main root is inferred as the parent
 * directory of `--git-common-dir` (e.g. `/repo/.git` → `/repo`).
 * Falls back to basePath on error or when not in a git repo.
 */
export function resolveMainWorktreeRoot(basePath: string): string {
  const cached = mainWorktreeCache.get(basePath);
  if (cached !== undefined) return cached;

  try {
    // git-common-dir: the shared .git object store (same for all worktrees)
    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();

    // git-dir: the per-worktree .git reference
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();

    // If git-common-dir === git-dir, we're in the main worktree already
    const resolvedCommon = resolve(basePath, gitCommonDir);
    const resolvedGitDir = resolve(basePath, gitDir);

    if (resolvedCommon === resolvedGitDir) {
      mainWorktreeCache.set(basePath, basePath);
      return basePath;
    }

    // We're in a linked worktree. The common dir is the main repo's .git/.
    // The main worktree root is one level up from the common dir
    // (e.g. /repo/.git → /repo).
    let mainRoot = resolve(resolvedCommon, "..");
    // Resolve symlinks to normalize paths (e.g. /var → /private/var on macOS)
    if (existsSync(mainRoot)) mainRoot = realpathSync(mainRoot);
    mainWorktreeCache.set(basePath, mainRoot);
    return mainRoot;
  } catch {
    // Not a git repo or git not available — fall back to basePath
    mainWorktreeCache.set(basePath, basePath);
    return basePath;
  }
}

// ─── Directory Listing Cache ──────────────────────────────────────────────────

const dirEntryCache = new Map<string, Dirent[]>();
const dirListCache = new Map<string, string[]>();

function cachedReaddirWithTypes(dirPath: string): Dirent[] {
  const cached = dirEntryCache.get(dirPath);
  if (cached) return cached;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  dirEntryCache.set(dirPath, entries);
  return entries;
}

function cachedReaddir(dirPath: string): string[] {
  const cached = dirListCache.get(dirPath);
  if (cached) return cached;
  const entries = readdirSync(dirPath);
  dirListCache.set(dirPath, entries);
  return entries;
}

/**
 * Clear the directory listing cache.
 * Call after milestone transitions, file creation in planning directories,
 * or at the start/end of a dispatch cycle.
 */
export function clearPathCache(): void {
  dirEntryCache.clear();
  dirListCache.clear();
  mainWorktreeCache.clear();
}

// ─── Name Builders ─────────────────────────────────────────────────────────

/**
 * Build a directory name from an ID.
 * ("M001") → "M001"
 */
export function buildDirName(id: string): string {
  return id;
}

/**
 * Build a milestone-level file name.
 * ("M001", "CONTEXT") → "M001-CONTEXT.md"
 */
export function buildMilestoneFileName(milestoneId: string, suffix: string): string {
  return `${milestoneId}-${suffix}.md`;
}

/**
 * Build a slice-level file name.
 * ("S01", "PLAN") → "S01-PLAN.md"
 */
export function buildSliceFileName(sliceId: string, suffix: string): string {
  return `${sliceId}-${suffix}.md`;
}

/**
 * Build a task file name.
 * ("T03", "PLAN") → "T03-PLAN.md"
 * ("T03", "SUMMARY") → "T03-SUMMARY.md"
 */
export function buildTaskFileName(taskId: string, suffix: string): string {
  return `${taskId}-${suffix}.md`;
}

// ─── Resolvers ─────────────────────────────────────────────────────────────

/**
 * Find a directory entry by ID prefix within a parent directory.
 * Exact match first (M001), then prefix match (M001-SOMETHING) for
 * backward compatibility with legacy descriptor directories.
 * Returns the full directory name or null.
 */
export function resolveDir(parentDir: string, idPrefix: string): string | null {
  if (!existsSync(parentDir)) return null;
  try {
    const entries = cachedReaddirWithTypes(parentDir);
    // Exact match first (current convention: bare ID)
    const exact = entries.find(e => e.isDirectory() && e.name === idPrefix);
    if (exact) return exact.name;
    // Prefix match for legacy descriptor dirs: M001-SOMETHING
    const prefixed = entries.find(
      e => e.isDirectory() && e.name.startsWith(idPrefix + "-")
    );
    return prefixed ? prefixed.name : null;
  } catch {
    return null;
  }
}

/**
 * Find a file by ID prefix and suffix within a directory.
 * Checks in order:
 *   1. Direct: ID-SUFFIX.md (e.g. M001-ROADMAP.md, T03-PLAN.md)
 *   2. Legacy descriptor: ID-DESCRIPTOR-SUFFIX.md (e.g. T03-INSTALL-PACKAGES-PLAN.md)
 *   3. Legacy bare: suffix.md (e.g. roadmap.md)
 */
export function resolveFile(dir: string, idPrefix: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  const target = `${idPrefix}-${suffix}.md`.toUpperCase();
  try {
    const entries = cachedReaddir(dir);
    // Direct match: ID-SUFFIX.md
    const direct = entries.find(e => e.toUpperCase() === target);
    if (direct) return direct;
    // Legacy pattern match: ID-DESCRIPTOR-SUFFIX.md
    const pattern = new RegExp(
      `^${idPrefix}-.*-${suffix}\\.md$`, "i"
    );
    const match = entries.find(e => pattern.test(e));
    if (match) return match;
    // Legacy fallback: suffix.md
    const legacy = entries.find(e => e.toLowerCase() === `${suffix.toLowerCase()}.md`);
    if (legacy) return legacy;
    return null;
  } catch {
    return null;
  }
}

/**
 * Find all task files matching a pattern in a tasks directory.
 * Returns sorted file names matching T##-SUFFIX.md or legacy T##-*-SUFFIX.md
 */
export function resolveTaskFiles(tasksDir: string, suffix: string): string[] {
  if (!existsSync(tasksDir)) return [];
  try {
    // Current convention: T01-PLAN.md
    const currentPattern = new RegExp(`^T\\d+-${suffix}\\.md$`, "i");
    // Legacy convention: T01-INSTALL-PACKAGES-PLAN.md
    const legacyPattern = new RegExp(`^T\\d+-.*-${suffix}\\.md$`, "i");
    return cachedReaddir(tasksDir)
      .filter(f => currentPattern.test(f) || legacyPattern.test(f))
      .sort();
  } catch {
    return [];
  }
}

// ─── Full Path Builders ────────────────────────────────────────────────────

export const GSD_ROOT_FILES = {
  PROJECT: "PROJECT.md",
  DECISIONS: "DECISIONS.md",
  QUEUE: "QUEUE.md",
  STATE: "STATE.md",
  REQUIREMENTS: "REQUIREMENTS.md",
} as const;

export type GSDRootFileKey = keyof typeof GSD_ROOT_FILES;

const LEGACY_GSD_ROOT_FILES: Record<GSDRootFileKey, string> = {
  PROJECT: "project.md",
  DECISIONS: "decisions.md",
  QUEUE: "queue.md",
  STATE: "state.md",
  REQUIREMENTS: "requirements.md",
};

export function gsdRoot(basePath: string): string {
  return join(resolveMainWorktreeRoot(basePath), ".gsd");
}

export function milestonesDir(basePath: string): string {
  return join(gsdRoot(basePath), "milestones");
}

export function resolveGsdRootFile(basePath: string, key: GSDRootFileKey): string {
  const root = gsdRoot(basePath);
  const canonical = join(root, GSD_ROOT_FILES[key]);
  if (existsSync(canonical)) return canonical;
  const legacy = join(root, LEGACY_GSD_ROOT_FILES[key]);
  if (existsSync(legacy)) return legacy;
  return canonical;
}

export function relGsdRootFile(key: GSDRootFileKey): string {
  return `.gsd/${GSD_ROOT_FILES[key]}`;
}

/**
 * Resolve the full path to a milestone directory.
 * Returns null if the milestone doesn't exist.
 */
export function resolveMilestonePath(basePath: string, milestoneId: string): string | null {
  const dir = resolveDir(milestonesDir(basePath), milestoneId);
  return dir ? join(milestonesDir(basePath), dir) : null;
}

/**
 * Resolve the full path to a milestone file (e.g. ROADMAP, CONTEXT, RESEARCH).
 */
export function resolveMilestoneFile(
  basePath: string, milestoneId: string, suffix: string
): string | null {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir) return null;
  const file = resolveFile(mDir, milestoneId, suffix);
  return file ? join(mDir, file) : null;
}

/**
 * Resolve the full path to a slice directory within a milestone.
 */
export function resolveSlicePath(
  basePath: string, milestoneId: string, sliceId: string
): string | null {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir) return null;
  const slicesDir = join(mDir, "slices");
  const dir = resolveDir(slicesDir, sliceId);
  return dir ? join(slicesDir, dir) : null;
}

/**
 * Resolve the full path to a slice file (e.g. PLAN, RESEARCH, CONTEXT, SUMMARY).
 */
export function resolveSliceFile(
  basePath: string, milestoneId: string, sliceId: string, suffix: string
): string | null {
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!sDir) return null;
  const file = resolveFile(sDir, sliceId, suffix);
  return file ? join(sDir, file) : null;
}

/**
 * Resolve the tasks directory within a slice.
 */
export function resolveTasksDir(
  basePath: string, milestoneId: string, sliceId: string
): string | null {
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!sDir) return null;
  const tDir = join(sDir, "tasks");
  return existsSync(tDir) ? tDir : null;
}

/**
 * Resolve a specific task file.
 */
export function resolveTaskFile(
  basePath: string, milestoneId: string, sliceId: string,
  taskId: string, suffix: string
): string | null {
  const tDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (!tDir) return null;
  const file = resolveFile(tDir, taskId, suffix);
  return file ? join(tDir, file) : null;
}

// ─── Relative Path Builders (for prompts — .gsd/milestones/...) ────────────

/**
 * Build relative .gsd/ path to a milestone directory.
 * Uses the actual directory name on disk if it exists, otherwise bare ID.
 */
export function relMilestonePath(basePath: string, milestoneId: string): string {
  const dir = resolveDir(milestonesDir(basePath), milestoneId);
  if (dir) return `.gsd/milestones/${dir}`;
  return `.gsd/milestones/${milestoneId}`;
}

/**
 * Build relative .gsd/ path to a milestone file.
 */
export function relMilestoneFile(
  basePath: string, milestoneId: string, suffix: string
): string {
  const mRel = relMilestonePath(basePath, milestoneId);
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (mDir) {
    const file = resolveFile(mDir, milestoneId, suffix);
    if (file) return `${mRel}/${file}`;
  }
  return `${mRel}/${buildMilestoneFileName(milestoneId, suffix)}`;
}

/**
 * Build relative .gsd/ path to a slice directory.
 */
export function relSlicePath(
  basePath: string, milestoneId: string, sliceId: string
): string {
  const mRel = relMilestonePath(basePath, milestoneId);
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (mDir) {
    const slicesDir = join(mDir, "slices");
    const dir = resolveDir(slicesDir, sliceId);
    if (dir) return `${mRel}/slices/${dir}`;
  }
  return `${mRel}/slices/${sliceId}`;
}

/**
 * Build relative .gsd/ path to a slice file.
 */
export function relSliceFile(
  basePath: string, milestoneId: string, sliceId: string, suffix: string
): string {
  const sRel = relSlicePath(basePath, milestoneId, sliceId);
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (sDir) {
    const file = resolveFile(sDir, sliceId, suffix);
    if (file) return `${sRel}/${file}`;
  }
  return `${sRel}/${buildSliceFileName(sliceId, suffix)}`;
}

/**
 * Build relative .gsd/ path to a task file.
 */
export function relTaskFile(
  basePath: string, milestoneId: string, sliceId: string,
  taskId: string, suffix: string
): string {
  const sRel = relSlicePath(basePath, milestoneId, sliceId);
  const tDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (tDir) {
    const file = resolveFile(tDir, taskId, suffix);
    if (file) return `${sRel}/tasks/${file}`;
  }
  return `${sRel}/tasks/${buildTaskFileName(taskId, suffix)}`;
}
