/**
 * GSD Auto-Worktree -- lifecycle management for auto-mode worktrees.
 *
 * Auto-mode creates worktrees with `milestone/<MID>` branches (distinct from
 * manual `/worktree` which uses `worktree/<name>` branches). This module
 * manages create, enter, detect, and teardown for auto-mode worktrees.
 */

import {
  existsSync,
  cpSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
  lstatSync as lstatSyncFn,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { GSDError, GSD_IO_ERROR, GSD_GIT_ERROR } from "./errors.js";
import {
  copyWorktreeDb,
  reconcileWorktreeDb,
  isDbAvailable,
} from "./gsd-db.js";
import { atomicWriteSync } from "./atomic-write.js";
import { execSync, execFileSync } from "node:child_process";
import { safeCopy, safeCopyRecursive } from "./safe-fs.js";
import { gsdRoot } from "./paths.js";
import {
  createWorktree,
  removeWorktree,
  worktreePath,
} from "./worktree-manager.js";
import {
  detectWorktreeName,
  resolveGitHeadPath,
  nudgeGitBranchCache,
} from "./worktree.js";
import { MergeConflictError, readIntegrationBranch, RUNTIME_EXCLUSION_PATHS } from "./git-service.js";
import { parseRoadmap } from "./files.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  nativeGetCurrentBranch,
  nativeWorkingTreeStatus,
  nativeAddAllWithExclusions,
  nativeCommit,
  nativeCheckoutBranch,
  nativeMergeSquash,
  nativeConflictFiles,
  nativeCheckoutTheirs,
  nativeAddPaths,
  nativeRmForce,
  nativeBranchDelete,
  nativeBranchExists,
} from "./native-git-bridge.js";

// ─── Module State ──────────────────────────────────────────────────────────

/** Original project root before chdir into auto-worktree. */
let originalBase: string | null = null;

function clearProjectRootStateFiles(basePath: string, milestoneId: string): void {
  const gsdDir = gsdRoot(basePath);
  const transientFiles = [
    join(gsdDir, "STATE.md"),
    join(gsdDir, "auto.lock"),
    join(gsdDir, "milestones", milestoneId, `${milestoneId}-META.json`),
  ];

  for (const file of transientFiles) {
    try {
      unlinkSync(file);
    } catch {
      /* non-fatal — file may not exist */
    }
  }
}
// ─── Worktree ↔ Main Repo Sync (#1311) ──────────────────────────────────────

/**
 * Sync .gsd/ state from the main repo into the worktree.
 *
 * When .gsd/ is a symlink to the external state directory, both the main
 * repo and worktree share the same directory — no sync needed.
 *
 * When .gsd/ is a real directory (e.g., git-tracked or manage_gitignore:false),
 * the worktree has its own copy that may be stale. This function copies
 * missing milestones, CONTEXT, ROADMAP, DECISIONS, REQUIREMENTS, and
 * PROJECT files from the main repo's .gsd/ into the worktree's .gsd/.
 *
 * Only adds missing content — never overwrites existing files in the worktree
 * (the worktree's execution state is authoritative for in-progress work).
 */
