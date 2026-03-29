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
import { join, dirname, normalize } from "node:path";
import { spawnSync } from "node:child_process";
import { nativeScanGsdTree, type GsdTreeEntry } from "./native-parser-bridge.js";
import { DIR_CACHE_MAX } from "./constants.js";

// ─── Directory Listing Cache ──────────────────────────────────────────────────

const dirEntryCache = new Map<string, Dirent[]>();
const dirListCache = new Map<string, string[]>();

// ─── Native Tree Cache ────────────────────────────────────────────────────────
// When the native module is available, scan the entire .gsd/ tree in one call
// and serve directory listings from memory instead of individual readdirSync calls.

let nativeTreeCache: Map<string, GsdTreeEntry[]> | null = null;
let nativeTreeBase: string | null = null;

function getNativeTree(gsdDir: string): Map<string, GsdTreeEntry[]> | null {
  if (nativeTreeCache && nativeTreeBase === gsdDir) return nativeTreeCache;

  const entries = nativeScanGsdTree(gsdDir);
  if (!entries) return null;

  // Build a map of parent directory -> entries
  const tree = new Map<string, GsdTreeEntry[]>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const parentKey = parentPath || '.';
    if (!tree.has(parentKey)) tree.set(parentKey, []);
    tree.get(parentKey)!.push(entry);
  }

  nativeTreeCache = tree;
  nativeTreeBase = gsdDir;
  return tree;
}

/**
 * Convert a native tree lookup into a relative key for the tree map.
 * Returns the relative path from the gsdDir, or null if the path isn't under gsdDir.
 */
function nativeTreeKey(dirPath: string, gsdDir: string): string | null {
  if (!dirPath.startsWith(gsdDir)) return null;
  const rel = dirPath.slice(gsdDir.length).replace(/^\//, '');
  return rel || '.';
}

function cachedReaddirWithTypes(dirPath: string): Dirent[] {
  const cached = dirEntryCache.get(dirPath);
  if (cached) return cached;

  // Try native tree cache for paths under .gsd/
  if (nativeTreeBase) {
    const key = nativeTreeKey(dirPath, nativeTreeBase);
    if (key && nativeTreeCache) {
      const treeEntries = nativeTreeCache.get(key);
      if (treeEntries) {
        // Synthesize Dirent-like objects from native tree entries
        const dirents = treeEntries.map(e => {
          const d = Object.create(Dirent.prototype) as Dirent;
          Object.assign(d, {
            name: e.name,
            parentPath: dirPath,
            path: dirPath,
          });
          // Override the type check methods
          const isDir = e.isDir;
          d.isDirectory = () => isDir;
          d.isFile = () => !isDir;
          d.isSymbolicLink = () => false;
          d.isBlockDevice = () => false;
          d.isCharacterDevice = () => false;
          d.isFIFO = () => false;
          d.isSocket = () => false;
          return d;
        });
        if (dirEntryCache.size >= DIR_CACHE_MAX) dirEntryCache.clear();
        dirEntryCache.set(dirPath, dirents);
        return dirents;
      }
    }
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });
  if (dirEntryCache.size >= DIR_CACHE_MAX) dirEntryCache.clear();
  dirEntryCache.set(dirPath, entries);
  return entries;
}

function cachedReaddir(dirPath: string): string[] {
  const cached = dirListCache.get(dirPath);
  if (cached) return cached;

  // Try native tree cache for paths under .gsd/
  if (nativeTreeBase) {
    const key = nativeTreeKey(dirPath, nativeTreeBase);
    if (key && nativeTreeCache) {
      const treeEntries = nativeTreeCache.get(key);
      if (treeEntries) {
        const names = treeEntries.map(e => e.name);
        if (dirListCache.size >= DIR_CACHE_MAX) dirListCache.clear();
        dirListCache.set(dirPath, names);
        return names;
      }
    }
  }

  const entries = readdirSync(dirPath);
  if (dirListCache.size >= DIR_CACHE_MAX) dirListCache.clear();
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
  nativeTreeCache = null;
  nativeTreeBase = null;
}

// ─── Name Builders ─────────────────────────────────────────────────────────

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

/**
 * Find all task JSON files matching a pattern in a tasks directory.
 * Returns sorted file names matching T##-SUFFIX.json or legacy T##-*-SUFFIX.json
 */