export function syncGsdStateToWorktree(
  mainBasePath: string,
  worktreePath_: string,
): { synced: string[] } {
  const mainGsd = gsdRoot(mainBasePath);
  const wtGsd = gsdRoot(worktreePath_);
  const synced: string[] = [];

  // If both resolve to the same directory (symlink), no sync needed
  try {
    const mainResolved = realpathSync(mainGsd);
    const wtResolved = realpathSync(wtGsd);
    if (mainResolved === wtResolved) return { synced };
  } catch {
    // Can't resolve — proceed with sync as a safety measure
  }

  if (!existsSync(mainGsd) || !existsSync(wtGsd)) return { synced };

  // Sync root-level .gsd/ files (DECISIONS, REQUIREMENTS, PROJECT, KNOWLEDGE)
  const rootFiles = [
    "DECISIONS.md",
    "REQUIREMENTS.md",
    "PROJECT.md",
    "KNOWLEDGE.md",
    "OVERRIDES.md",
  ];
  for (const f of rootFiles) {
    const src = join(mainGsd, f);
    const dst = join(wtGsd, f);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        cpSync(src, dst);
        synced.push(f);
      } catch {
        /* non-fatal */
      }
    }
  }

  // Sync milestones: copy entire milestone directories that are missing
  const mainMilestonesDir = join(mainGsd, "milestones");
  const wtMilestonesDir = join(wtGsd, "milestones");
  if (existsSync(mainMilestonesDir)) {
    try {
      mkdirSync(wtMilestonesDir, { recursive: true });
      const mainMilestones = readdirSync(mainMilestonesDir, {
        withFileTypes: true,
      })
        .filter((d) => d.isDirectory() && /^M\d{3}/.test(d.name))
        .map((d) => d.name);

      for (const mid of mainMilestones) {
        const srcDir = join(mainMilestonesDir, mid);
        const dstDir = join(wtMilestonesDir, mid);

        if (!existsSync(dstDir)) {
          // Entire milestone missing from worktree — copy it
          try {
            cpSync(srcDir, dstDir, { recursive: true });
            synced.push(`milestones/${mid}/`);
          } catch {
            /* non-fatal */
          }
        } else {
          // Milestone directory exists but may be missing files (stale snapshot).
          // Sync individual top-level milestone files (CONTEXT, ROADMAP, RESEARCH, etc.)
          try {
            const srcFiles = readdirSync(srcDir).filter(
              (f) => f.endsWith(".md") || f.endsWith(".json"),
            );
            for (const f of srcFiles) {
              const srcFile = join(srcDir, f);
              const dstFile = join(dstDir, f);
              if (!existsSync(dstFile)) {
                try {
                  const srcStat = lstatSyncFn(srcFile);
                  if (srcStat.isFile()) {
                    cpSync(srcFile, dstFile);
                    synced.push(`milestones/${mid}/${f}`);
                  }
                } catch {
                  /* non-fatal */
                }
              }
            }

            // Sync slices directory if it exists in main but not in worktree
            const srcSlicesDir = join(srcDir, "slices");
            const dstSlicesDir = join(dstDir, "slices");
            if (existsSync(srcSlicesDir) && !existsSync(dstSlicesDir)) {
              try {
                cpSync(srcSlicesDir, dstSlicesDir, { recursive: true });
                synced.push(`milestones/${mid}/slices/`);
              } catch {
                /* non-fatal */
              }
            } else if (existsSync(srcSlicesDir) && existsSync(dstSlicesDir)) {
              // Both exist — sync missing slice directories
              const srcSlices = readdirSync(srcSlicesDir, {
                withFileTypes: true,
              })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
              for (const sid of srcSlices) {
                const srcSlice = join(srcSlicesDir, sid);
                const dstSlice = join(dstSlicesDir, sid);
                if (!existsSync(dstSlice)) {
                  try {
                    cpSync(srcSlice, dstSlice, { recursive: true });
                    synced.push(`milestones/${mid}/slices/${sid}/`);
                  } catch {
                    /* non-fatal */
                  }
                }
              }
            }
          } catch {
            /* non-fatal */
          }
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  return { synced };
}

/**
 * Sync milestone artifacts from worktree back to the main external state directory.
 * Called before milestone merge to ensure completion artifacts (SUMMARY, VALIDATION,
 * updated ROADMAP) are visible from the project root (#1412).
 *
 * Only syncs .gsd/milestones/ content — root-level files (DECISIONS, REQUIREMENTS, etc.)
 * are handled by the merge itself.
 */
export function syncWorktreeStateBack(
  mainBasePath: string,
  worktreePath: string,
  milestoneId: string,
): { synced: string[] } {
  const mainGsd = gsdRoot(mainBasePath);
  const wtGsd = gsdRoot(worktreePath);
  const synced: string[] = [];

  // If both resolve to the same directory (symlink), no sync needed
  try {
    const mainResolved = realpathSync(mainGsd);
    const wtResolved = realpathSync(wtGsd);
    if (mainResolved === wtResolved) return { synced };
  } catch {
    // Can't resolve — proceed with sync
  }

  const wtMilestoneDir = join(wtGsd, "milestones", milestoneId);
  const mainMilestoneDir = join(mainGsd, "milestones", milestoneId);

  if (!existsSync(wtMilestoneDir)) return { synced };
  mkdirSync(mainMilestoneDir, { recursive: true });

  // Sync milestone-level files (SUMMARY, VALIDATION, ROADMAP, CONTEXT)
  try {
    for (const entry of readdirSync(wtMilestoneDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const src = join(wtMilestoneDir, entry.name);
        const dst = join(mainMilestoneDir, entry.name);
        try {
          cpSync(src, dst, { force: true });
          synced.push(`milestones/${milestoneId}/${entry.name}`);
        } catch {
          /* non-fatal */
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  // Sync slice-level files (summaries, UATs)
  const wtSlicesDir = join(wtMilestoneDir, "slices");
  const mainSlicesDir = join(mainMilestoneDir, "slices");
  if (existsSync(wtSlicesDir)) {
    try {
      for (const sliceEntry of readdirSync(wtSlicesDir, {
        withFileTypes: true,
      })) {
        if (!sliceEntry.isDirectory()) continue;
        const sid = sliceEntry.name;
        const wtSliceDir = join(wtSlicesDir, sid);
        const mainSliceDir = join(mainSlicesDir, sid);
        mkdirSync(mainSliceDir, { recursive: true });

        for (const fileEntry of readdirSync(wtSliceDir, {
          withFileTypes: true,
        })) {
          if (fileEntry.isFile() && fileEntry.name.endsWith(".md")) {
            const src = join(wtSliceDir, fileEntry.name);
            const dst = join(mainSliceDir, fileEntry.name);
            try {
              cpSync(src, dst, { force: true });
              synced.push(
                `milestones/${milestoneId}/slices/${sid}/${fileEntry.name}`,
              );
            } catch {
              /* non-fatal */
            }
          }
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  return { synced };
}
// ─── Worktree Post-Create Hook (#597) ────────────────────────────────────────

/**
 * Run the user-configured post-create hook script after worktree creation.
 * The script receives SOURCE_DIR and WORKTREE_DIR as environment variables.
 * Failure is non-fatal — returns the error message or null on success.
 *
 * Reads the hook path from git.worktree_post_create in preferences.
 * Pass hookPath directly to bypass preference loading (useful for testing).
 */
export function runWorktreePostCreateHook(
  sourceDir: string,
  worktreeDir: string,
  hookPath?: string,
): string | null {
  if (hookPath === undefined) {
    const prefs = loadEffectiveGSDPreferences()?.preferences?.git;
    hookPath = prefs?.worktree_post_create;
  }
  if (!hookPath) return null;

  // Resolve relative paths against the source project root
  const resolved = isAbsolute(hookPath) ? hookPath : join(sourceDir, hookPath);
  if (!existsSync(resolved)) {
    return `Worktree post-create hook not found: ${resolved}`;
  }

  try {
    execSync(resolved, {
      cwd: worktreeDir,
      env: {
        ...process.env,
        SOURCE_DIR: sourceDir,
        WORKTREE_DIR: worktreeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 30_000, // 30 second timeout
    });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Worktree post-create hook failed: ${msg}`;
  }
}

// ─── Auto-Worktree Branch Naming ───────────────────────────────────────────

export function autoWorktreeBranch(milestoneId: string): string {
  return `milestone/${milestoneId}`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a new auto-worktree for a milestone, chdir into it, and store
 * the original base path for later teardown.
 *
 * Atomic: chdir + originalBase update happen in the same try block
 * to prevent split-brain.
 */

/**
 * Forward-merge plan checkbox state from the project root into a freshly
 * re-attached worktree (#778).
 *
 * When auto-mode stops via crash (not graceful stop), the milestone branch
 * HEAD may be behind the filesystem state at the project root because
 * syncStateToProjectRoot() runs after every task completion but the final
 * git commit may not have happened before the crash. On restart the worktree
 * is re-attached to the branch HEAD, which has [ ] for the crashed task,
 * causing verifyExpectedArtifact() to fail and triggering an infinite
 * dispatch/skip loop.
 *
 * Fix: after re-attaching, read every *.md plan file in the milestone
 * directory at the project root and apply any [x] checkbox states that are
 * ahead of the worktree version (forward-only: never downgrade [x] → [ ]).
 *
 * This is safe because syncStateToProjectRoot() is the authoritative source
 * of post-task state at the project root — it writes the same [x] the LLM
 * produced, then the auto-commit follows. If the commit never happened, the
 * filesystem copy is still valid and correct.
 */
function reconcilePlanCheckboxes(
  projectRoot: string,
  wtPath: string,
  milestoneId: string,
): void {
  const srcMilestone = join(projectRoot, ".gsd", "milestones", milestoneId);
  const dstMilestone = join(wtPath, ".gsd", "milestones", milestoneId);
  if (!existsSync(srcMilestone) || !existsSync(dstMilestone)) return;

  // Walk all markdown files in the milestone directory (plans, summaries, etc.)
  function walkMd(dir: string): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walkMd(full));
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          results.push(full);
        }
      }
    } catch {
      /* non-fatal */
    }
    return results;
  }

  for (const srcFile of walkMd(srcMilestone)) {
    const rel = srcFile.slice(srcMilestone.length);
    const dstFile = dstMilestone + rel;
    if (!existsSync(dstFile)) continue; // only reconcile existing files

    let srcContent: string;
    let dstContent: string;
    try {
      srcContent = readFileSync(srcFile, "utf-8");
      dstContent = readFileSync(dstFile, "utf-8");
    } catch {
      continue;
    }

    if (srcContent === dstContent) continue;

    // Extract all checked task IDs from the source (project root)
    // Pattern: - [x] **T<id>: or - [x] **S<id>: (case-insensitive x)
    const checkedRe = /^- \[[xX]\] \*\*([TS]\d+):/gm;
    const srcChecked = new Set<string>();
    for (const m of srcContent.matchAll(checkedRe)) srcChecked.add(m[1]);

    if (srcChecked.size === 0) continue;

    // Forward-apply: replace [ ] → [x] for any IDs that are checked in src
    let updated = dstContent;
    let changed = false;
    for (const id of srcChecked) {
      const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const uncheckedRe = new RegExp(
        `^(- )\\[ \\]( \\*\\*${escapedId}:)`,
        "gm",
      );
      if (uncheckedRe.test(updated)) {
        updated = updated.replace(
          new RegExp(`^(- )\\[ \\]( \\*\\*${escapedId}:)`, "gm"),
          "$1[x]$2",
        );
        changed = true;
      }
    }

    if (changed) {
      try {
        atomicWriteSync(dstFile, updated, "utf-8");
      } catch {
        /* non-fatal */
      }
    }
  }
}

export function createAutoWorktree(
  basePath: string,
  milestoneId: string,
): string {
  const branch = autoWorktreeBranch(milestoneId);

  // Check if the milestone branch already exists — it survives auto-mode
  // stop/pause and contains committed work from prior sessions. If it exists,
  // re-attach the worktree to it WITHOUT resetting. Only create a fresh branch
  // from the integration branch when no prior work exists.
  const branchExists = nativeBranchExists(basePath, branch);

  let info: { name: string; path: string; branch: string; exists: boolean };
  if (branchExists) {
    // Re-attach worktree to the existing milestone branch (preserving commits)
    info = createWorktree(basePath, milestoneId, {
      branch,
      reuseExistingBranch: true,
    });
  } else {
    // Fresh start — create branch from integration branch
    const integrationBranch =
      readIntegrationBranch(basePath, milestoneId) ?? undefined;
    info = createWorktree(basePath, milestoneId, {
      branch,
      startPoint: integrationBranch,
    });
  }

  // Copy .gsd/ planning artifacts from the source repo into the new worktree.
  // Worktrees are fresh git checkouts — untracked files don't carry over.
  // Planning artifacts may be untracked if the project's .gitignore had a
  // blanket .gsd/ rule (pre-v2.14.0). Without this copy, auto-mode loops
  // on plan-slice because the plan file doesn't exist in the worktree.
  //
  // IMPORTANT: Skip when re-attaching to an existing branch (#759).
  // The branch checkout already has committed artifacts with correct state
  // (e.g. [x] for completed slices). Copying from the project root would
  // overwrite them with stale data ([ ] checkboxes) because the root is
  // not always fully synced.
  if (!branchExists) {
    copyPlanningArtifacts(basePath, info.path);
  } else {
    // Re-attaching to an existing branch: forward-merge any plan checkpoint
    // state from the project root into the worktree (#778).
    //
    // If auto-mode stopped via crash, the milestone branch HEAD may lag behind
    // the project root filesystem because syncStateToProjectRoot() ran after
    // task completion but the auto-commit never fired. On restart the worktree
    // is re-created from the branch HEAD (which has [ ] for the crashed task),
    // causing verifyExpectedArtifact() to return false → stale-key eviction →
    // infinite dispatch/skip loop. Reconciling here ensures the worktree sees
    // the same [x] state that syncStateToProjectRoot() wrote to the root.
    reconcilePlanCheckboxes(basePath, info.path, milestoneId);
  }

  // Run user-configured post-create hook (#597) — e.g. copy .env, symlink assets
  const hookError = runWorktreePostCreateHook(basePath, info.path);
  if (hookError) {
    // Non-fatal — log but don't prevent worktree usage
    console.error(`[GSD] ${hookError}`);
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(info.path);
    originalBase = basePath;
  } catch (err) {
    // If chdir fails, the worktree was created but we couldn't enter it.
    // Don't store originalBase -- caller can retry or clean up.
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree created at ${info.path} but chdir failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return info.path;
}

/**
 * Copy .gsd/ planning artifacts from source repo to a new worktree.
 * Copies milestones/, DECISIONS.md, REQUIREMENTS.md, PROJECT.md, QUEUE.md,
 * STATE.md, KNOWLEDGE.md, and OVERRIDES.md.
 * Skips runtime files (auto.lock, metrics.json, etc.) and the worktrees/ dir.
 * Best-effort — failures are non-fatal since auto-mode can recreate artifacts.
 */
function copyPlanningArtifacts(srcBase: string, wtPath: string): void {
  const srcGsd = join(srcBase, ".gsd");
  const dstGsd = join(wtPath, ".gsd");
  if (!existsSync(srcGsd)) return;

  // Copy milestones/ directory (planning files, roadmaps, plans, research)
  safeCopyRecursive(join(srcGsd, "milestones"), join(dstGsd, "milestones"), {
    force: true,
    filter: (src) => !src.endsWith("-META.json"),
  });

  // Copy top-level planning files
  for (const file of [
    "DECISIONS.md",
    "REQUIREMENTS.md",
    "PROJECT.md",
    "QUEUE.md",
    "STATE.md",
    "KNOWLEDGE.md",
    "OVERRIDES.md",
  ]) {
    safeCopy(join(srcGsd, file), join(dstGsd, file), { force: true });
  }

  // Copy gsd.db if present in source
  const srcDb = join(srcGsd, "gsd.db");
  const destDb = join(dstGsd, "gsd.db");
  if (existsSync(srcDb)) {
    try {
      copyWorktreeDb(srcDb, destDb);
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Teardown an auto-worktree: chdir back to original base, then remove
 * the worktree and its branch.
 */
export function teardownAutoWorktree(
  originalBasePath: string,
  milestoneId: string,
  opts: { preserveBranch?: boolean } = {},
): void {
  const branch = autoWorktreeBranch(milestoneId);
  const { preserveBranch = false } = opts;
  const previousCwd = process.cwd();

  try {
    process.chdir(originalBasePath);
    originalBase = null;
  } catch (err) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Failed to chdir back to ${originalBasePath} during teardown: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  removeWorktree(originalBasePath, milestoneId, {
    branch,
    deleteBranch: !preserveBranch,
  });
}

/**
 * Detect if the process is currently inside an auto-worktree.
 * Checks both module state and git branch prefix.
 */
export function isInAutoWorktree(basePath: string): boolean {
  if (!originalBase) return false;
  const cwd = process.cwd();
  const resolvedBase = existsSync(basePath) ? realpathSync(basePath) : basePath;
  const wtDir = join(resolvedBase, ".gsd", "worktrees");
  if (!cwd.startsWith(wtDir)) return false;
  const branch = nativeGetCurrentBranch(cwd);
  return branch.startsWith("milestone/");
}

/**
 * Get the filesystem path for an auto-worktree, or null if it doesn't exist
 * or is not a valid git worktree.
 *
 * Validates that the path is a real git worktree (has a .git file with a
 * gitdir: pointer) rather than just a stray directory. This prevents
 * mis-detection of leftover directories as active worktrees (#695).
 */
export function getAutoWorktreePath(
  basePath: string,
  milestoneId: string,
): string | null {
  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) return null;

  // Validate this is a real git worktree, not a stray directory.
  // A git worktree has a .git *file* (not directory) containing "gitdir: <path>".
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) return null;
  } catch {
    return null;
  }

  return p;
}

/**
 * Enter an existing auto-worktree (chdir into it, store originalBase).
 * Use for resume -- the worktree already exists from a prior create.
 *
 * Atomic: chdir + originalBase update in same try block.
 */
export function enterAutoWorktree(
  basePath: string,
  milestoneId: string,
): string {
  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree for ${milestoneId} does not exist at ${p}`,
    );
  }

  // Validate this is a real git worktree, not a stray directory (#695)
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) {
    throw new GSDError(
      GSD_GIT_ERROR,
      `Auto-worktree path ${p} exists but is not a git worktree (no .git)`,
    );
  }
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) {
      throw new GSDError(
        GSD_GIT_ERROR,
        `Auto-worktree path ${p} has a .git but it is not a worktree gitdir pointer`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("worktree")) throw err;
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree path ${p} exists but .git is unreadable`,
    );
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(p);
    originalBase = basePath;
  } catch (err) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Failed to enter auto-worktree at ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return p;
}

/**
 * Get the original project root stored when entering an auto-worktree.
 * Returns null if not currently in an auto-worktree.
 */
export function getAutoWorktreeOriginalBase(): string | null {
  return originalBase;
}

export function getActiveAutoWorktreeContext(): {
  originalBase: string;
  worktreeName: string;
  branch: string;
} | null {
  if (!originalBase) return null;
  const cwd = process.cwd();
  const resolvedBase = existsSync(originalBase)
    ? realpathSync(originalBase)
    : originalBase;
  const wtDir = join(resolvedBase, ".gsd", "worktrees");
  if (!cwd.startsWith(wtDir)) return null;
  const worktreeName = detectWorktreeName(cwd);
  if (!worktreeName) return null;
  const branch = nativeGetCurrentBranch(cwd);
  if (!branch.startsWith("milestone/")) return null;
  return {
    originalBase,
    worktreeName,
    branch,
  };
}

// ─── Merge Milestone -> Main ───────────────────────────────────────────────

/**
 * Auto-commit any dirty (uncommitted) state in the given directory.
 * Returns true if a commit was made, false if working tree was clean.
 */
function autoCommitDirtyState(cwd: string): boolean {
  try {
    const status = nativeWorkingTreeStatus(cwd);
    if (!status) return false;
    nativeAddAllWithExclusions(cwd, RUNTIME_EXCLUSION_PATHS);
    const result = nativeCommit(
      cwd,
      "chore: auto-commit before milestone merge",
    );
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Squash-merge the milestone branch into main with a rich commit message
 * listing all completed slices, then tear down the worktree.
 *
 * Sequence:
 *  1. Auto-commit dirty worktree state
 *  2. chdir to originalBasePath
 *  3. git checkout main
 *  4. git merge --squash milestone/<MID>
 *  5. git commit with rich message
 *  6. Auto-push if enabled
 *  7. Delete milestone branch
 *  8. Remove worktree directory
 *  9. Clear originalBase
 *
 * On merge conflict: throws MergeConflictError.
 * On "nothing to commit" after squash: handles gracefully (no error).
 */
export function mergeMilestoneToMain(
  originalBasePath_: string,
  milestoneId: string,
  roadmapContent: string,
): { commitMessage: string; pushed: boolean; prCreated: boolean } {
  const worktreeCwd = process.cwd();
  const milestoneBranch = autoWorktreeBranch(milestoneId);

  // 1. Auto-commit dirty state in worktree before leaving
  autoCommitDirtyState(worktreeCwd);

  // Reconcile worktree DB into main DB before leaving worktree context
  if (isDbAvailable()) {
    try {
      const worktreeDbPath = join(worktreeCwd, ".gsd", "gsd.db");
      const mainDbPath = join(originalBasePath_, ".gsd", "gsd.db");
      reconcileWorktreeDb(mainDbPath, worktreeDbPath);
    } catch {
      /* non-fatal */
    }
  }

  // 2. Parse roadmap for slice listing
  const roadmap = parseRoadmap(roadmapContent);
  const completedSlices = roadmap.slices.filter((s) => s.done);

  // 3. chdir to original base
  const previousCwd = process.cwd();
  process.chdir(originalBasePath_);

  // 4. Resolve integration branch — prefer milestone metadata, fall back to preferences / "main"
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const integrationBranch = readIntegrationBranch(
    originalBasePath_,
    milestoneId,
  );
  const mainBranch = integrationBranch ?? prefs.main_branch ?? "main";

  // Remove transient project-root state files before any branch or merge
  // operation. Untracked milestone metadata can otherwise block squash merges.
  clearProjectRootStateFiles(originalBasePath_, milestoneId);

  // 5. Checkout integration branch (skip if already current — avoids git error
  //    when main is already checked out in the project-root worktree, #757)
  const currentBranchAtBase = nativeGetCurrentBranch(originalBasePath_);
  if (currentBranchAtBase !== mainBranch) {
    nativeCheckoutBranch(originalBasePath_, mainBranch);
  }

  // 6. Build rich commit message
  const milestoneTitle =
    roadmap.title.replace(/^M\d+:\s*/, "").trim() || milestoneId;
  const subject = `feat(${milestoneId}): ${milestoneTitle}`;
  let body = "";
  if (completedSlices.length > 0) {
    const sliceLines = completedSlices
      .map((s) => `- ${s.id}: ${s.title}`)
      .join("\n");
    body = `\n\nCompleted slices:\n${sliceLines}\n\nBranch: ${milestoneBranch}`;
  }
  const commitMessage = subject + body;

  // 7. Squash merge — auto-resolve .gsd/ state file conflicts (#530)
  const mergeResult = nativeMergeSquash(originalBasePath_, milestoneBranch);

  if (!mergeResult.success) {
    // Check for conflicts — use merge result first, fall back to nativeConflictFiles
    const conflictedFiles =
      mergeResult.conflicts.length > 0
        ? mergeResult.conflicts
        : nativeConflictFiles(originalBasePath_);

    if (conflictedFiles.length > 0) {
      // Separate .gsd/ state file conflicts from real code conflicts.
      // GSD state files (STATE.md, auto.lock, etc.)
      // diverge between branches during normal operation — always prefer the
      // milestone branch version since it has the latest execution state.
      const gsdConflicts = conflictedFiles.filter((f) => f.startsWith(".gsd/"));
      const codeConflicts = conflictedFiles.filter(
        (f) => !f.startsWith(".gsd/"),
      );

      // Auto-resolve .gsd/ conflicts by accepting the milestone branch version
      if (gsdConflicts.length > 0) {
        for (const gsdFile of gsdConflicts) {
          try {
            nativeCheckoutTheirs(originalBasePath_, [gsdFile]);
            nativeAddPaths(originalBasePath_, [gsdFile]);
          } catch {
            // If checkout --theirs fails, try removing the file from the merge
            // (it's a runtime file that shouldn't be committed anyway)
            nativeRmForce(originalBasePath_, [gsdFile]);
          }
        }
      }

      // If there are still non-.gsd conflicts, escalate
      if (codeConflicts.length > 0) {
        throw new MergeConflictError(
          codeConflicts,
          "squash",
          milestoneBranch,
          mainBranch,
        );
      }
    }
    // No conflicts detected — possibly "already up to date", fall through to commit
  }

  // 8. Commit (handle nothing-to-commit gracefully)
  const commitResult = nativeCommit(originalBasePath_, commitMessage);
  const nothingToCommit = commitResult === null;

  // 9. Auto-push if enabled
  let pushed = false;
  if (prefs.auto_push === true && !nothingToCommit) {
    const remote = prefs.remote ?? "origin";
    try {
      execSync(`git push ${remote} ${mainBranch}`, {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      pushed = true;
    } catch {
      // Push failure is non-fatal
    }
  }

  // 9b. Auto-create PR if enabled (requires push_branches + push succeeded)
  let prCreated = false;
  if (prefs.auto_pr === true && pushed) {
    const remote = prefs.remote ?? "origin";
    const prTarget = prefs.pr_target_branch ?? mainBranch;
    try {
      // Push the milestone branch to remote first
      execSync(`git push ${remote} ${milestoneBranch}`, {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      // Create PR via gh CLI
      execSync(
        `gh pr create --base "${prTarget}" --head "${milestoneBranch}" --title "Milestone ${milestoneId} complete" --body "Auto-created by GSD on milestone completion."`,
        {
          cwd: originalBasePath_,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8",
        },
      );
      prCreated = true;
    } catch {
      // PR creation failure is non-fatal — gh may not be installed or authenticated
    }
  }

  // 10. Remove worktree directory first (must happen before branch deletion)
  try {
    removeWorktree(originalBasePath_, milestoneId, {
      branch: null as unknown as string,
      deleteBranch: false,
    });
  } catch {
    // Best-effort -- worktree dir may already be gone
  }

  // 11. Delete milestone branch (after worktree removal so ref is unlocked)
  try {
    nativeBranchDelete(originalBasePath_, milestoneBranch);
  } catch {
    // Best-effort
  }

  // 12. Clear module state
  originalBase = null;
  nudgeGitBranchCache(previousCwd);

  return { commitMessage, pushed, prCreated };
}