export function resolveTaskJsonFiles(tasksDir: string, suffix: string): string[] {
  if (!existsSync(tasksDir)) return [];
  try {
    const currentPattern = new RegExp(`^T\\d+-${suffix}\\.json$`, "i");
    const legacyPattern = new RegExp(`^T\\d+-.*-${suffix}\\.json$`, "i");
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
  OVERRIDES: "OVERRIDES.md",
  KNOWLEDGE: "KNOWLEDGE.md",
} as const;

export type GSDRootFileKey = keyof typeof GSD_ROOT_FILES;

const LEGACY_GSD_ROOT_FILES: Record<GSDRootFileKey, string> = {
  PROJECT: "project.md",
  DECISIONS: "decisions.md",
  QUEUE: "queue.md",
  STATE: "state.md",
  REQUIREMENTS: "requirements.md",
  OVERRIDES: "overrides.md",
  KNOWLEDGE: "knowledge.md",
};

// ─── GSD Root Discovery ───────────────────────────────────────────────────────

const gsdRootCache = new Map<string, string>();

/** Exported for tests only — do not call in production code. */
export function _clearGsdRootCache(): void {
  gsdRootCache.clear();
}

/**
 * Resolve the `.gsd` directory for a given project base path.
 *
 * Probe order:
 *   1. basePath/.gsd         — fast path (common case)
 *   2. git rev-parse root    — handles cwd-is-a-subdirectory
 *   3. Walk up from basePath — handles moved .gsd in an ancestor (bounded by git root)
 *   4. basePath/.gsd         — creation fallback (init scenario)
 *
 * Result is cached per basePath for the process lifetime.
 */
export function gsdRoot(basePath: string): string {
  const cached = gsdRootCache.get(basePath);
  if (cached) return cached;

  const result = probeGsdRoot(basePath);
  gsdRootCache.set(basePath, result);
  return result;
}

/**
 * Detect if a path is inside a .gsd/worktrees/<name>/ structure.
 *
 * GSD auto-worktrees live at <project>/.gsd/worktrees/<milestoneId>/.
 * When gsdRoot() is called with such a path, we must NOT walk up to the
 * project root's .gsd — each worktree manages its own .gsd state (#2594).
 *
 * Matches both forward-slash and platform-native separators to handle
 * Windows paths (path.sep = '\\') and normalized Unix paths.
 */
function isInsideGsdWorktree(p: string): boolean {
  // Match /.gsd/worktrees/<name> where <name> is the final segment or
  // followed by a separator. The <name> segment must be non-empty.
  const sepFwd = "/";
  const sepNative = "\\";
  const markers = [
    `${sepFwd}.gsd${sepFwd}worktrees${sepFwd}`,
    `${sepNative}.gsd${sepNative}worktrees${sepNative}`,
  ];
  for (const marker of markers) {
    const idx = p.indexOf(marker);
    if (idx === -1) continue;
    // Verify there's a non-empty worktree name after the marker
    const afterMarker = p.slice(idx + marker.length);
    // The name is everything up to the next separator (or end of string)
    const nameEnd = afterMarker.search(/[/\\]/);
    const name = nameEnd === -1 ? afterMarker : afterMarker.slice(0, nameEnd);
    if (name.length > 0) return true;
  }
  return false;
}

function probeGsdRoot(rawBasePath: string): string {
  // 1. Fast path — check the input path directly
  const local = join(rawBasePath, ".gsd");
  if (existsSync(local)) return local;

  // 1b. Worktree guard (#2594) — if basePath is inside a .gsd/worktrees/<name>/
  //     structure, return the worktree-local .gsd path immediately. Without this,
  //     the git-root probe (step 2) or walk-up (step 3) escapes to the project
  //     root's .gsd, causing ensurePreconditions() and deriveState() to read/write
  //     state in the wrong location.
  if (isInsideGsdWorktree(rawBasePath)) return local;

  // Resolve symlinks so path comparisons work correctly across platforms
  // (e.g. macOS /var → /private/var). Use rawBasePath as fallback if not resolvable.
  let basePath: string;
  try { basePath = realpathSync.native(rawBasePath); } catch { basePath = rawBasePath; }

  // Also check the resolved path for the worktree pattern (macOS /tmp → /private/tmp)
  if (basePath !== rawBasePath && isInsideGsdWorktree(basePath)) return local;

  // 2. Git root anchor — used as both probe target and walk-up boundary
  //    Only walk if we're inside a git project — prevents escaping into
  //    unrelated filesystem territory when running outside any repo.
  let gitRoot: string | null = null;
  try {
    const out = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      encoding: "utf-8",
    });
    if (out.status === 0) {
      const r = out.stdout.trim();
      if (r) gitRoot = normalize(r);
    }
  } catch { /* git not available */ }

  if (gitRoot) {
    const candidate = join(gitRoot, ".gsd");
    if (existsSync(candidate)) return candidate;
  }

  // 3. Walk up from basePath to the git root (only if we are in a subdirectory)
  if (gitRoot && basePath !== gitRoot) {
    let cur = dirname(basePath);
    while (cur !== basePath) {
      const candidate = join(cur, ".gsd");
      if (existsSync(candidate)) return candidate;
      if (cur === gitRoot) break;
      basePath = cur;
      cur = dirname(cur);
    }
  }

  // 4. Fallback for init/creation
  return local;
}
export function milestonesDir(basePath: string): string {
  return join(gsdRoot(basePath), "milestones");
}

export function resolveRuntimeFile(basePath: string): string {
  return join(gsdRoot(basePath), "RUNTIME.md");
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
